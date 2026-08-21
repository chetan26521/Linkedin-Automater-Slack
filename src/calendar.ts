import { Client } from "@upstash/qstash";
import { config } from "./config.js";
import { generateFromPrompt, CONTENT_STYLES, type ContentStyle } from "./postWriter.js";
import type { CalendarPillar } from "./store.js";

export interface ContentPillar {
  pillar: string;
  prompt: string;
}

export type CalendarDuration = "weekly" | "monthly";

export const CALENDAR_DURATIONS: { duration: CalendarDuration; label: string; days: number }[] = [
  { duration: "weekly", label: "Weekly (next 7 days)", days: 7 },
  { duration: "monthly", label: "Monthly (next 4 weeks)", days: 28 },
];

/**
 * Breaks a topic into content pillars and produces exactly `postCount` posts total — the
 * count is dictated by how many weekday slots fall within the chosen weekly/monthly window
 * (see scheduledDatesInWindow), not chosen independently by the model, so every scheduled
 * slot gets a genuinely distinct post and the calendar comes out evenly filled.
 */
export async function generateContentPillars(topic: string, contentStyle: ContentStyle, postCount: number): Promise<ContentPillar[]> {
  const styleInstruction = CONTENT_STYLES.find((s) => s.style === contentStyle)?.instruction;

  const prompt = `You are a LinkedIn content strategist planning a content calendar.

Topic: "${topic}"
Content style for every post: ${styleInstruction}

You need to plan EXACTLY ${postCount} posts for this calendar. First identify the natural core
content pillars (distinct, non-overlapping angles) for this topic — typically 3 to 6, whatever
is genuinely natural for it. Then produce exactly ${postCount} posts total, each assigned to one
of those pillars — reusing a pillar across multiple posts when ${postCount} is larger than the
number of natural pillars, but always giving each post its own distinct, specific angle so posts
sharing a pillar never feel repetitive.

Output format — read carefully:
- Respond with ONLY a JSON array of exactly ${postCount} objects, nothing else. No preamble, no
  markdown fences, no commentary.
- Shape: [{"pillar": "<short pillar name>", "prompt": "<one-sentence writing prompt, self-contained>"}, ...]
- "pillar" must be plain text only — no emoji or decorative symbols (it's rendered in a
  fixed-width text calendar grid, where those break column alignment). "prompt" has no such
  restriction.`;

  const raw = await generateFromPrompt(prompt);
  // Strip a markdown code fence if the model wrapped the JSON in one despite instructions.
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse content pillars — model returned non-JSON: ${raw.slice(0, 200)}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Model returned no content pillars.");
  }

  return parsed.map((p, i) => {
    if (typeof p?.pillar !== "string" || typeof p?.prompt !== "string") {
      throw new Error(`Malformed pillar at index ${i}: ${JSON.stringify(p)}`);
    }
    // Belt-and-braces: strip emoji/pictographs even though the prompt asks the model not
    // to include them — the fixed-width calendar grid's column alignment depends on it,
    // and models don't always follow formatting instructions (see the JSON-fence handling
    // above for the same lesson learned the hard way).
    return { pillar: stripPictographs(p.pillar), prompt: p.prompt };
  });
}

// Strips emoji/pictographs (and their joiners/modifiers) while leaving ordinary text —
// including accented letters — untouched. Only applied to the short pillar label used in
// the fixed-width calendar grid; the post-writing "prompt" field is left fully unrestricted.
const ZERO_WIDTH_JOINER = String.fromCharCode(0x200d);
const VARIATION_SELECTOR_16 = String.fromCharCode(0xfe0f);
const JOINER_AND_MODIFIER_PATTERN = new RegExp(`[${ZERO_WIDTH_JOINER}${VARIATION_SELECTOR_16}\\u{1F3FB}-\\u{1F3FF}]`, "gu");

