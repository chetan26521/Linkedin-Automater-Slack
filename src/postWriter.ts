import { config } from "./config.js";

export interface GeneratedPost {
  postText: string;
  // Web search citations actually used while researching the post — only ever populated
  // when LLM_PROVIDER=anthropic (the only provider wired up for search here) and Claude
  // decided a search was warranted. Empty otherwise, including when it answered from its
  // own trained knowledge without searching.
  sources: { url: string; title: string }[];
}

export type ContentStyle = "simple" | "technical" | "architectural" | "business";

export const CONTENT_STYLES: { style: ContentStyle; label: string; instruction: string }[] = [
  { style: "simple", label: "🧩 Simple", instruction: "Write for a general audience: plain everyday language, no jargon, focused on the big-picture takeaway and why it matters." },
  { style: "technical", label: "⚙️ Technical", instruction: "Write for a technical/engineering audience: be specific about the technology, implementation details, and tradeoffs involved." },
  { style: "architectural", label: "🏗️ Architectural", instruction: "Write for an audience interested in system design: focus on architecture, design decisions, scalability, and how the pieces fit together." },
  { style: "business", label: "💼 Business", instruction: "Write for a business/leadership audience: focus on impact, ROI, strategic value, and outcomes rather than technical detail." },
];

export type RefinementStyle = "shorter" | "professional" | "punchier" | "different-angle";

export const REFINEMENT_STYLES: { style: RefinementStyle; label: string; instruction: string }[] = [
  { style: "shorter", label: "📏 Shorter", instruction: "Make it noticeably shorter and more concise while keeping the core message." },
  { style: "professional", label: "👔 More Professional", instruction: "Make the tone more professional and polished, and less casual." },
  { style: "punchier", label: "🔥 Punchier", instruction: "Make it punchier and more attention-grabbing, with a stronger hook and more energy." },
  { style: "different-angle", label: "🔀 Different Angle", instruction: "Take a completely different angle or structure than the previous draft, while staying on the same topic." },
];

export interface Refinement {
  style: RefinementStyle;
  previousText: string;
}

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

// Like callAnthropic, but with the server-side web_search tool enabled so Claude can
// research the topic (including community/social discussion, where it judges that
// relevant) before writing, and cites what it actually used. Only used for post text —
// content-calendar pillar planning doesn't need live research.
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
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API failed: ${response.status} ${await response.text()}`);
  }

  const json = (await response.json()) as { content?: Array<AnthropicTextBlock | { type: string }> };
  const textBlocks = (json.content ?? []).filter((b): b is AnthropicTextBlock => b.type === "text");
  const text = textBlocks.map((b) => b.text).join("").trim();
  if (!text) throw new Error("Anthropic returned no content — try again shortly.");

  const sourcesByUrl = new Map<string, string>();
  for (const block of textBlocks) {
    for (const citation of block.citations ?? []) {
      if (citation.type === "web_search_result_location" && citation.url) {
        sourcesByUrl.set(citation.url, citation.title ?? citation.url);
      }
    }
  }

  return { text, sources: [...sourcesByUrl].map(([url, title]) => ({ url, title })) };
}

// Dispatches a raw prompt to whichever LLM provider is configured. Shared by post
// drafting and content-calendar pillar generation, so the 3-provider switch lives once.
export async function generateFromPrompt(prompt: string): Promise<string> {
  switch (config.llmProvider) {
    case "openai":
      return callOpenAiCompatible("https://api.openai.com/v1/chat/completions", config.openaiApiKey, config.openaiModel, prompt, "OpenAI");
    case "anthropic":
      return callAnthropic(prompt);
    default:
      return callOpenAiCompatible("https://openrouter.ai/api/v1/chat/completions", config.openrouterApiKey, config.openrouterModel, prompt, "OpenRouter");
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

Before writing, research the topic (if you have web search available) so the post reflects
current, accurate information rather than relying solely on what you already know — look for
credible sources, and where genuinely relevant, how the topic is actually being discussed by
practitioners and the community (industry write-ups, Reddit threads, posts from recognized
voices in the space). Use your judgment on what's relevant; don't force sources that don't fit
just to have used search.

Rules for the post:
- Strong hook in the first line.
- Short paragraphs, plain language, sounds like a real person (not corporate marketing copy).
- 0-3 relevant hashtags max, only at the very end.
- 80-200 words.
${
  refinement
    ? `\nYou previously wrote this draft, which the user rejected:\n"""\n${refinement.previousText}\n"""\nRevise it based on this feedback: ${refinementInstruction}\nDo not just tweak a few words — meaningfully rewrite the post while still following all the rules above.`
    : ""
}

Output format — read carefully:
- Respond with ONLY the finished post text, exactly as it should be published.
- Do not include any preamble, explanation, or introduction (e.g. "Here's the draft:", "Here's a polished version...").
- Do not include closing remarks or questions (e.g. "Let me know if you'd like changes.").
- Do not use separators like "---", headings, or wrap the post in quotes or code fences.
- Do not include URLs, footnote markers, or citation text inline in the post itself — sources
  are tracked and shown separately, not part of the published post body.
- The first character of your response must be the first character of the post itself, and the last character must be the end of the post (its final word or hashtag).`;

  if (config.llmProvider === "anthropic") {
    const { text, sources } = await callAnthropicWithSearch(prompt);
    return { postText: text, sources };
  }

  return { postText: await generateFromPrompt(prompt), sources: [] };
}
