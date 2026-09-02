import { config as loadEnv } from "dotenv";

// override: true — this project's .env always wins over stray machine-level
// env vars of the same name (e.g. a leftover OPENROUTER_API_KEY from another project).
loadEnv({ override: true });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

export type LlmProvider = "openrouter" | "openai" | "anthropic" | "gemini";
const LLM_PROVIDERS: LlmProvider[] = ["openrouter", "openai", "anthropic", "gemini"];

const llmProvider = (process.env.LLM_PROVIDER ?? "openrouter") as LlmProvider;
if (!LLM_PROVIDERS.includes(llmProvider)) {
  throw new Error(`Invalid LLM_PROVIDER: "${llmProvider}". Must be one of: ${LLM_PROVIDERS.join(", ")}.`);
}

// Only the API key for the selected LLM_PROVIDER needs to be set.
function requiredForProvider(name: string, provider: LlmProvider): string {
  const v = process.env[name];
  if (llmProvider === provider && !v) {
    throw new Error(`Missing required env var: ${name} (required when LLM_PROVIDER=${provider}). Copy .env.example to .env and fill it in.`);
  }
  return v ?? "";
}

// Read separately from the config object below because poster generation keys off whether
// this is set, regardless of which provider writes the text (see postImages).
const geminiApiKey = requiredForProvider("GEMINI_API_KEY", "gemini");

export const config = {
  slackBotToken: required("SLACK_BOT_TOKEN"),
  slackSigningSecret: required("SLACK_SIGNING_SECRET"),
  slackChannelId: required("SLACK_CHANNEL_ID"),
  port: Number(process.env.PORT ?? 3000),
  // Vercel's Storage tab injects these under the legacy KV_* names (a holdover from
  // the deprecated @vercel/kv product) even though the underlying database is Redis.
  redisUrl: required("KV_REST_API_URL"),
  redisToken: required("KV_REST_API_TOKEN"),
  llmProvider,
  openrouterApiKey: requiredForProvider("OPENROUTER_API_KEY", "openrouter"),
  openrouterModel: process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free",
  openaiApiKey: requiredForProvider("OPENAI_API_KEY", "openai"),
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  anthropicApiKey: requiredForProvider("ANTHROPIC_API_KEY", "anthropic"),
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  geminiApiKey,
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  // Poster generation is deliberately independent of LLM_PROVIDER — only Gemini has an
  // image model wired up here, so posters keep working when the text comes from Claude or
  // OpenAI as long as GEMINI_API_KEY is set. Defaults on when a key is present, since
  // there's nothing to gain from having the key and silently not using it.
  postImages: (process.env.POST_IMAGES ?? (geminiApiKey ? "on" : "off")).toLowerCase() !== "off",
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL ?? "gemini-2.5-flash-image",
  // 1:1 fills more of a mobile LinkedIn feed than a 1.91:1 banner without risking the
  // crop that portrait ratios get in some LinkedIn surfaces.
  postImageAspectRatio: process.env.POST_IMAGE_ASPECT_RATIO ?? "1:1",
  linkedinAccessToken: process.env.LINKEDIN_ACCESS_TOKEN ?? "",
  linkedinPersonId: process.env.LINKEDIN_PERSON_ID ?? "",
  linkedinClientId: process.env.LINKEDIN_CLIENT_ID ?? "",
  linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
  triggerPhrase: process.env.TRIGGER_PHRASE ?? "create a post",
  calendarTriggerPhrase: process.env.CALENDAR_TRIGGER_PHRASE ?? "content calendar",
  editTriggerPhrase: process.env.EDIT_TRIGGER_PHRASE ?? "edit post",
  // Content calendar scheduling (Upstash QStash) — optional; only needed once someone
  // actually approves a calendar. See assertQstashConfigured() in src/calendar.ts.
  qstashToken: process.env.QSTASH_TOKEN ?? "",
  qstashCurrentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY ?? "",
  qstashNextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY ?? "",
  appBaseUrl: process.env.APP_BASE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : ""),
};
