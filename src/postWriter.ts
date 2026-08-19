import { config } from "./config.js";

export interface GeneratedPost {
  postText: string;
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
      max_tokens: 1024,
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
- The first character of your response must be the first character of the post itself, and the last character must be the end of the post (its final word or hashtag).`;

  return { postText: await generateFromPrompt(prompt) };
}
