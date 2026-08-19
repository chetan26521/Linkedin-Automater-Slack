import { Redis } from "@upstash/redis";
import type { ContentStyle } from "./postWriter.js";

// Serverless functions don't share memory across invocations, so drafts and pending
// requests live in Redis (via Vercel's Upstash integration) instead of an in-process
// Map, keyed with a TTL. Redis.fromEnv() reads UPSTASH_REDIS_REST_URL/_TOKEN.
const redis = Redis.fromEnv();
const TTL_SECONDS = 30 * 60; // entries expire 30 min after creation if never resolved

export interface Draft {
  id: string;
  text: string;
  topic: string;
  threadContext?: string;
  contentStyle: ContentStyle;
  messageTs: string; // ts of the Slack message showing the draft text, so regenerate can edit it in place
  channel: string;
  requestedBy: string;
  createdAt: number;
}

const draftKey = (id: string) => `draft:${id}`;

export async function saveDraft(draft: Draft): Promise<void> {
  await redis.set(draftKey(draft.id), draft, { ex: TTL_SECONDS });
}

export async function getDraft(id: string): Promise<Draft | undefined> {
  const draft = await redis.get<Draft>(draftKey(id));
  return draft ?? undefined;
}

export async function updateDraftText(id: string, text: string): Promise<void> {
  const draft = await getDraft(id);
  if (!draft) return;
  await saveDraft({ ...draft, text });
}

export async function deleteDraft(id: string): Promise<void> {
  await redis.del(draftKey(id));
}

// Holds a topic (and thread context) after "create a post" but before the user has
// picked a content style — the style-picker buttons carry only this id.
export interface PendingRequest {
  id: string;
  topic: string;
  threadContext?: string;
  channel: string;
  threadTs: string;
  requestedBy: string;
  createdAt: number;
}

const pendingKey = (id: string) => `pending:${id}`;

export async function savePendingRequest(req: PendingRequest): Promise<void> {
  await redis.set(pendingKey(req.id), req, { ex: TTL_SECONDS });
}

export async function getPendingRequest(id: string): Promise<PendingRequest | undefined> {
  const req = await redis.get<PendingRequest>(pendingKey(id));
  return req ?? undefined;
}

export async function deletePendingRequest(id: string): Promise<void> {
  await redis.del(pendingKey(id));
}
