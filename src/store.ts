import { Redis } from "@upstash/redis";
import { config } from "./config.js";
import type { ContentStyle } from "./postWriter.js";

// Serverless functions don't share memory across invocations, so drafts and pending
// requests live in Redis (via Vercel's Storage integration) instead of an in-process
// Map, keyed with a TTL.
const redis = new Redis({ url: config.redisUrl, token: config.redisToken });
const TTL_SECONDS = 30 * 60; // entries expire 30 min after creation if never resolved
const TOPIC_ANSWER_TTL_SECONDS = 10 * 60; // shorter — waiting on a human to type a reply

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

// Holds a "content calendar" trigger's thread until the user's next message answers
// "what topic?" — keyed by channel+thread rather than a random id, since a plain text
// reply (not a button click) can't carry an id.
export interface AwaitingCalendarTopic {
  channel: string;
  threadTs: string;
  requestedBy: string;
  createdAt: number;
}

const awaitingCalendarTopicKey = (channel: string, threadTs: string) => `awaiting-calendar-topic:${channel}:${threadTs}`;

export async function saveAwaitingCalendarTopic(entry: AwaitingCalendarTopic): Promise<void> {
  await redis.set(awaitingCalendarTopicKey(entry.channel, entry.threadTs), entry, { ex: TOPIC_ANSWER_TTL_SECONDS });
}

export async function getAwaitingCalendarTopic(channel: string, threadTs: string): Promise<AwaitingCalendarTopic | undefined> {
  const entry = await redis.get<AwaitingCalendarTopic>(awaitingCalendarTopicKey(channel, threadTs));
  return entry ?? undefined;
}

export async function deleteAwaitingCalendarTopic(channel: string, threadTs: string): Promise<void> {
  await redis.del(awaitingCalendarTopicKey(channel, threadTs));
}

export interface CalendarPillar {
  pillar: string;
  prompt: string;
  scheduledAt: number; // unix epoch seconds (UTC)
}

// A generated calendar proposal awaiting approve/regenerate/dismiss. Keeps the schedule
// inputs (weekdays/time/tz) alongside so "regenerate" can recompute dates the same way.
export interface PendingCalendarReview {
  id: string;
  topic: string;
  contentStyle: ContentStyle;
  weekdays: number[]; // JS Date.getDay() numbering, 0 = Sunday
  timeHHMM: string;
  tzOffsetSeconds: number;
  pillars: CalendarPillar[];
  channel: string;
  threadTs: string;
  requestedBy: string;
  createdAt: number;
}

const calendarReviewKey = (id: string) => `calendar-review:${id}`;

export async function saveCalendarReview(review: PendingCalendarReview): Promise<void> {
  await redis.set(calendarReviewKey(review.id), review, { ex: TTL_SECONDS });
}

export async function getCalendarReview(id: string): Promise<PendingCalendarReview | undefined> {
  const review = await redis.get<PendingCalendarReview>(calendarReviewKey(id));
  return review ?? undefined;
}

export async function deleteCalendarReview(id: string): Promise<void> {
  await redis.del(calendarReviewKey(id));
}
