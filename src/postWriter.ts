import { config } from "./config.js";
import { researchTopic, type ResearchResult } from "./research.js";
import { HUMAN_WRITING_GUIDE } from "./writingGuide.js";

export interface GeneratedPost {
  postText: string;
  // Web search citations actually used while researching the post — only ever populated for
  // the providers with a server-side search tool wired up here (anthropic, gemini). The prompt
  // instructs the model to always search at least once, but this can still come back empty if
  // the model's own tool call turned up nothing citable, or for providers with no search tool.
  sources: { url: string; title: string }[];
}

export type ContentStyle = "thought-leadership" | "industry-insight" | "case-study" | "announcement";

export const CONTENT_STYLES: { style: ContentStyle; label: string; instruction: string }[] = [
  { style: "thought-leadership", label: "💡 Thought Leadership", instruction: "Write as a thought-leadership piece: share a clear point of view or original perspective on the topic, positioning the author as someone worth listening to in this space." },
  { style: "industry-insight", label: "📊 Industry Insight", instruction: "Write as an industry insight or analysis: surface a notable trend, pattern, or data point in the space and explain what it actually means for people working in it." },
  { style: "case-study", label: "🎯 Case Study", instruction: "Write as a case study or concrete example: walk through a specific real-world scenario, result, or lesson learned, grounded in specifics rather than generalities." },
  { style: "announcement", label: "📢 Announcement", instruction: "Write as an announcement or update: clearly state what's new or changed and why it matters to the audience, without overselling it." },
];

export type RefinementStyle = "concise" | "formal" | "data-driven" | "different-angle";

export const REFINEMENT_STYLES: { style: RefinementStyle; label: string; instruction: string }[] = [
  { style: "concise", label: "📐 More Concise", instruction: "Make it noticeably shorter and more concise while keeping the core message." },
  { style: "formal", label: "🎩 More Formal", instruction: "Make the tone more formal and polished — precise language, no slang or casual asides, reads like it was written by a senior professional." },
  { style: "data-driven", label: "📊 More Data-Driven", instruction: "Strengthen the post with more concrete specifics — data points, examples, or evidence — rather than general claims." },
  { style: "different-angle", label: "🔀 Different Angle", instruction: "Take a completely different angle or structure than the previous draft, while staying on the same topic." },
];

export interface Refinement {
  style: RefinementStyle;
  previousText: string;
}

// Shared by every prompt that produces or touches final post text (initial draft, refinement,
// published-post edits, and the humanize pass below), so each rule only needs to be stated once
// and the humanizer checks the exact same list it was asked to avoid in the first place.
//
// This list targets what AI-detection tools (GPTZero, Originality.ai, Copyleaks, etc.) actually
// score, not just "sounds robotic" vibes: low perplexity/burstiness (uniform sentence length,
// predictable next-word choices) and a closed set of tokens/constructions that are wildly
// over-represented in LLM output relative to human writing. Killing vocabulary alone is not
// enough — the rhythm and structure rules matter at least as much, which is why humanizePost
// below exists as a dedicated second pass instead of trusting one shot to hold all of this.
// Also consumed by scripts/check-ai-detection.ts for a free, offline pre-check that flags
// obvious misses before spending a detector-API credit on them.
export const AI_TELL_PHRASES = [
  "leverage", "seamless", "seamlessly", "robust", "delve", "dive into", "unlock", "unleash",
  "elevate", "empower", "harness", "navigate", "landscape", "realm", "tapestry", "ever-evolving",
  "fast-paced world", "paradigm shift", "game changer", "game-changer", "cutting edge",
  "cutting-edge", "innovative solutions", "holistic", "synergy", "synergies", "best-in-class",
  "disruptive", "revolutionize", "unprecedented", "at the end of the day", "it's important to note",
  "in today's world", "when it comes to", "in conclusion", "in summary", "arguably", "notably",
  "ultimately", "at its core", "that said", "the truth is", "here's the thing",
  "crucial", "pivotal", "foster", "transformative", "testament", "showcase", "resonate", "embark",
  "journey", "streamline", "intricate", "multifaceted", "plethora", "myriad", "underscore",
  "in an era", "in the world of", "let's dive", "deep dive", "game-changing", "moving forward",
  "key takeaway", "key takeaways", "thrilled to", "excited to share", "humbled", "let that sink in",
  "buckle up", "spoiler alert", "the result?", "here's why", "here's what", "not only", "a reminder that",
  "the real shift", "this changes everything", "the future is here", "new possibilities",
  "the question is no longer", "this is just the beginning", "the future of work",
  "if you're in this space", "if you are in this space", "rapidly evolving",
];

