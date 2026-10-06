import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";
import { redis } from "./store.js";

// One LinkedIn connection per Slack user — whoever triggers a flow in Slack is who it posts
// as. Each person connects once via their own OAuth consent (LinkedIn has no way to post to
// someone's profile without it), and the resulting token is stored encrypted, keyed by their
// Slack user id, with a Redis TTL matching LinkedIn's own expiry so a dead token simply
// disappears instead of failing on publish.

const SCOPES = "openid profile w_member_social";
const OAUTH_STATE_TTL_SECONDS = 15 * 60;
// LinkedIn member tokens last ~60 days with no refresh token for self-serve apps, so the bot
// nudges people to reconnect once they're inside this window.
const EXPIRY_WARNING_SECONDS = 7 * 24 * 60 * 60;

export interface LinkedInCredentials {
  accessToken: string;
  personId: string;
}

export interface LinkedInAccount extends LinkedInCredentials {
  slackUserId: string;
  name: string;
  expiresAt: number; // epoch ms
  connectedAt: number; // epoch ms
}

interface StoredLinkedInAccount extends Omit<LinkedInAccount, "accessToken"> {
  encryptedAccessToken: string;
}

const accountKey = (slackUserId: string) => `linkedin-account:${slackUserId}`;
const oauthStateKey = (state: string) => `linkedin-oauth-state:${state}`;

// ---- Token encryption (AES-256-GCM). A Redis dump alone is then not enough to post as
// anyone — the key lives only in the deployment's env vars. ----

function encryptionKey(): Buffer {
  if (!config.tokenEncryptionKey) {
    throw new Error("TOKEN_ENCRYPTION_KEY is not set — it's needed to store LinkedIn connections. See README.");
  }
  const key = Buffer.from(config.tokenEncryptionKey, "base64");
  if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded.");
  return key;
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString("base64")).join(".");
}

function decrypt(payload: string): string {
  const [iv, tag, ciphertext] = payload.split(".").map((part) => Buffer.from(part, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

// ---- Connect flow ----

function assertOAuthConfigured(): void {
  if (!config.linkedinClientId || !config.linkedinClientSecret) {
    throw new Error("LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET are not set.");
  }
  if (!config.linkedinRedirectUri) {
    throw new Error("Can't build the LinkedIn redirect URL — set APP_BASE_URL (or LINKEDIN_REDIRECT_URI) to the app's stable production URL.");
  }
}

/**
 * Returns a LinkedIn consent URL bound to this Slack user. The random `state` is the only
 * thing tying the callback back to them, so it's single-use and short-lived — and since it's
 * only ever shown to that user (ephemerally), nobody else can complete a connection as them.
 */
export async function createConnectUrl(slackUserId: string): Promise<string> {
  assertOAuthConfigured();
  const state = randomBytes(24).toString("base64url");
  await redis.set(oauthStateKey(state), slackUserId, { ex: OAUTH_STATE_TTL_SECONDS });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.linkedinClientId,
    redirect_uri: config.linkedinRedirectUri,
    scope: SCOPES,
    state,
  });
  return `https://www.linkedin.com/oauth/v2/authorization?${params}`;
}

/** Consumes an OAuth state, returning the Slack user it was issued to (or undefined). */
export async function consumeOAuthState(state: string): Promise<string | undefined> {
  const slackUserId = await redis.getdel<string>(oauthStateKey(state));
  return slackUserId ?? undefined;
}

/** Exchanges an OAuth code for a token, looks up who it belongs to, and stores it. */
export async function completeConnection(slackUserId: string, code: string): Promise<LinkedInAccount> {
  assertOAuthConfigured();

  const tokenResponse = await fetch("https://www.linkedin.com/oauth/v2/accessToken", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: config.linkedinRedirectUri,
      client_id: config.linkedinClientId,
      client_secret: config.linkedinClientSecret,
    }),
  });
  const tokenJson = (await tokenResponse.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!tokenResponse.ok || !tokenJson.access_token) {
    throw new Error(`LinkedIn token exchange failed: ${tokenJson.error_description ?? tokenResponse.status}`);
  }

  const userInfoResponse = await fetch("https://api.linkedin.com/v2/userinfo", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  if (!userInfoResponse.ok) {
    throw new Error(`LinkedIn profile lookup failed: ${userInfoResponse.status} ${await userInfoResponse.text()}`);
  }
  const userInfo = (await userInfoResponse.json()) as { sub?: string; name?: string };
  if (!userInfo.sub) throw new Error("LinkedIn didn't return a member id.");

  const expiresInSeconds = tokenJson.expires_in ?? 60 * 24 * 60 * 60;
  const account: LinkedInAccount = {
    slackUserId,
    accessToken: tokenJson.access_token,
    personId: userInfo.sub,
    name: userInfo.name ?? "your LinkedIn profile",
    expiresAt: Date.now() + expiresInSeconds * 1000,
    connectedAt: Date.now(),
  };

  const { accessToken, ...rest } = account;
  const stored: StoredLinkedInAccount = { ...rest, encryptedAccessToken: encrypt(accessToken) };
  await redis.set(accountKey(slackUserId), stored, { ex: expiresInSeconds });
  return account;
}

export async function disconnectLinkedInAccount(slackUserId: string): Promise<boolean> {
  return (await redis.del(accountKey(slackUserId))) > 0;
}

/**
 * The LinkedIn account a Slack user's posts go to, or undefined if they haven't connected
 * (or their token expired). LINKEDIN_OWNER_SLACK_USER_ID keeps the original single-account
 * .env setup working for that one person until they connect through Slack themselves.
 */
export async function getLinkedInAccount(slackUserId: string): Promise<LinkedInAccount | undefined> {
  const stored = await redis.get<StoredLinkedInAccount>(accountKey(slackUserId));
  if (stored) {
    const { encryptedAccessToken, ...rest } = stored;
    return { ...rest, accessToken: decrypt(encryptedAccessToken) };
  }

  if (slackUserId === config.linkedinOwnerSlackUserId && config.linkedinAccessToken && config.linkedinPersonId) {
    return {
      slackUserId,
      accessToken: config.linkedinAccessToken,
      personId: config.linkedinPersonId,
      name: "your LinkedIn profile",
      // Unknown for a pasted .env token — treated as not expiring so no false warnings.
      expiresAt: Number.MAX_SAFE_INTEGER,
      connectedAt: 0,
    };
  }

  return undefined;
}

export function isExpiringSoon(account: LinkedInAccount): boolean {
  return account.expiresAt - Date.now() < EXPIRY_WARNING_SECONDS * 1000;
}
