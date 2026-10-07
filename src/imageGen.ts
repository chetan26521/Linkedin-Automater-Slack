import { config } from "./config.js";
import { generateFromPrompt, parseJsonFromModel } from "./postWriter.js";

const OPENAI_IMAGES_URL = "https://api.openai.com/v1/images/generations";
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
 * The poster formats that consistently perform in a LinkedIn feed. Picking one of these up front
 * — instead of asking for "a professional poster" — is what stops the image model falling back to
 * its default: a dark background, a glowing centred icon, and small text, which reads as generic
 * AI art and gets scrolled past.
 */
const POSTER_FORMATS = {
  statement: "Bold typographic statement: the headline set very large across the upper half, left-aligned, with one simple graphic shape or motif that echoes the idea. Typography is the hero.",
  stat: "Key-number card: one figure from the post set enormous as the focal point, a short label directly under it, and the headline above or below. Like a premium annual-report data page.",
  contrast: "Two-part comparison: the canvas split into two clearly labelled halves (for example what was announced versus what people actually experience), each with a 1 to 4 word label and a simple visual, and the headline across the top.",
  framework: "Simple framework: the headline on top and three numbered steps or pillars below it, each a 1 to 4 word label with a minimal line icon, laid out on a clean grid.",
  misconception: "Myth versus reality: a common belief shown struck through or visibly crossed out, with the reality beneath it given clear visual weight, and the headline above. Each side a 1 to 4 word label.",
  "cause-effect": "Cause and effect: two labelled elements joined by one strong, deliberate connector (a single arrow, line, or chain link) showing that one leads to the other, with the headline above.",
  timeline: "Timeline: three labelled points along one clean horizontal or vertical line showing how something has moved or will move, with the headline above. Each label 1 to 4 words.",
  editorial: "Editorial illustration: a conceptual flat illustration in premium business-magazine style filling about 60% of the canvas, with the headline in a clean band of solid colour above or below it.",
} as const;

type PosterFormat = keyof typeof POSTER_FORMATS;

// Restrained palettes the art director picks from, so posters look deliberate and varied across
// a feed without drifting into neon. POSTER_BRAND_COLORS overrides all of them.
const PALETTES = {
  paper: "warm off-white background (#F6F3EE), near-black text (#141414), one vivid accent (#FF5A1F)",
  navy: "deep navy background (#0E1A2B), white text, one warm accent (#F5B700)",
  clean: "pure white background, dark blue-black text (#0A2540), one bright accent (#2F6BFF)",
  forest: "deep green background (#0F2E24), cream text (#F4EFE3), one soft accent (#9FE2BF)",
} as const;

type Palette = keyof typeof PALETTES;

/**
 * Art direction for one poster. Generated as its own step rather than handing the whole post
 * to the image model, because image models given a wall of prose either try to render all of
 * it or pick an arbitrary fragment — deciding every word on the poster in text first is what
 * makes it come out with one clear, correctly spelled message.
 */
interface ArtBrief {
  /** The one idea a viewer should grasp within two seconds — everything else on the poster serves it. */
  coreIdea: string;
  format: PosterFormat;
  palette: Palette;
  headline: string;
  subhead: string;
  /** Every other word allowed on the poster: the stat and its label, comparison labels, or step labels. */
  labels: string[];
  visual: string;
  altText: string;
}

export function assertImageGenConfigured(): void {
  if (config.imageProvider === "gemini") {
    if (!config.geminiApiKey) {
      throw new Error(
        "Poster generation needs GEMINI_API_KEY (a Gemini API key from https://aistudio.google.com/apikey) when IMAGE_PROVIDER=gemini. Set it, or set POST_IMAGES=off to publish text-only posts."
      );
    }
    return;
  }
  if (!config.openaiApiKey) {
    throw new Error(
      "Poster generation needs OPENAI_API_KEY (an OpenAI API key from https://platform.openai.com/api-keys). Set it, or set POST_IMAGES=off to publish text-only posts."
    );
  }
}

