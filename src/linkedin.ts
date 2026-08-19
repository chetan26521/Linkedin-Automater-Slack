import { config } from "./config.js";

const API_BASE = "https://api.linkedin.com";
// LinkedIn bumps this monthly. If posts start failing with a version error,
// check https://learn.microsoft.com/en-us/linkedin/marketing/versioning and bump this.
const LINKEDIN_VERSION = "202608";

// LinkedIn's `commentary` field uses the "little" text format, where these characters are
// reserved for mentions/hashtag templates (see little-text-format docs). Left unescaped, any
// occurrence silently truncates the rest of the post once LinkedIn's parser can't complete the
// element it thinks it started. "#" is deliberately left alone so plain "#hashtags" still render
// as clickable hashtags.
function escapeLittleText(text: string): string {
  return text.replace(/[\\{}@[\]()<>*_~|]/g, (ch) => `\\${ch}`);
}

function assertConfigured(): void {
  if (!config.linkedinAccessToken || !config.linkedinPersonId) {
    throw new Error(
      "LinkedIn is not connected yet. Run `npm run linkedin-auth` once and copy the printed values into .env."
    );
  }
}

async function linkedinFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.linkedinAccessToken}`,
      "LinkedIn-Version": LINKEDIN_VERSION,
      "X-Restli-Protocol-Version": "2.0.0",
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LinkedIn API ${path} failed: ${response.status} ${body}`);
  }

  return response;
}

/** Publishes a text-only post to the connected LinkedIn profile. Returns the created post's URN. */
export async function publishPost(text: string): Promise<string> {
  assertConfigured();
  const personUrn = `urn:li:person:${config.linkedinPersonId}`;

  const response = await linkedinFetch("/rest/posts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      author: personUrn,
      commentary: escapeLittleText(text),
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    }),
  });

  return response.headers.get("x-restli-id") ?? response.headers.get("x-linkedin-id") ?? "unknown";
}