// Lines LinkedIn readers now recognize as AI-written engagement bait when they close a post.
const ENGAGEMENT_BAIT_PATTERN = /(what do you think\??|thoughts\?|agree\?|drop (a|your) (comment|thoughts)|let me know in the comments|share your thoughts|👇)\s*(#\S+\s*)*$/i;
const CONTRAST_TEMPLATE_PATTERN = /\b(isn'?t|is not|it'?s not|not) (just |only |merely )?(about )?[^.!?\n]{1,60}[.,;]\s*(it'?s|it is) (about )?/i;
const LEADING_TRANSITION_PATTERN = /(^|[.!?]\s+|\n\s*)(Moreover|Furthermore|Additionally|However|Consequently|Ultimately|Importantly|Notably|Interestingly),\s+/g;

function phraseRegex(phrase: string): RegExp {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Word boundaries only where the phrase starts/ends with a word character, so "the result?"
  // still matches. Common inflections are allowed ("streamline" also catches "streamlines",
  // "leveraged", "fostering") without partial hits inside unrelated words.
  const start = /^\w/.test(phrase) ? "\\b" : "";
  const end = /\w$/.test(phrase) ? "(?:s|es|d|ed|ing)?\\b" : "";
  return new RegExp(`${start}${escaped}${end}`, "i");
}

/**
 * Concrete AI tells still present in a finished post, as human-readable descriptions the model
 * can act on. Deliberately limited to things that can be checked mechanically — the rewrite
 * prompt already covers the fuzzier stuff — so an empty result is a meaningful signal. Also used
 * by scripts/check-ai-detection.ts.
 */
export function findAiTells(text: string): string[] {
  const issues: string[] = [];

  const hitPhrases = AI_TELL_PHRASES.filter((p) => phraseRegex(p).test(text));
  if (hitPhrases.length) issues.push(`Uses stock AI phrasing: ${hitPhrases.map((p) => `"${p}"`).join(", ")}. Replace each with plain, specific wording.`);

  if (CONTRAST_TEMPLATE_PATTERN.test(text)) issues.push(`Uses the "it's not X, it's Y" contrast template. Say the point directly instead.`);
  if (new RegExp(LEADING_TRANSITION_PATTERN.source).test(text)) issues.push("Starts a sentence with a stock transition word (Moreover, Furthermore, However...). Cut it or rephrase.");
  if (/[—–]/.test(text)) issues.push("Contains em or en dashes. Use a full stop or comma instead.");
  if (ENGAGEMENT_BAIT_PATTERN.test(text.trim())) issues.push(`Ends on generic engagement bait ("Thoughts?", "Agree?", "Drop a comment"). End on the actual point, or a genuinely specific question.`);

  const emojiCount = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  if (emojiCount > 1) issues.push(`Has ${emojiCount} emoji. Use at most one, or none.`);

  // Readability over detector-evasion: an earlier version of these checks pushed for uneven
  // sentence lengths and multi-sentence paragraphs, which produced dense, hard-to-read posts.
  const sentences = text.split(/(?<=[.?!])\s+/).map((s) => s.trim()).filter(Boolean);
  const longSentences = sentences.filter((s) => s.split(/\s+/).length > 30);
  if (longSentences.length) {
    issues.push(`Has ${longSentences.length} sentence(s) over 30 words, starting "${longSentences[0].split(/\s+/).slice(0, 8).join(" ")}...". Split each into shorter sentences.`);
  }

  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const longParagraphs = paragraphs.filter((p) => p.split(/(?<=[.?!])\s+/).length > 3);
  if (longParagraphs.length) {
    issues.push(`Has ${longParagraphs.length} paragraph(s) with more than three sentences. Break them up so each paragraph holds one idea.`);
  }

  return issues;
}

/**
 * Deterministic cleanup for the tells a model most often lets slip even when told not to.
 * Runs after every rewrite, so these never reach LinkedIn regardless of model compliance.
 */
export function scrubAiTells(text: string): string {
  let out = text.trim();

  // Leftover preamble or wrapping the output-format rules forbid but models still add.
  out = out.replace(/^(here'?s|here is)[^\n]*:\s*\n+/i, "");
  out = out.replace(/^["“](.*)["”]$/s, "$1").trim();

  // Dashes: list bullets become hyphens, number ranges become hyphens, and dashes used as a
  // pause between words become commas.
  out = out.replace(/^(\s*)[—–]\s*/gm, "$1- ");
  out = out.replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2");
  out = out.replace(/(\S)\s*[—–]\s*/g, "$1, ");
  out = out.replace(/,\s*([.!?])/g, "$1");

  // Stock sentence-opening transitions: drop the word and re-capitalize what follows it.
  out = out.replace(new RegExp(`${LEADING_TRANSITION_PATTERN.source}(\\w)`, "g"), (_m, lead: string, _word: string, ch: string) => lead + ch.toUpperCase());

  // Hashtags: keep at most three, all on the final line.
  const lines = out.split("\n");
  const last = lines[lines.length - 1];
  if (/^\s*(#\S+\s*)+$/.test(last)) {
    const tags = last.trim().split(/\s+/).slice(0, 3);
    lines[lines.length - 1] = tags.join(" ");
    out = lines.join("\n");
  }

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

const AI_TELL_RULES = `- Never use stock AI-sounding vocabulary, including: ${AI_TELL_PHRASES.join(", ")}.
- Never start a sentence with a lone transition word like Moreover, Furthermore, Additionally, or However — real people rarely write that way.
- Never use the "It's not just about X, it's about Y" / "This isn't X. It's Y." contrast template, or any close variant of it — it is one of the single most recognizable AI patterns.
- Do not use em dashes, en dashes, or hyphens as a rhetorical pause or clause separator (e.g. avoid "the results were clear - and surprising"). Do not use backslashes or forward slashes as shorthand connectors (e.g. "and/or", "input/output") — spell things out in plain words instead.
- Keep sentences simple: mostly short, with the occasional longer thought, and none over 30 words. Do not default to neatly balanced "X, Y, and Z" triads.
- Do not repeat the same idea in different words, and do not wrap every point in dramatic language. A plain, clear statement is stronger.
- Never add deliberate typos, grammar mistakes, or awkward wording to seem human. The writing should feel considered and natural, not artificially casual.
- Use contractions naturally where a real person would (don't, it's, we've, wasn't) rather than unnaturally formal complete grammar throughout.
- Use everyday words a smart person outside this field would understand. Avoid jargon and acronyms; if a technical term is unavoidable, explain it in a few plain words.
- Don't pile hedges and qualifiers into sentences ("reportedly", "actually", "arguably", "in some cases"). If a fact is uncertain, leave it out, or say so once, plainly.
- Use at most three numbers in the whole post. Pick the ones that matter most and make each one easy to picture.
- A short list of 2 to 4 items is fine when it makes the post easier to scan.
- Write in the first person, the way this person would say it out loud to a colleague (their voice and opinions, never invented experiences). Prefer the plain word over the impressive one ("use" not "utilize", "help" not "empower").
- Anchor the post in at least one concrete specific (a number, a named tool or company, a moment, a real constraint) rather than general claims. But never invent personal anecdotes, clients, results, or numbers about the author: if the request doesn't supply them, frame it as an observation or opinion, not a story that didn't happen.
- Have an actual opinion. A small, specific stance or a mild admission of doubt reads human; hedged, balanced "both sides have merit" summaries read like AI.
- No rhetorical question-then-answer reveals ("The result? ...", "Why does this matter? Because ..."), no colon cliffhangers ("Here's what I learned:"), and no "Let that sink in."
- Do not end with generic engagement bait ("Thoughts?", "Agree?", "What do you think?", "Drop a comment below"). End with an insight that stays with the reader.
- Keep paragraphs to one or two sentences, never more than three, with a blank line between them so the post is easy to read on a phone.
- At most one emoji in the whole post, and none as bullet points or line starters. No bold or italic unicode lettering.`;

const OUTPUT_FORMAT_RULES = `Output format — read carefully:
- Respond with ONLY the finished post text, exactly as it should be published.
- Do not include any preamble, explanation, or introduction (e.g. "Here's the draft:", "Here's a polished version...").
- Do not include closing remarks or questions (e.g. "Let me know if you'd like changes.").
- Do not use separators like "---", headings, or wrap the post in quotes or code fences.
- Do not include URLs, footnote markers, or citation text inline in the post itself — sources
  are tracked and shown separately, not part of the published post body.
- The first character of your response must be the first character of the post itself, and the last character must be the end of the post (its final word or hashtag).`;

// Shared by generatePostText and revisePublishedPost, so a formatting rule only needs to be
// stated once.
//
// The reach rules follow how LinkedIn's feed actually ranks posts: only the first ~200 characters
// show before "...see more", so the opening decides whether anyone expands it; time spent reading
// and substantive comments count for far more than likes; and posts with outbound links get less
// distribution (sources are shown in Slack instead, never in the post).
const POST_FORMAT_RULES = `Rules for the post:
- The first two lines (about 200 characters, all a reader sees before "...see more") must give a reason to keep reading: a specific, surprising fact, a real tension, or a clear stance drawn from the research. Earn the click with substance, never clickbait or a manufactured hook.
- Give the reader something they can't get from the headline: a practical implication, a specific detail, or a non-obvious angle. That is what keeps people reading and gets the post saved and shared.
- Short paragraphs with white space between them, readable on a phone. Plain language that sounds like a real person, not corporate marketing copy.
${AI_TELL_RULES}
- 0-3 relevant hashtags max, only at the very end.
- About 150-300 words. Go shorter when the idea is simple; never add words just to look substantial.
- No links in the post body.

${OUTPUT_FORMAT_RULES}`;

// OpenRouter and OpenAI both speak the same chat-completions request/response shape.
async function callOpenAiCompatible(url: string, apiKey: string, model: string, prompt: string, providerLabel: string): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`${providerLabel} API failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const raw = json.choices?.[0]?.message?.content?.trim();
  if (!raw) throw new Error(`${providerLabel} returned no content — try again shortly.`);
  return raw;
}

async function callAnthropic(prompt: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      // Generous enough for a single post, and for a multi-pillar JSON calendar response
      // (several pillars, each with a full sentence prompt) without truncating mid-output.
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { content?: { type: string; text?: string }[] };
  const raw = json.content?.find((block) => block.type === "text")?.text?.trim();
  if (!raw) throw new Error("Anthropic returned no content — try again shortly.");
  return raw;
}

// Caps Claude's web searches per post generation — searches are billed per-use on top of
// normal token costs ($10/1,000 searches as of writing), so this keeps cost bounded and
// predictable rather than letting Claude research indefinitely.
const MAX_WEB_SEARCHES_PER_POST = 5;

interface AnthropicTextBlock {
  type: "text";
  text: string;
  citations?: { type: string; url?: string; title?: string }[];
}

interface AnthropicWebSearchResultBlock {
  type: "web_search_tool_result";
  // A list on success; a single { type: "web_search_tool_result_error", error_code } object
  // on failure (e.g. rate limited) — checked with Array.isArray before iterating.
  content: { type: string; url?: string; title?: string }[] | { type: string; error_code?: string };
}

// Like callAnthropic, but with the server-side web_search tool enabled so Claude can
// research the topic (including community/social discussion, where it judges that
// relevant) before writing. Returns every result the search turned up, not just the subset
// Claude happened to cite inline — citations only attach when the final prose quotes a
// result directly, so relying on citations alone drops results Claude read but paraphrased.
// Only used for post text — content-calendar pillar planning doesn't need live research.
//
// tool_choice forces the first content block to be a web_search call — without it, Claude
// very often judges a topic "evergreen" and skips search entirely, leaving sources empty.
// This only pins the *opening* move: once the search result comes back, Claude continues
// generating normally (more searches, then final text), same as the standard "force one
// tool call, then let the model finish the turn" pattern for tool_choice.
async function callAnthropicWithSearch(prompt: string): Promise<{ text: string; sources: { url: string; title: string }[] }> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": config.anthropicApiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.anthropicModel,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_WEB_SEARCHES_PER_POST }],
      tool_choice: { type: "tool", name: "web_search" },
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as {
    content?: Array<AnthropicTextBlock | AnthropicWebSearchResultBlock | { type: string }>;
  };
  const textBlocks = (json.content ?? []).filter((b): b is AnthropicTextBlock => b.type === "text");
  const text = textBlocks.map((b) => b.text).join("").trim();
  if (!text) throw new Error("Anthropic returned no content — try again shortly.");

  const sourcesByUrl = new Map<string, string>();

  // Citations on the final text — what Claude actually drew on to write a specific claim.
  for (const block of textBlocks) {
    for (const citation of block.citations ?? []) {
      if (citation.type === "web_search_result_location" && citation.url) {
        sourcesByUrl.set(citation.url, citation.title ?? citation.url);
      }
    }
  }

  // The raw search results themselves, whether or not Claude ended up citing them inline —
  // tool_choice guarantees a search happened, but not that the final prose quotes it, and
  // the user wants every source the search turned up, not just the subset Claude cited.
  const resultBlocks = (json.content ?? []).filter((b): b is AnthropicWebSearchResultBlock => b.type === "web_search_tool_result");
  for (const block of resultBlocks) {
    if (!Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result.type === "web_search_result" && result.url) {
        sourcesByUrl.set(result.url, result.title ?? result.url);
      }
    }
  }

  return { text, sources: [...sourcesByUrl].map(([url, title]) => ({ url, title })) };
}

// ---- Gemini ----

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

interface GeminiCandidate {
  content?: { parts?: { text?: string }[] };
  finishReason?: string;
  groundingMetadata?: { groundingChunks?: { web?: { uri?: string; title?: string } }[] };
}

/**
 * Gemini's generateContent, with the server-side Google Search tool optional so the
 * grounded and plain paths share one set of request/error handling. Gemini 2.5+ models
 * spend part of their output budget on internal reasoning tokens, so maxOutputTokens is
 * deliberately left unset — capping it is exactly what produces an empty response with
 * finishReason MAX_TOKENS.
 */
async function callGemini(prompt: string, options: { search?: boolean } = {}): Promise<{ text: string; sources: { url: string; title: string }[] }> {
  const response = await fetch(`${GEMINI_API_BASE}/${config.geminiModel}:generateContent`, {
    method: "POST",
    headers: {
      "x-goog-api-key": config.geminiApiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      ...(options.search ? { tools: [{ google_search: {} }] } : {}),
    }),
  });

  if (!response.ok) {
    throw new Error(`Gemini API failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { candidates?: GeminiCandidate[]; promptFeedback?: { blockReason?: string } };
  if (json.promptFeedback?.blockReason) {
    throw new Error(`Gemini declined the request (${json.promptFeedback.blockReason}) — try rewording the topic.`);
  }

  const candidate = json.candidates?.[0];
  const text = (candidate?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
  if (!text) {
    throw new Error(`Gemini returned no content (finish reason: ${candidate?.finishReason ?? "unknown"}) — try again shortly.`);
  }

  // Grounding citations come back as redirect URLs on Google's grounding-api-redirect host,
  // titled with the source's domain. They resolve to the real page and render fine in Slack,
  // so they're passed through as-is rather than followed to their destination here.
  const sourcesByUrl = new Map<string, string>();
  for (const chunk of candidate?.groundingMetadata?.groundingChunks ?? []) {
    if (chunk.web?.uri) sourcesByUrl.set(chunk.web.uri, chunk.web.title ?? chunk.web.uri);
  }

  return { text, sources: [...sourcesByUrl].map(([url, title]) => ({ url, title })) };
}

/**
 * Parses a JSON payload out of a model response, tolerating the markdown code fence models
 * tend to add despite being told not to. Shared by the content-calendar planner and the
 * poster art-direction brief.
 */
export function parseJsonFromModel<T>(raw: string, what: string): T {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new Error(`Failed to parse ${what} — model returned non-JSON: ${raw.slice(0, 200)}`);
  }
}

// Dispatches a raw prompt to whichever LLM provider is configured. Shared by post
// drafting, content-calendar pillar generation, and the poster art brief, so the provider
// switch lives in one place.
export async function generateFromPrompt(prompt: string): Promise<string> {
  switch (config.llmProvider) {
    case "openai":
      return callOpenAiCompatible("https://api.openai.com/v1/chat/completions", config.openaiApiKey, config.openaiModel, prompt, "OpenAI");
    case "anthropic":
      return callAnthropic(prompt);
    case "gemini":
      return (await callGemini(prompt)).text;
    default:
      return callOpenAiCompatible("https://openrouter.ai/api/v1/chat/completions", config.openrouterApiKey, config.openrouterModel, prompt, "OpenRouter");
  }
}

// Runs a post-writing prompt through the configured provider, using its server-side web
// search tool where one is wired up so the post reflects current information and can cite
// what it used. Providers without search fall back to writing from trained knowledge alone,
// which yields no sources — see GeneratedPost.sources.
async function generateGroundedPost(prompt: string): Promise<GeneratedPost> {
  switch (config.llmProvider) {
    case "anthropic": {
      const { text, sources } = await callAnthropicWithSearch(prompt);
      return { postText: text, sources };
    }
    case "gemini": {
      const { text, sources } = await callGemini(prompt, { search: true });
      return { postText: text, sources };
    }
    default:
      return { postText: await generateFromPrompt(prompt), sources: [] };
  }
}

// A dedicated second pass that rewrites an already-drafted post specifically to strip out
// whatever AI tells survived the first pass. Single-shot instructions are unreliable because a
// model asked to "write a post AND avoid these 20 things" drifts back to its defaults partway
// through generation — a focused rewrite that only has to check a finished, shorter text against
// the checklist holds it far more consistently. Not run through the search-enabled call: it isn't
// researching anything new, just rephrasing what's already there.
async function humanizePost(draftText: string): Promise<string> {
  const prompt = `Edit the LinkedIn post below so it is simple, clear, and easy to read, and sounds like a real
person explaining something to a colleague, not an AI or an analyst report. A busy reader should get
the point in one quick read on their phone. Split long sentences, break up dense paragraphs, swap
jargon for plain words, and cut any detail the main point doesn't need. Keep the same core message
and the key facts. This is an edit, not a chance to say something new: do not add facts,
statistics, or personal experiences that aren't in the original.

Original draft:
"""
${draftText}
"""

Go through it and actively fix, don't just avoid, every one of these if present:
${AI_TELL_RULES}

${OUTPUT_FORMAT_RULES}`;

  return generateFromPrompt(prompt);
}

// A focused fix-up for whatever findAiTells still catches after the humanize pass — naming the
// exact problems works far better than re-sending the whole checklist a second time.
async function fixRemainingTells(text: string, issues: string[]): Promise<string> {
  const prompt = `This LinkedIn post still has a few specific problems that make it read as AI-written.
Fix exactly these, change as little else as possible, and keep the meaning, facts, and length.

Post:
"""
${text}
"""

Problems to fix:
${issues.map((i) => `- ${i}`).join("\n")}

${OUTPUT_FORMAT_RULES}`;

  return generateFromPrompt(prompt);
}

// Bounded so a stubborn model can't burn unlimited calls — after this many targeted fixes the
// post ships with whatever residue is left (the deterministic scrub still runs on it).
const MAX_TELL_FIX_PASSES = 2;

/**
 * Every finished post goes through this: the humanize rewrite, a deterministic scrub of the
 * mechanical tells, then up to MAX_TELL_FIX_PASSES targeted fixes for anything still detectable.
 */
async function finalizePost(draftText: string): Promise<string> {
  let text = scrubAiTells(await humanizePost(draftText));

  for (let pass = 0; pass < MAX_TELL_FIX_PASSES; pass++) {
    const issues = findAiTells(text);
    if (issues.length === 0) break;
    text = scrubAiTells(await fixRemainingTells(text, issues));
  }

  return text;
}

// Multi-platform research (src/research.ts) needs Anthropic's server-side search tools. Any
// failure there falls back to the single search-grounded call, so a research outage costs
// quality, not the whole post.
async function tryResearch(topic: string, threadContext?: string): Promise<ResearchResult | undefined> {
  if (config.llmProvider !== "anthropic") return undefined;
  try {
    return await researchTopic(topic, threadContext);
  } catch (err) {
    console.error("Multi-platform research failed, falling back to single-pass search:", err);
    return undefined;
  }
}

// skipHumanize exists only for scripts/check-ai-detection.ts, to measure what the humanize
// pass actually buys — not used anywhere in the Slack app flow.
export async function generatePostText(topic: string, contentStyle: ContentStyle, threadContext?: string, refinement?: Refinement, skipHumanize = false): Promise<GeneratedPost> {
  const styleInstruction = CONTENT_STYLES.find((s) => s.style === contentStyle)?.instruction;
  const refinementInstruction = refinement && REFINEMENT_STYLES.find((r) => r.style === refinement.style)?.instruction;

  const research = await tryResearch(topic, threadContext);

  const researchSection = research
    ? `Research gathered for this post from the official source, practitioner communities, social
platforms, and independent analysts:
"""
${research.brief}
"""

How to use the research:
- The research is background, not a checklist. Use only the two or three facts that matter most for
  your angle, and leave the rest out. A post that crams in every finding is hard to read.
- Build the post on the facts and on what people are actually saying, not on what the topic sounds like.
- Skip the takes listed as overused. Look hardest at the underexplored angles and at where the
  official claims and real user experience don't match: that gap is usually the post.
- Write as a practitioner who has read all of this and has a view on it. The author can speak in the
  first person about what they're seeing in the conversation ("the complaint I keep seeing", "what
  most coverage skips") because that comes from real research. Never invent hands-on use, clients,
  or results the request didn't provide.
- Only use facts that appear in the research or the request.`
    : `Before writing, if you have web search available, use it at least once — even for a topic that
feels evergreen or already well within your knowledge. Find a concrete, current fact, statistic,
example, or notable discussion to ground the post in (industry write-ups, recent news, posts from
recognized voices in the space). Search again if the first result isn't useful, or if the topic
would benefit from more than one angle. Only skip searching entirely if no search tool is
available to you.`;

  const prompt = `You are ghostwriting a LinkedIn post for a professional building their personal brand.
Today's date is ${new Date().toISOString().slice(0, 10)}.

Request from Slack:
"${topic}"
${threadContext ? `\nAdditional context from the Slack thread (if it includes the author's own experience or opinion, build the post around it):\n${threadContext}` : ""}

Content style: ${styleInstruction}

${HUMAN_WRITING_GUIDE}

${researchSection}

${POST_FORMAT_RULES}
${
  refinement
    ? `\nYou previously wrote this draft, which the user rejected:\n"""\n${refinement.previousText}\n"""\nRevise it based on this feedback: ${refinementInstruction}\nDo not just tweak a few words — meaningfully rewrite the post while still following all the rules above.`
    : ""
}`;

  const draft = research ? { postText: await generateFromPrompt(prompt), sources: research.sources } : await generateGroundedPost(prompt);
  if (skipHumanize) return draft;
  return { postText: await finalizePost(draft.postText), sources: draft.sources };
}

/**
 * Revises the text of an already-published LinkedIn post based on freeform user feedback
 * (the "edit post" flow) — distinct from generatePostText's refinement path, which revises
 * an unpublished draft against one of the fixed RefinementStyle options.
 */
export async function revisePublishedPost(previousText: string, instruction: string): Promise<GeneratedPost> {
  const prompt = `You are revising a LinkedIn post that has ALREADY BEEN PUBLISHED, based on specific feedback from its author.

Current published post:
"""
${previousText}
"""

Requested change: ${instruction}

Rewrite the post to address this feedback. Keep it recognizably the same post (same core topic
and message) unless the feedback explicitly asks for a different angle.

${HUMAN_WRITING_GUIDE}

${POST_FORMAT_RULES}`;

  const draft = await generateGroundedPost(prompt);
  return { postText: await finalizePost(draft.postText), sources: draft.sources };
}
