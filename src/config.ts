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
// Same reasoning — OpenAI can draw the posters (IMAGE_PROVIDER=openai) independently of
// which provider LLM_PROVIDER selects for the post text itself (see postImages).
const openaiApiKey = requiredForProvider("OPENAI_API_KEY", "openai");

// Which image model draws the posters — independent of LLM_PROVIDER. Explicit
// IMAGE_PROVIDER wins; otherwise prefer Gemini when its key is set, then OpenAI.
export type ImageProvider = "gemini" | "openai";
const IMAGE_PROVIDERS: ImageProvider[] = ["gemini", "openai"];
const imageProvider = (process.env.IMAGE_PROVIDER?.toLowerCase() ?? (geminiApiKey ? "gemini" : "openai")) as ImageProvider;
if (!IMAGE_PROVIDERS.includes(imageProvider)) {
  throw new Error(`Invalid IMAGE_PROVIDER: "${imageProvider}". Must be one of: ${IMAGE_PROVIDERS.join(", ")}.`);
}
const imageProviderKey = imageProvider === "gemini" ? geminiApiKey : openaiApiKey;

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
  openaiApiKey,
  openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
  anthropicApiKey: requiredForProvider("ANTHROPIC_API_KEY", "anthropic"),
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
  geminiApiKey,
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash",
  // Poster generation is deliberately independent of LLM_PROVIDER, so posters keep working
  // whichever provider writes the text, as long as the IMAGE_PROVIDER's key is set. Defaults
  // on when that key is present, since there's nothing to gain from having the key and
  // silently not using it.
  imageProvider,
  postImages: (process.env.POST_IMAGES ?? (imageProviderKey ? "on" : "off")).toLowerCase() !== "off",
  openaiImageModel: process.env.OPENAI_IMAGE_MODEL ?? "gpt-image-1",
  // The Pro image model renders typography and layout far better than Flash — the difference
  // between a poster you'd publish and one you wouldn't. It's paid-only, so a key that can't
  // use it falls back to the Flash model automatically (see callGeminiImage).
  geminiImageModel: process.env.GEMINI_IMAGE_MODEL ?? "gemini-3-pro-image-preview",
  geminiImageFallbackModel: process.env.GEMINI_IMAGE_FALLBACK_MODEL ?? "gemini-2.5-flash-image",
  // Optional comma-separated hex colours (background, text, accents) that replace the built-in
  // poster palettes, for a consistent brand look across every post.
  posterBrandColors: process.env.POSTER_BRAND_COLORS ?? "",
  // 4:5 portrait is the largest shape LinkedIn shows uncropped in the mobile feed, so the
  // poster takes up the most screen space a single image can.
  postImageAspectRatio: process.env.POST_IMAGE_ASPECT_RATIO ?? "4:5",
  // Legacy single-account credentials from `npm run linkedin-auth`. Only used as a fallback
  // for LINKEDIN_OWNER_SLACK_USER_ID until that person connects through Slack themselves —
  // everyone else's tokens live per-user in Redis (see src/linkedinAccounts.ts).
  linkedinAccessToken: process.env.LINKEDIN_ACCESS_TOKEN ?? "",
  linkedinPersonId: process.env.LINKEDIN_PERSON_ID ?? "",
  linkedinOwnerSlackUserId: process.env.LINKEDIN_OWNER_SLACK_USER_ID ?? "",
  linkedinClientId: process.env.LINKEDIN_CLIENT_ID ?? "",
  linkedinClientSecret: process.env.LINKEDIN_CLIENT_SECRET ?? "",
  // Must match an Authorized redirect URL on the LinkedIn app exactly, so it can't fall back
  // to VERCEL_URL (a different hostname on every deployment) the way appBaseUrl does.
  linkedinRedirectUri:
    process.env.LINKEDIN_REDIRECT_URI ??
    (process.env.APP_BASE_URL
      ? `${process.env.APP_BASE_URL.replace(/\/$/, "")}/api/linkedin/callback`
      : process.env.VERCEL_PROJECT_PRODUCTION_URL
        ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}/api/linkedin/callback`
        : ""),
  // 32 bytes, base64 — encrypts every stored LinkedIn access token at rest. Generate with
  // `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
  tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY ?? "",
  triggerPhrase: process.env.TRIGGER_PHRASE ?? "create a post",
  calendarTriggerPhrase: process.env.CALENDAR_TRIGGER_PHRASE ?? "content calendar",
  editTriggerPhrase: process.env.EDIT_TRIGGER_PHRASE ?? "edit post",
  connectTriggerPhrase: process.env.CONNECT_TRIGGER_PHRASE ?? "connect linkedin",
  disconnectTriggerPhrase: process.env.DISCONNECT_TRIGGER_PHRASE ?? "disconnect linkedin",
  // Content calendar scheduling (Upstash QStash) — optional; only needed once someone
  // actually approves a calendar. See assertQstashConfigured() in src/calendar.ts.
  qstashToken: process.env.QSTASH_TOKEN ?? "",
  qstashCurrentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY ?? "",
  qstashNextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY ?? "",
  appBaseUrl: process.env.APP_BASE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : ""),
};
