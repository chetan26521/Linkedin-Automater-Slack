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

/** A poster already uploaded via uploadImage, ready to attach to a post. */
export interface PostImageRef {
  urn: string;
  altText: string;
}

/**
 * Uploads image bytes to LinkedIn and returns the resulting `urn:li:image:...`, ready to
 * attach to a post. Two steps: initializeUpload hands back a single-use upload URL, then
 * the bytes go up with a plain PUT. An image that never gets attached to a post is simply
 * an unused asset, so it's safe to upload one while a draft is still awaiting approval.
 */
export async function uploadImage(bytes: Buffer, contentType: string): Promise<string> {
  assertConfigured();
  const personUrn = `urn:li:person:${config.linkedinPersonId}`;

  const initialized = await linkedinFetch("/rest/images?action=initializeUpload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initializeUploadRequest: { owner: personUrn } }),
  });

  const { value } = (await initialized.json()) as { value?: { uploadUrl?: string; image?: string } };
  if (!value?.uploadUrl || !value.image) {
    throw new Error("LinkedIn did not return an upload URL for the image.");
  }

  // uploadUrl is an absolute URL on LinkedIn's media host, so it goes through plain fetch
  // rather than linkedinFetch — it still needs the bearer token, but none of the REST
  // versioning headers, and it must not be prefixed with the API base.
  const uploaded = await fetch(value.uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.linkedinAccessToken}`,
      "Content-Type": contentType,
    },
    // Copied into a plain Uint8Array because Node's Buffer type isn't assignable to fetch's
    // BodyInit; the bytes are identical either way.
    body: new Uint8Array(bytes),
  });

  if (!uploaded.ok) {
    throw new Error(`LinkedIn image upload failed: ${uploaded.status} ${await uploaded.text()}`);
  }

  return value.image;
}

/**
 * Publishes a post to the connected LinkedIn profile, with an optional uploaded poster
 * attached. Returns the created post's URN.
 */
export async function publishPost(text: string, image?: PostImageRef): Promise<string> {
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
      ...(image ? { content: { media: { id: image.urn, altText: image.altText } } } : {}),
    }),
  });

  return response.headers.get("x-restli-id") ?? response.headers.get("x-linkedin-id") ?? "unknown";
}

/**
 * Updates the text of an already-published post via LinkedIn's PARTIAL_UPDATE. Only the
 * commentary is patched — an attached poster stays exactly as published, since LinkedIn
 * does not allow swapping the media on a live post.
 */
export async function updatePost(urn: string, text: string): Promise<void> {
  assertConfigured();

  await linkedinFetch(`/rest/posts/${encodeURIComponent(urn)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-RestLi-Method": "PARTIAL_UPDATE" },
    body: JSON.stringify({ patch: { $set: { commentary: escapeLittleText(text) } } }),
  });
}