async function buildArtBrief(postText: string, topic: string): Promise<ArtBrief> {
  const prompt = `You are the art director for a LinkedIn post that will be read by senior industry professionals. Design the single poster graphic that goes with it. Its job is to stop someone scrolling and make the post's main point instantly clear, even at thumbnail size on a phone.

The post:
"""
${postText}
"""

Topic: "${topic}"

Start with the core idea. The graphic must not summarize the post, turn it into an infographic, or
copy its sentences. It communicates ONE idea: the most surprising, useful, contested, or memorable
insight in the post, the one a viewer should understand within two seconds even if they never read
the post. Decide that first, then design everything around it.

Pick the format that best fits that idea:
${Object.entries(POSTER_FORMATS).map(([key, description]) => `- "${key}": ${description}`).join("\n")}
Only pick a format the post genuinely supports: "stat" needs a striking number in the post, "contrast" and "misconception" need two things the post really sets against each other, "cause-effect" needs a causal link the post actually makes, and "timeline" needs a sequence the post describes.

Pick the palette that fits the topic's mood:
${Object.entries(PALETTES).map(([key, description]) => `- "${key}": ${description}`).join("\n")}

Produce these fields:
- "coreIdea": the one idea, in a single plain sentence.
- "format": one of the format keys above.
- "palette": one of the palette keys above.
- "headline": the poster's main line, 3 to 7 words, a sharp take on the post's central claim that makes sense on its own. Not a label or a topic name ("AI Agents Update" is a label; "Agents now need your passwords" is a headline). No trailing period, no quotation marks, no emoji, no hashtags.
- "subhead": one supporting line of at most 9 words, or "" if the headline stands on its own.
- "labels": the other words the chosen format needs, and nothing else. For "stat": [the number exactly as in the post, a label of at most 5 words]. For "contrast", "misconception", and "cause-effect": [first label, second label], 1 to 4 words each. For "framework" and "timeline": three labels of 1 to 4 words each. For "statement" and "editorial": []. Only include labels the visual genuinely needs.
- "visual": two or three sentences of concrete art direction: the specific visual metaphor or composition that makes the core idea obvious at a glance (be inventive and specific to this post, not a generic phone, brain, globe, or circuit), and how it is composed with the text. Every graphic element must carry meaning; nothing purely decorative.
- "altText": a plain description of the finished graphic for screen readers, at most ${MAX_ALT_TEXT_CHARS} characters, written as a complete sentence.

Hard rules:
- Use a number, statistic, date, or proper noun ONLY if it appears in the post above. Never invent a figure — this audience will check.
- Product or company names only if they appear in the post.
- Sober and credible: no hype words ("revolutionary", "game-changer", "unlock"), no exclamation marks.
- Keep the total words across headline, subhead, and labels under 22. Fewer words looks more confident.

Output format — read carefully:
- Respond with ONLY a JSON object, nothing else. No preamble, no markdown fences.
- Shape: {"coreIdea": "...", "format": "...", "palette": "...", "headline": "...", "subhead": "...", "labels": ["..."], "visual": "...", "altText": "..."}`;

  const brief = parseJsonFromModel<Partial<ArtBrief>>(await generateFromPrompt(prompt), "the poster art brief");

  if (typeof brief.headline !== "string" || !brief.headline.trim()) {
    throw new Error(`Poster art brief came back without a headline: ${JSON.stringify(brief).slice(0, 200)}`);
  }
  if (typeof brief.visual !== "string" || !brief.visual.trim()) {
    throw new Error(`Poster art brief came back without art direction: ${JSON.stringify(brief).slice(0, 200)}`);
  }

  return {
    // Optional for the same reason as altText below: the headline already carries the idea.
    coreIdea: typeof brief.coreIdea === "string" && brief.coreIdea.trim() ? brief.coreIdea.trim() : brief.headline.trim(),
    // Unknown values fall back to the safest format and palette rather than failing the poster.
    format: brief.format && brief.format in POSTER_FORMATS ? brief.format : "statement",
    palette: brief.palette && brief.palette in PALETTES ? brief.palette : "paper",
    headline: brief.headline.trim(),
    subhead: typeof brief.subhead === "string" ? brief.subhead.trim() : "",
    labels: Array.isArray(brief.labels) ? brief.labels.filter((l): l is string => typeof l === "string" && !!l.trim()).map((l) => l.trim()).slice(0, 3) : [],
    visual: brief.visual.trim(),
    // Alt text is the one field a weaker model can plausibly omit without the poster being
    // unusable, so fall back to the headline rather than failing the whole generation.
    altText: (typeof brief.altText === "string" && brief.altText.trim() ? brief.altText.trim() : brief.headline.trim()).slice(0, MAX_ALT_TEXT_CHARS),
  };
}

function allowedText(brief: ArtBrief): string[] {
  return [brief.headline, brief.subhead, ...brief.labels].filter(Boolean);
}

