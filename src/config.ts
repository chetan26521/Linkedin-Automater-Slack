import { config as loadEnv } from "dotenv";

// override: true — this project's .env always wins over stray machine-level
// env vars of the same name (e.g. a leftover OPENROUTER_API_KEY from another project).
loadEnv({ override: true });

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
  return v;
}

export type LlmProvider = "openrouter" | "openai" | "anthropic";
const LLM_PROVIDERS: LlmProvider[] = ["openrouter", "openai", "anthropic"];

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

export const config = {
  slackBotToken: required("SLACK_BOT_TOKEN"),
  slackSigningSecret: required("SLACK_SIGNING_SECRET"),
  slackChannelId: required("SLACK_CHANNEL_ID"),
  port: Number(process.env.PORT ?? 3000),
  llmProvider,
  openrouterApiKey: requiredForProvider("OPENROUTER_API_KEY", "openrouter"),
  openrouterModel: process.env.OPENROUTER_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free",
  openaiApiKey: requiredForProvider("OPENAI_API_KEY", "openai"),
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  anthropicApiKey: requiredForProvider("ANTHROPIC_API_KEY", "anthropic"),
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  linkedinAccessToken: process.env.LINKEDIN_ACCESS_TOKEN ?? "",
  linkedinPersonId: process.env.LINKEDIN_PERSON_ID ?? "",
  linkedinClientId: process.env.LINKEDIN_CLIENT_ID ?? "",
  linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
  triggerPhrase: process.env.TRIGGER_PHRASE ?? "create a post",
};
