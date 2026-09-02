import { config } from "./config.js";
import { generateFromPrompt, parseJsonFromModel } from "./postWriter.js";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// LinkedIn accepts far longer alt text than this, but screen readers read it out in full
// and it's meant to describe a poster, not narrate it.
const MAX_ALT_TEXT_CHARS = 200;

export interface PostImage {
  bytes: Buffer;
  mimeType: string;
  /** Description attached to the LinkedIn image for screen readers. */
  altText: string;
  /** The line rendered on the poster, kept for the Slack preview caption. */
  headline: string;
}

/**
 * Art direction for one poster. Generated as its own step rather than handing the whole post
 * to the image model, because image models given a wall of prose either try to render all of
 * it or pick an arbitrary fragment — deciding the headline in text first is what makes the
 * poster come out with one clear, correctly spelled message.
 */
interface ArtBrief {
  headline: string;
  subhead: string;
  visual: string;
  altText: string;
}

export function assertImageGenConfigured(): void {
  if (!config.geminiApiKey) {
    throw new Error(
      "Poster generation needs GEMINI_API_KEY (a Gemini API key from https://aistudio.google.com/apikey). Set it, or set POST_IMAGES=off to publish text-only posts."
    );
  }
}

async function buildArtBrief(postText: string, topic: string): Promise<ArtBrief> {
  const prompt = `You are the art director for a LinkedIn post that will be read by senior industry and government officials. Write the brief for a single poster graphic to accompany it.

The post:
"""
${postText}
"""

Topic: "${topic}"

Produce these fields:
- "headline": the poster's main line, 3 to 8 words, drawn from the post's actual central claim. No trailing period, no quotation marks, no emoji, no hashtags.
- "subhead": one supporting line of at most 10 words, or "" if the headline stands on its own. Same restrictions.
- "visual": one or two sentences of art direction — the concrete subject or visual metaphor, the composition, and the colour palette. Describe an abstract, geometric, or diagrammatic visual rather than people or photography.
- "altText": a plain description of the finished graphic for screen readers, at most ${MAX_ALT_TEXT_CHARS} characters, written as a complete sentence.

Hard rules:
- Use a number, statistic, date, or proper noun in "headline" or "subhead" ONLY if it appears in the post above. Never invent a figure — this is going in front of an audience that will check.
- No company, product, or brand names unless they appear in the post.
- Keep it sober and credible: no hype words ("revolutionary", "game-changer", "unlock"), no exclamation marks.

Output format — read carefully:
- Respond with ONLY a JSON object, nothing else. No preamble, no markdown fences.
- Shape: {"headline": "...", "subhead": "...", "visual": "...", "altText": "..."}`;

  const brief = parseJsonFromModel<Partial<ArtBrief>>(await generateFromPrompt(prompt), "the poster art brief");

  if (typeof brief.headline !== "string" || !brief.headline.trim()) {
    throw new Error(`Poster art brief came back without a headline: ${JSON.stringify(brief).slice(0, 200)}`);
  }
  if (typeof brief.visual !== "string" || !brief.visual.trim()) {
    throw new Error(`Poster art brief came back without art direction: ${JSON.stringify(brief).slice(0, 200)}`);
  }

  return {
    headline: brief.headline.trim(),
    subhead: typeof brief.subhead === "string" ? brief.subhead.trim() : "",
    visual: brief.visual.trim(),
    // Alt text is the one field a weaker model can plausibly omit without the poster being
    // unusable, so fall back to the headline rather than failing the whole generation.
    altText: (typeof brief.altText === "string" && brief.altText.trim() ? brief.altText.trim() : brief.headline.trim()).slice(0, MAX_ALT_TEXT_CHARS),
  };
}