// The negative constraints below are doing most of the work here: left to their own devices,
// image models fill professional-looking layouts with plausible body copy, invented chart
// numbers, fake logos, and stock-photo handshakes — all of which read as obviously fake to
// exactly the audience these posts are aimed at.
function composeImagePrompt(brief: ArtBrief, fixes: string[] = []): string {
  const palette = config.posterBrandColors
    ? `Use exactly these brand colours and nothing louder: ${config.posterBrandColors}. The first is the background, the second the text, any others accents.`
    : `Palette: ${PALETTES[brief.palette]}. Use these colours only, plus tints of them.`;

  return `Design a premium, professional social media graphic for a LinkedIn post. It must look like the work of a top-tier editorial design studio: think business magazine cover, not social media template. It should feel intelligent, confident, minimal, and instantly understandable.

THE ONE IDEA IT MUST COMMUNICATE: ${brief.coreIdea}
A viewer who never reads the post should still get this idea from the graphic within two seconds.

FORMAT: ${POSTER_FORMATS[brief.format]}

TEXT. Render exactly these words, spelled exactly as written, and no other words anywhere in the image:
HEADLINE: "${brief.headline}"${brief.subhead ? `\nSUBHEAD: "${brief.subhead}"` : ""}${brief.labels.length ? `\nLABELS: ${brief.labels.map((l) => `"${l}"`).join(", ")}` : ""}

ART DIRECTION: ${brief.visual}

COLOUR: ${palette}

DESIGN REQUIREMENTS:
- Typography: a modern geometric or grotesk sans-serif, heavy weight for the headline, set large (the headline should be clearly readable when the whole image is shrunk to a 300-pixel-wide thumbnail). Tight but even letter spacing, strong hierarchy: headline, then subhead, then labels much smaller.
- Layout: a clear grid with generous margins (at least 7% of the width on every side) and plenty of negative space. Every word sits well inside the frame and is never clipped.
- Graphics: flat vector, bold simple shapes, clean geometry, editorial composition. Graphics support the idea rather than decorate it. Subtle paper grain only if it adds to the premium feel. Gradients only if extremely subtle. Few elements, each one deliberate, no clutter.
- No text other than the words above: no captions, explanations, tiny labels, axis text, body copy, source names, article titles, dates, hashtags, placeholder or lorem ipsum text, invented numbers, watermarks, signatures, page numbers, URLs, usernames, or handles.
- No logos or brand marks. No recognisable real person and no photorealistic human faces.
- It must NOT look like a Canva template, a stock social media graphic, an infographic, a presentation slide, a motivational quote card, or a technology advertisement.
- Avoid AI-art cliches: no glowing neon, lens flares, holograms, robots or robot heads, glowing brains, circuit boards, floating app icons, generic phones or laptops, decorative UI screens, fake dashboards, fake charts, 3D corporate objects, arrows everywhere, unnecessary icons, clip-art, emoji, cartoon characters, handshakes, or stock-photo business people.
- The design fills the whole image edge to edge. No border, frame, drop shadow, or mockup of a poster on a wall.${fixes.length ? `\n\nA previous attempt had these problems. Make sure this one does not:\n${fixes.map((f) => `- ${f}`).join("\n")}` : ""}`;
}

// gpt-image-1 only takes discrete sizes, not an arbitrary aspect ratio — map the
// configured ratio to the closest of the three, falling back to "auto" for anything
// that isn't clearly square, landscape, or portrait.
function toOpenAiImageSize(aspectRatio: string): "1024x1024" | "1536x1024" | "1024x1536" | "auto" {
  const match = aspectRatio.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
  if (!match) return "auto";
  const ratio = Number(match[1]) / Number(match[2]);
  if (Math.abs(ratio - 1) < 0.05) return "1024x1024";
  return ratio > 1 ? "1536x1024" : "1024x1536";
}

async function callOpenAiImage(prompt: string): Promise<{ bytes: Buffer; mimeType: string }> {
  const response = await fetch(OPENAI_IMAGES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.openaiImageModel,
      prompt,
      size: toOpenAiImageSize(config.postImageAspectRatio),
      quality: "high",
      output_format: "png",
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI image API failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { data?: { b64_json?: string }[] };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) {
    throw new Error(`OpenAI returned no image: ${JSON.stringify(json).slice(0, 300)}`);
  }

  return { bytes: Buffer.from(b64, "base64"), mimeType: "image/png" };
}

