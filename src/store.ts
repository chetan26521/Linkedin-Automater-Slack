import { Redis } from "@upstash/redis";
import { config } from "./config.js";
import type { ContentStyle } from "./postWriter.js";

// Serverless functions don't share memory across invocations, so drafts and pending
// requests live in Redis (via Vercel's Storage integration) instead of an in-process
// Map, keyed with a TTL.
const redis = new Redis({ url: config.redisUrl, token: config.redisToken });
const TTL_SECONDS = 30 * 60; // entries expire 30 min after creation if never resolved
const TOPIC_ANSWER_TTL_SECONDS = 10 * 60; // shorter — waiting on a human to type a reply

// A poster that has already been uploaded to LinkedIn and is waiting on approval. Only the
// URN is kept, never the image bytes — Redis is sized for small values, and the bytes serve
// no further purpose once LinkedIn is holding them.
export interface DraftImage {
  urn: string;
  altText: string;
  headline: string;
}

export interface Draft {
  id: string;
  text: string;
  sources: { url: string; title: string }[]; // web search citations used to write this draft, if any
  image?: DraftImage; // absent when poster generation is off, or failed and wasn't retried
  topic: string;
  threadContext?: string;
  contentStyle: ContentStyle;
  messageTs: string; // ts of the Slack message showing the draft text, so regenerate can edit it in place
  channel: string;
  threadTs: string; // root of the Slack thread, so a redesigned poster can be posted back into it
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

export async function updateDraftText(id: string, text: string, sources: { url: string; title: string }[]): Promise<void> {
  const draft = await getDraft(id);
  if (!draft) return;
  await saveDraft({ ...draft, text, sources });
}

export async function updateDraftImage(id: string, image: DraftImage | undefined): Promise<void> {
  const draft = await getDraft(id);
  if (!draft) return;
  await saveDraft({ ...draft, image });
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
  durationDays: number; // window (from CALENDAR_DURATIONS) the weekday slots were counted within
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

// Bounded history of posts published through this bot, most-recent-first — real history,
// not transient state, so it's a plain Redis list rather than a TTL'd key. Editing a post
// re-pushes the updated entry rather than mutating the old one in place; the freshest
// version naturally sorts first and the stale duplicate ages out of the bounded list.
export interface PublishedPost {
  urn: string;
  text: string;
  publishedAt: number;
}

const PUBLISHED_POSTS_KEY = "published-posts";
const MAX_PUBLISHED_POSTS_HISTORY = 20;

export async function recordPublishedPost(post: PublishedPost): Promise<void> {
  await redis.lpush(PUBLISHED_POSTS_KEY, post);
  await redis.ltrim(PUBLISHED_POSTS_KEY, 0, MAX_PUBLISHED_POSTS_HISTORY - 1);
}

export async function listPublishedPosts(limit: number): Promise<PublishedPost[]> {
  return redis.lrange<PublishedPost>(PUBLISHED_POSTS_KEY, 0, limit - 1);
}

// Holds an "edit post" selection until the user's next message answers "what would you
// like to change?" — same channel+thread keying as AwaitingCalendarTopic, for the same
// reason (a plain text reply can't carry an id).
export interface AwaitingPostEditFeedback {
  channel: string;
  threadTs: string;
  requestedBy: string;
  urn: string;
  previousText: string;
  createdAt: number;
}

const awaitingPostEditKey = (channel: string, threadTs: string) => `awaiting-post-edit:${channel}:${threadTs}`;

export async function saveAwaitingPostEditFeedback(entry: AwaitingPostEditFeedback): Promise<void> {
  await redis.set(awaitingPostEditKey(entry.channel, entry.threadTs), entry, { ex: TOPIC_ANSWER_TTL_SECONDS });
}

export async function getAwaitingPostEditFeedback(channel: string, threadTs: string): Promise<AwaitingPostEditFeedback | undefined> {
  const entry = await redis.get<AwaitingPostEditFeedback>(awaitingPostEditKey(channel, threadTs));
  return entry ?? undefined;
}

export async function deleteAwaitingPostEditFeedback(channel: string, threadTs: string): Promise<void> {
  await redis.del(awaitingPostEditKey(channel, threadTs));
}

// A proposed rewrite of an already-published post, awaiting apply/revise-again/cancel.
export interface PendingPostEditReview {
  id: string;
  urn: string;
  previousText: string;
  proposedText: string;
  sources: { url: string; title: string }[];
  channel: string;
  threadTs: string;
  requestedBy: string;
  createdAt: number;
}

const postEditReviewKey = (id: string) => `post-edit-review:${id}`;

export async function savePostEditReview(review: PendingPostEditReview): Promise<void> {
  await redis.set(postEditReviewKey(review.id), review, { ex: TTL_SECONDS });
}

export async function getPostEditReview(id: string): Promise<PendingPostEditReview | undefined> {
  const review = await redis.get<PendingPostEditReview>(postEditReviewKey(id));
  return review ?? undefined;
}

export async function deletePostEditReview(id: string): Promise<void> {
  await redis.del(postEditReviewKey(id));
}
