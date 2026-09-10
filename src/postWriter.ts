import { config } from "./config.js";

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

// Shared by generatePostText and revisePublishedPost, so a formatting rule only needs to be
// stated once. The anti-em-dash/slash rule exists because those read as an unmistakable
// "AI wrote this" tell — LLMs default to them far more than natural human writing does.
const POST_FORMAT_RULES = `Rules for the post:
- Strong hook in the first line.
- Short paragraphs, plain language, sounds like a real person (not corporate marketing copy).
- Write in complete, natural sentences — do not use em dashes, en dashes, or hyphens as a rhetorical pause or clause separator (e.g. avoid "the results were clear - and surprising"). Do not use backslashes or forward slashes as shorthand connectors (e.g. "and/or", "input/output") — spell things out in plain words instead.
- 0-3 relevant hashtags max, only at the very end.
- 80-200 words.

Output format — read carefully:
- Respond with ONLY the finished post text, exactly as it should be published.
- Do not include any preamble, explanation, or introduction (e.g. "Here's the draft:", "Here's a polished version...").
- Do not include closing remarks or questions (e.g. "Let me know if you'd like changes.").
- Do not use separators like "---", headings, or wrap the post in quotes or code fences.
- Do not include URLs, footnote markers, or citation text inline in the post itself — sources
  are tracked and shown separately, not part of the published post body.
- The first character of your response must be the first character of the post itself, and the last character must be the end of the post (its final word or hashtag).`;

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

export async function generatePostText(topic: string, contentStyle: ContentStyle, threadContext?: string, refinement?: Refinement): Promise<GeneratedPost> {
  const styleInstruction = CONTENT_STYLES.find((s) => s.style === contentStyle)?.instruction;
  const refinementInstruction = refinement && REFINEMENT_STYLES.find((r) => r.style === refinement.style)?.instruction;

  const prompt = `You are ghostwriting a LinkedIn post for a professional building their personal brand.

Request from Slack:
"${topic}"
${threadContext ? `\nAdditional context from the Slack thread:\n${threadContext}` : ""}

Content style: ${styleInstruction}

Before writing, if you have web search available, use it at least once — even for a topic that
feels evergreen or already well within your knowledge. Find a concrete, current fact, statistic,
example, or notable discussion to ground the post in (industry write-ups, recent news, posts from
recognized voices in the space). Search again if the first result isn't useful, or if the topic
would benefit from more than one angle. Only skip searching entirely if no search tool is
available to you.

${POST_FORMAT_RULES}
${
  refinement
    ? `\nYou previously wrote this draft, which the user rejected:\n"""\n${refinement.previousText}\n"""\nRevise it based on this feedback: ${refinementInstruction}\nDo not just tweak a few words — meaningfully rewrite the post while still following all the rules above.`
    : ""
}`;

  return generateGroundedPost(prompt);
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

${POST_FORMAT_RULES}`;

  return generateGroundedPost(prompt);
}