function requestGeminiImage(model: string, body: string): Promise<Response> {
  return fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
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

async function callGeminiImageWithModel(model: string, prompt: string): Promise<{ bytes: Buffer; mimeType: string }> {
  // Most to least specific: the Pro image models take an output resolution, older ones only an
  // aspect ratio, and the oldest reject imageConfig outright (a 400, not an ignored field). Step
  // down on each rejection so a GEMINI_IMAGE_MODEL override can't hard-fail on one knob.
  const imageConfigs: (Record<string, string> | undefined)[] = [
    { aspectRatio: config.postImageAspectRatio, imageSize: "2K" },
    { aspectRatio: config.postImageAspectRatio },
    undefined,
  ];

  let response: Response | undefined;
  for (const imageConfig of imageConfigs) {
    response = await requestGeminiImage(
      model,
      JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        ...(imageConfig ? { generationConfig: { imageConfig } } : {}),
      })
    );
    if (response.status !== 400) break;
    const detail = await response.text();
    if (!/image_?config|image_?size|aspect/i.test(detail)) {
      throw new Error(`Gemini image API failed: 400 ${detail}`);
    }
    console.warn(`Gemini image model ${model} rejected an image setting, retrying with fewer: ${detail.slice(0, 300)}`);
  }

  if (!response || !response.ok) {
    throw new GeminiHttpError(response?.status ?? 0, response ? await response.text() : "no response");
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

class GeminiHttpError extends Error {
  constructor(readonly status: number, detail: string) {
    super(`Gemini image API failed: ${status} ${detail}`);
  }
}

// The Pro image model is paid-only and not enabled on every key, so a key that can't use it
// (not found, no permission, or no quota) still gets a poster from the fallback model instead
// of an error.
async function callGeminiImage(prompt: string): Promise<{ bytes: Buffer; mimeType: string }> {
  try {
    return await callGeminiImageWithModel(config.geminiImageModel, prompt);
  } catch (err) {
    const fallback = config.geminiImageFallbackModel;
    if (!(err instanceof GeminiHttpError) || ![403, 404, 429].includes(err.status) || !fallback || fallback === config.geminiImageModel) throw err;
    console.warn(`Gemini image model ${config.geminiImageModel} unavailable (${err.status}), falling back to ${fallback}`);
    return callGeminiImageWithModel(fallback, prompt);
  }
}

function generateImage(prompt: string): Promise<{ bytes: Buffer; mimeType: string }> {
  return config.imageProvider === "gemini" ? callGeminiImage(prompt) : callOpenAiImage(prompt);
}

/**
 * Has Claude look at the finished poster the way an editor would before it goes anywhere near
 * LinkedIn. Image models still sometimes misspell a word, sneak in gibberish text, or fall back to
 * a cheap-looking layout, and the brief can't prevent that — only looking at the result can.
 * Returns the problems found (empty means it passed). Only runs when Claude is the text model;
 * any failure of the review itself passes the poster rather than blocking it.
 */
async function reviewPoster(image: { bytes: Buffer; mimeType: string }, brief: ArtBrief, postText: string): Promise<string[]> {
  if (config.llmProvider !== "anthropic") return [];

  const prompt = `You are the final quality check for a poster that is about to be published on LinkedIn by a senior professional, alongside this post:
"""
${postText}
"""

Look at the poster critically.

The only text allowed on it, spelled exactly like this:
${allowedText(brief).map((t) => `- "${t}"`).join("\n")}

Fail it for any of these:
- Any allowed text is misspelled, has wrong or missing letters, is cut off, or is hard to read.
- Any other text, letters, numbers, or gibberish appear anywhere.
- The headline would not be readable as a small thumbnail.
- It looks cheap, cluttered, distorted, or like generic AI art (glowing neon, floating icons, warped shapes) rather than professional design.
- Any logo, watermark, or realistic human face.
- The visual doesn't fit the post: a reader who sees the poster and then reads the post would find them unrelated, or the image suggests something the post doesn't say.
- Someone who never reads the post would not get this idea from the poster within two seconds: "${brief.coreIdea}"
- It looks like a Canva template, stock social graphic, infographic, presentation slide, motivational quote card, or tech advert rather than a premium editorial graphic.

Respond with ONLY a JSON object: {"pass": true or false, "problems": ["each specific problem, phrased as an instruction for the designer"]}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: config.anthropicModel,
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.mimeType, data: image.bytes.toString("base64") } },
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
    });
    if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);

    const json = (await response.json()) as { content?: { type: string; text?: string }[] };
    const raw = json.content?.find((b) => b.type === "text")?.text ?? "";
    const verdict = parseJsonFromModel<{ pass?: boolean; problems?: string[] }>(raw, "the poster review");
    return verdict.pass === false ? (verdict.problems?.length ? verdict.problems : ["The poster did not meet the quality bar."]) : [];
  } catch (err) {
    console.warn("Poster review failed, accepting the poster unreviewed:", err);
    return [];
  }
}

// One redo is the most the function's time budget comfortably allows on top of drafting the post.
const MAX_POSTER_ATTEMPTS = 2;

/**
 * Generates a poster graphic for a finished post: an art brief, then the image, then a visual
 * quality review with one redo that names the exact problems the reviewer found.
 */
export async function generatePostImage(postText: string, topic: string): Promise<PostImage> {
  assertImageGenConfigured();
  const brief = await buildArtBrief(postText, topic);

  let image = await generateImage(composeImagePrompt(brief));
  for (let attempt = 1; attempt < MAX_POSTER_ATTEMPTS; attempt++) {
    const problems = await reviewPoster(image, brief, postText);
    if (problems.length === 0) break;
    console.warn(`Poster attempt ${attempt} failed review: ${problems.join("; ")}`);
    image = await generateImage(composeImagePrompt(brief, problems));
  }

  return { ...image, altText: brief.altText, headline: brief.headline };
}
