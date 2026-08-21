import { Client } from "@upstash/qstash";
import { config } from "./config.js";
import { generateFromPrompt, CONTENT_STYLES, type ContentStyle } from "./postWriter.js";

export interface ContentPillar {
  pillar: string;
  prompt: string;
}

/** Breaks a topic into its natural content pillars — one LinkedIn post per pillar. */
export async function generateContentPillars(topic: string, contentStyle: ContentStyle): Promise<ContentPillar[]> {
  const styleInstruction = CONTENT_STYLES.find((s) => s.style === contentStyle)?.instruction;

  const prompt = `You are a LinkedIn content strategist planning a short content calendar.

Topic: "${topic}"
Content style for every post: ${styleInstruction}

Identify the natural core content pillars (distinct, non-overlapping angles) for this topic —
whatever number is genuinely natural for it, typically between 3 and 6. For each pillar, write
a short pillar name and a one-sentence writing prompt describing what that specific post should
cover (this prompt will be handed to a writer with no other context, so make it self-contained).

Output format — read carefully:
- Respond with ONLY a JSON array, nothing else. No preamble, no markdown fences, no commentary.
- Shape: [{"pillar": "<short pillar name>", "prompt": "<one-sentence writing prompt>"}, ...]`;

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
    return { pillar: p.pillar, prompt: p.prompt };
  });
}

/**
 * Returns `count` future UTC epoch-second timestamps, one per pillar, landing on the next
 * occurrences of `weekdays` (JS Date.getDay() numbering) at `timeHHMM` in the timezone
 * implied by `tzOffsetSeconds` (captured once, at generation time — a fixed offset rather
 * than a full IANA-aware calculation, so a DST transition mid-calendar could drift by an
 * hour; an acceptable simplification for this internal tool).
 */
export function nextScheduledDates(weekdays: number[], count: number, timeHHMM: string, tzOffsetSeconds: number, from: Date = new Date()): number[] {
  if (weekdays.length === 0) throw new Error("At least one weekday must be selected.");

  const [hours, minutes] = timeHHMM.split(":").map(Number);
  const localNow = new Date(from.getTime() + tzOffsetSeconds * 1000);

  const results: number[] = [];
  const cursor = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()));
  cursor.setUTCDate(cursor.getUTCDate() + 1); // start looking from tomorrow, local time

  while (results.length < count) {
    if (weekdays.includes(cursor.getUTCDay())) {
      const localSlot = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate(), hours, minutes);
      results.push(Math.floor(localSlot / 1000) - tzOffsetSeconds);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return results;
}

export interface CalendarPublishJob {
  topic: string;
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

/** Schedules a single calendar entry to fire (generate + send to Slack for confirmation) via QStash. */
export async function scheduleCalendarEntry(runAt: number, job: CalendarPublishJob): Promise<void> {
  assertQstashConfigured();
  const qstash = new Client({ token: config.qstashToken });

  await qstash.publishJSON({
    url: `${config.appBaseUrl}/api/calendar/publish`,
    body: job,
    notBefore: runAt,
  });
}