// The negative constraints below are doing most of the work here: left to their own devices,
// image models fill professional-looking layouts with plausible body copy, invented chart
// numbers, fake logos, and stock-photo handshakes — all of which read as obviously fake to
// exactly the audience these posts are aimed at.
function composeImagePrompt(brief: ArtBrief): string {
  return `A single professional poster graphic for a LinkedIn feed, aimed at an audience of senior industry and government officials.

Render exactly this text, spelled exactly as written, and no other words:
HEADLINE: "${brief.headline}"${brief.subhead ? `\nSUBHEAD: "${brief.subhead}"` : ""}

Art direction: ${brief.visual}

Design requirements:
- Editorial, corporate-professional design language: clean geometric layout, clear typographic hierarchy, generous whitespace, a restrained palette of two or three colours plus neutrals.
- The headline is the dominant element and must stay perfectly legible at thumbnail size on a phone: crisp, evenly spaced, modern sans-serif type, well inside the frame and never clipped at an edge.
- Flat vector, subtle gradient, isometric, or abstract diagrammatic illustration.
- Render NO text other than the headline and subhead above: no captions, labels, axis text, body copy, placeholder or lorem-ipsum text, invented statistics, watermarks, signatures, page numbers, or URLs.
- No logos or brand marks. No recognisable real person and no photorealistic human faces.
- No stock-photo cliches: no handshakes, no boardroom photography, no people pointing at charts, no glowing blue circuit boards or "digital brain" backgrounds.
- The design bleeds to the edges of the image. No outer border, frame, drop shadow, or mockup of a printed poster on a wall — the image itself IS the poster.`;
}

function requestImage(body: string): Promise<Response> {
  return fetch(`${GEMINI_API_BASE}/${config.geminiImageModel}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": config.geminiApiKey,
      "Content-Type": "application/json",
    },
    body,
  });
}

interface GeminiImagePart {
  text?: string;
  inlineData?: { mimeType?: string; data?: string };
}

async function callGeminiImage(prompt: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const buildBody = (withImageConfig: boolean) =>
    JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      ...(withImageConfig ? { generationConfig: { imageConfig: { aspectRatio: config.postImageAspectRatio } } } : {}),
    });

  let response = await requestImage(buildBody(true));

  // generationConfig.imageConfig is only understood by the newer image models; the ones that
  // don't know it reject the whole request with a 400 rather than ignoring the field. Retry
  // without it so a GEMINI_IMAGE_MODEL override can't hard-fail on one unsupported knob —
  // the poster just comes out in that model's default aspect ratio instead.
  if (response.status === 400) {
    const detail = await response.text();
    if (!/imageconfig|aspect/i.test(detail)) {
      throw new Error(`Gemini image API failed: 400 ${detail}`);
    }
    console.warn(`Gemini image model rejected imageConfig, retrying without it: ${detail.slice(0, 300)}`);
    response = await requestImage(buildBody(false));
  }

  if (!response.ok) {
    throw new Error(`Gemini image API failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as {
    candidates?: { content?: { parts?: GeminiImagePart[] }; finishReason?: string }[];
    promptFeedback?: { blockReason?: string };
  };

  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini declined to generate the poster (${json.promptFeedback.blockReason}).`);
  }

  const candidate = json.candidates?.[0];
  const parts = candidate?.content?.parts ?? [];
  const image = parts.find((p) => p.inlineData?.data)?.inlineData;

  if (!image?.data) {
    // Image models answer a refusal, or a prompt they misread as a text question, with a
    // text part instead of an image — surface that text, it's usually the real explanation.
    const explanation = parts.map((p) => p.text ?? "").join(" ").trim();
    throw new Error(
      `Gemini returned no image (finish reason: ${candidate?.finishReason ?? "unknown"})${explanation ? `: ${explanation.slice(0, 300)}` : "."}`
    );
  }

  return { bytes: Buffer.from(image.data, "base64"), mimeType: image.mimeType ?? "image/png" };
}

/** Generates a poster graphic for a finished post. Two model calls: art brief, then image. */
export async function generatePostImage(postText: string, topic: string): Promise<PostImage> {
  assertImageGenConfigured();
  const brief = await buildArtBrief(postText, topic);
  const { bytes, mimeType } = await callGeminiImage(composeImagePrompt(brief));
  return { bytes, mimeType, altText: brief.altText, headline: brief.headline };
}