function stripPictographs(s: string): string {
  return s
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(JOINER_AND_MODIFIER_PATTERN, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Returns every UTC epoch-second timestamp, in order, landing on the next occurrences of
 * `weekdays` (JS Date.getDay() numbering) within the next `windowDays` days, at `timeHHMM`
 * in the timezone implied by `tzOffsetSeconds` (captured once, at generation time — a fixed
 * offset rather than a full IANA-aware calculation, so a DST transition mid-calendar could
 * drift by an hour; an acceptable simplification for this internal tool).
 */
export function scheduledDatesInWindow(weekdays: number[], windowDays: number, timeHHMM: string, tzOffsetSeconds: number, from: Date = new Date()): number[] {
  if (weekdays.length === 0) throw new Error("At least one weekday must be selected.");

  const [hours, minutes] = timeHHMM.split(":").map(Number);
  const localNow = new Date(from.getTime() + tzOffsetSeconds * 1000);

  const results: number[] = [];
  const cursor = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()));
  cursor.setUTCDate(cursor.getUTCDate() + 1); // start looking from tomorrow, local time

  for (let i = 0; i < windowDays; i++) {
    if (weekdays.includes(cursor.getUTCDay())) {
      const localSlot = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), hours, minutes);
      results.push(Math.floor(localSlot / 1000) - tzOffsetSeconds);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  if (results.length === 0) {
    throw new Error("No dates fall in the selected window — check your weekday selection.");
  }

  return results;
}

// QStash caps how far in the future a single message's `notBefore` can be — observed in
// practice as "quota maxDelay exceeded, current limit: 604800" (exactly 7 days). A calendar
// entry further out than that can't be scheduled directly, so it's bundled into a "promote"
// job that re-runs scheduleCalendarEntries a bit under that limit later, which schedules
// whatever's now within range and re-defers the rest — self-chaining forward as many times
// as needed, entirely within QStash, until every entry has its own precise notBefore.
const QSTASH_MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;
const QSTASH_REQUEUE_SECONDS = 6 * 24 * 60 * 60; // re-check a day inside the limit, for safety margin

export interface CalendarPublishJob {
  type: "publish";
  topic: string;
  contentStyle: ContentStyle;
  channel: string;
  threadTs: string;
  requestedBy: string;
}

export interface CalendarPromoteJob {
  type: "promote";
  contentStyle: ContentStyle;
  channel: string;
  threadTs: string;
  requestedBy: string;
  remaining: CalendarPillar[];
}

export type CalendarJob = CalendarPublishJob | CalendarPromoteJob;

export interface CalendarScheduleContext {
  contentStyle: ContentStyle;
  channel: string;
  threadTs: string;
  requestedBy: string;
}

function assertQstashConfigured(): void {
  if (!config.qstashToken || !config.qstashCurrentSigningKey || !config.qstashNextSigningKey) {
    throw new Error(
      "QStash is not configured — set QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, and QSTASH_NEXT_SIGNING_KEY (from the Upstash console) to schedule a content calendar."
    );
  }
  if (!config.appBaseUrl) {
    throw new Error("APP_BASE_URL is not configured and VERCEL_URL is unavailable — can't build a callback URL for QStash to hit.");
  }
}

/**
 * Schedules calendar posts via QStash. Entries within QStash's max delay are scheduled
 * directly with their exact publish time; anything further out is bundled into a single
 * "promote" job that re-runs this same logic later (see QSTASH_REQUEUE_SECONDS above).
 */
export async function scheduleCalendarEntries(pillars: CalendarPillar[], context: CalendarScheduleContext): Promise<void> {
  assertQstashConfigured();
  const qstash = new Client({ token: config.qstashToken });
  const url = `${config.appBaseUrl}/api/calendar/publish`;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const dueSoon = pillars.filter((p) => p.scheduledAt - nowSeconds <= QSTASH_MAX_DELAY_SECONDS);
  const later = pillars.filter((p) => p.scheduledAt - nowSeconds > QSTASH_MAX_DELAY_SECONDS);

  await Promise.all(
    dueSoon.map((p) => {
      const job: CalendarPublishJob = {
        type: "publish",
        topic: p.prompt,
        contentStyle: context.contentStyle,
        channel: context.channel,
        threadTs: context.threadTs,
        requestedBy: context.requestedBy,
      };
      return qstash.publishJSON({ url, body: job, notBefore: p.scheduledAt });
    })
  );

  if (later.length > 0) {
    const job: CalendarPromoteJob = {
      type: "promote",
      contentStyle: context.contentStyle,
      channel: context.channel,
      threadTs: context.threadTs,
      requestedBy: context.requestedBy,
      remaining: later,
    };
    await qstash.publishJSON({ url, body: job, notBefore: nowSeconds + QSTASH_REQUEUE_SECONDS });
  }
}
