import Bolt from "@slack/bolt";
import { randomUUID } from "node:crypto";
import { waitUntil } from "@vercel/functions";
import { config } from "./config.js";
import { generatePostText, CONTENT_STYLES, REFINEMENT_STYLES, type ContentStyle, type RefinementStyle } from "./postWriter.js";
import { generateContentPillars, scheduledDatesInWindow, scheduleCalendarEntry, CALENDAR_DURATIONS } from "./calendar.js";
import { publishPost } from "./linkedin.js";
import {
  saveDraft,
  getDraft,
  updateDraftText,
  deleteDraft,
  savePendingRequest,
  getPendingRequest,
  deletePendingRequest,
  saveAwaitingCalendarTopic,
  getAwaitingCalendarTopic,
  deleteAwaitingCalendarTopic,
  saveCalendarReview,
  getCalendarReview,
  deleteCalendarReview,
  type AwaitingCalendarTopic,
  type CalendarPillar,
} from "./store.js";

const { App, ExpressReceiver } = Bolt;

// Matches "create a post" anywhere in the message, case-insensitive.
const TRIGGER = new RegExp(config.triggerPhrase, "i");
// Matches "content calendar" anywhere in the message, case-insensitive.
const CALENDAR_TRIGGER = new RegExp(config.calendarTriggerPhrase, "i");
// Strips a leading connector word left behind after the trigger phrase, e.g.
// "create a post on Zoho IoT" -> topic "Zoho IoT" instead of "on Zoho IoT".
const LEADING_CONNECTOR = /^(on|about|regarding|for)\s+/i;

const WEEKDAYS = [
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
  { label: "Sunday", value: "0" },
];

function styleBlocks(pendingId: string) {
  return [
    { type: "section" as const, text: { type: "mrkdwn" as const, text: "How should this post be written?" } },
    {
      type: "actions" as const,
      block_id: "linkedin_style",
      elements: CONTENT_STYLES.map((s) => ({
        type: "button" as const,
        text: { type: "plain_text" as const, text: s.label },
        action_id: `style_${s.style}`,
        value: pendingId,
      })),
    },
  ];
}

function confirmBlocks(draftId: string) {
  return [
    { type: "section" as const, text: { type: "mrkdwn" as const, text: "Post the above to LinkedIn?" } },
    {
      type: "actions" as const,
      block_id: "linkedin_confirm",
      elements: [
        { type: "button" as const, text: { type: "plain_text" as const, text: "✅ Post to LinkedIn" }, style: "primary" as const, action_id: "approve_post", value: draftId },
        { type: "button" as const, text: { type: "plain_text" as const, text: "❌ Reject" }, style: "danger" as const, action_id: "reject_post", value: draftId },
      ],
    },
  ];
}

function regenerateBlocks(draftId: string) {
  return [
    { type: "section" as const, text: { type: "mrkdwn" as const, text: "What would you like to change?" } },
    {
      type: "actions" as const,
      block_id: "linkedin_regenerate",
      elements: [
        ...REFINEMENT_STYLES.map((r) => ({
          type: "button" as const,
          text: { type: "plain_text" as const, text: r.label },
          action_id: `regenerate_${r.style}`,
          value: draftId,
        })),
        { type: "button" as const, text: { type: "plain_text" as const, text: "🗑️ Dismiss" }, style: "danger" as const, action_id: "dismiss_draft", value: draftId },
      ],
    },
  ];
}

// Slack's `actions` block only supports buttons/overflow/checkboxes/radio/select-menus —
// multi-select menus and timepickers are only valid as a `section` block's single
// `accessory`, so each field gets its own section here; the submit button is the only
// thing that actually goes in an `actions` block.
function calendarFormBlocks(pendingId: string) {
  return [
    {
      type: "section" as const,
      block_id: "calendar_style_block",
      text: { type: "mrkdwn" as const, text: "*Content style*" },
      accessory: {
        type: "static_select" as const,
        action_id: "calendar_style_select",
        placeholder: { type: "plain_text" as const, text: "Choose a style" },
        options: CONTENT_STYLES.map((s) => ({ text: { type: "plain_text" as const, text: s.label }, value: s.style })),
      },
    },
    {
      type: "section" as const,
      block_id: "calendar_weekday_block",
      text: { type: "mrkdwn" as const, text: "*Days to post*" },
      accessory: {
        type: "multi_static_select" as const,
        action_id: "calendar_weekday_select",
        placeholder: { type: "plain_text" as const, text: "Choose days" },
        options: WEEKDAYS.map((w) => ({ text: { type: "plain_text" as const, text: w.label }, value: w.value })),
      },
    },
    {
      type: "section" as const,
      block_id: "calendar_time_block",
      text: { type: "mrkdwn" as const, text: "*Time to post*" },
      accessory: {
        type: "timepicker" as const,
        action_id: "calendar_time_picker",
        placeholder: { type: "plain_text" as const, text: "Choose a time" },
      },
    },
    {
      type: "section" as const,
      block_id: "calendar_duration_block",
      text: { type: "mrkdwn" as const, text: "*Calendar length*" },
      accessory: {
        type: "static_select" as const,
        action_id: "calendar_duration_select",
        placeholder: { type: "plain_text" as const, text: "Weekly or monthly?" },
        options: CALENDAR_DURATIONS.map((d) => ({ text: { type: "plain_text" as const, text: d.label }, value: d.duration })),
      },
    },
    {
      type: "actions" as const,
      block_id: "calendar_generate_actions",
      elements: [
        {
          type: "button" as const,
          text: { type: "plain_text" as const, text: "📅 Generate Calendar" },
          style: "primary" as const,
          action_id: "calendar_generate_submit",
          value: pendingId,
        },
      ],
    },
  ];
}

function calendarReviewBlocks(reviewId: string, summaryText: string) {
  return [
    { type: "section" as const, text: { type: "mrkdwn" as const, text: summaryText } },
    {
      type: "actions" as const,
      block_id: "calendar_review_actions",
      elements: [
        { type: "button" as const, text: { type: "plain_text" as const, text: "✅ Approve & Schedule" }, style: "primary" as const, action_id: "approve_calendar", value: reviewId },
        { type: "button" as const, text: { type: "plain_text" as const, text: "🔄 Regenerate" }, action_id: "regenerate_calendar", value: reviewId },
        { type: "button" as const, text: { type: "plain_text" as const, text: "🗑️ Dismiss" }, style: "danger" as const, action_id: "dismiss_calendar", value: reviewId },
      ],
    },
  ];
}

// Renders an epoch-seconds timestamp back into the requester's local wall-clock time,
// using the same fixed tz-offset trick as calendar.ts's scheduledDatesInWindow.
function formatScheduledDate(epochSeconds: number, tzOffsetSeconds: number): string {
  const local = new Date((epochSeconds + tzOffsetSeconds) * 1000);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hours24 = local.getUTCHours();
  const minutes = local.getUTCMinutes().toString().padStart(2, "0");
  const hours12 = ((hours24 + 11) % 12) + 1;
  const ampm = hours24 < 12 ? "AM" : "PM";
  return `${days[local.getUTCDay()]}, ${months[local.getUTCMonth()]} ${local.getUTCDate()} at ${hours12}:${minutes} ${ampm}`;
}

function calendarSummaryText(topic: string, contentStyle: ContentStyle, durationDays: number, pillars: CalendarPillar[], tzOffsetSeconds: number): string {
  const styleLabel = CONTENT_STYLES.find((s) => s.style === contentStyle)?.label ?? contentStyle;
  const durationLabel = CALENDAR_DURATIONS.find((d) => d.days === durationDays)?.label ?? `${durationDays}-day`;
  const lines = pillars.map((p, i) => `${i + 1}. *${formatScheduledDate(p.scheduledAt, tzOffsetSeconds)}* — ${p.pillar}`);
  return `*Content calendar: ${topic}* (${styleLabel}, ${durationLabel})\n\n${lines.join("\n")}\n\nApprove to schedule these ${pillars.length} posts — each will be generated and sent here for confirmation on its date.`;
}

// ExpressReceiver over Slack's HTTP Events API + Interactivity, instead of Socket Mode —
// a Vercel serverless function can't hold a persistent WebSocket connection open.
export const receiver = new ExpressReceiver({
  signingSecret: config.slackSigningSecret,
  endpoints: "/api/slack/events",
});

export const app = new App({
  token: config.slackBotToken,
  receiver,
});

// Bolt sends the required HTTP 200 for events as soon as the payload is verified,
// before this listener runs — so everything below is already "after the response"
// and must be wrapped in waitUntil() to survive on a serverless function. Same
// reasoning applies to every action handler below, right after ack().
app.message(async ({ message, client }) => {
  const msg = message as any;
  if (msg.subtype || !msg.text || msg.bot_id) return;
  if (msg.channel !== config.slackChannelId) return; // only listen in the configured channel

  waitUntil(routeMessage(msg, client));
});

// Checked in priority order: a fresh "content calendar" trigger, then whether this message
// is the answer to a pending "what topic?" question, then the existing "create a post" flow.
async function routeMessage(msg: any, client: any) {
  if (CALENDAR_TRIGGER.test(msg.text)) {
    await handleCalendarTrigger(msg, client);
    return;
  }

  if (msg.thread_ts) {
    const awaiting = await getAwaitingCalendarTopic(msg.channel, msg.thread_ts);
    if (awaiting && awaiting.requestedBy === msg.user) {
      await deleteAwaitingCalendarTopic(msg.channel, msg.thread_ts);
      await handleCalendarTopicProvided(awaiting, msg.text, client);
      return;
    }
  }

  if (TRIGGER.test(msg.text)) {
    await handleTrigger(msg, client);
  }
}

async function handleCalendarTrigger(msg: any, client: any) {
  const threadTs = msg.thread_ts || msg.ts;

  try {
    await saveAwaitingCalendarTopic({
      channel: msg.channel,
      threadTs,
      requestedBy: msg.user,
      createdAt: Date.now(),
    });

    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: "What topic should this content calendar be about?",
    });
  } catch (err: any) {
    console.error(err);
    await client.chat.postMessage({ channel: msg.channel, thread_ts: threadTs, text: `Something went wrong: ${err.message}` });
  }
}

async function handleCalendarTopicProvided(awaiting: AwaitingCalendarTopic, topic: string, client: any) {
  try {
    const pendingId = randomUUID();
    await savePendingRequest({
      id: pendingId,
      topic,
      channel: awaiting.channel,
      threadTs: awaiting.threadTs,
      requestedBy: awaiting.requestedBy,
      createdAt: Date.now(),
    });

    await client.chat.postMessage({
      channel: awaiting.channel,
      thread_ts: awaiting.threadTs,
      text: "Pick a content style, which days to post, and what time — then generate the calendar.",
      blocks: calendarFormBlocks(pendingId),
    });
  } catch (err: any) {
    console.error(err);
    await client.chat.postMessage({ channel: awaiting.channel, thread_ts: awaiting.threadTs, text: `Something went wrong: ${err.message}` });
  }
}

app.action("calendar_generate_submit", async ({ ack, body, client }) => {
  await ack();
  const payload = body as any;
  const pendingId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;
  const values = payload.state?.values ?? {};

  waitUntil(handleGenerateCalendar(pendingId, values, channel, messageTs, client));
});

async function handleGenerateCalendar(pendingId: string, values: any, channel: string, messageTs: string, client: any) {
  const pending = await getPendingRequest(pendingId);
  if (!pending) {
    await client.chat.update({ channel, ts: messageTs, text: "This request expired — ask me for a content calendar again.", blocks: [] });
    return;
  }

  // Each field lives under its own block_id (section accessories, not one shared actions
  // block), so state.values is keyed per-field rather than all under one block.
  const contentStyle = values.calendar_style_block?.calendar_style_select?.selected_option?.value as ContentStyle | undefined;
  const weekdays: number[] = (values.calendar_weekday_block?.calendar_weekday_select?.selected_options ?? []).map((o: any) => Number(o.value));
  const timeHHMM = values.calendar_time_block?.calendar_time_picker?.selected_time as string | undefined;
  const durationValue = values.calendar_duration_block?.calendar_duration_select?.selected_option?.value as string | undefined;
  const durationDays = CALENDAR_DURATIONS.find((d) => d.duration === durationValue)?.days;

  if (!contentStyle || weekdays.length === 0 || !timeHHMM || !durationDays) {
    await client.chat.postMessage({
      channel,
      thread_ts: pending.threadTs,
      text: "Please pick a content style, at least one day, a time, and weekly/monthly, then click Generate Calendar again.",
    });
    return;
  }

  await client.chat.update({ channel, ts: messageTs, text: "Building your content calendar… :writing_hand:", blocks: [] });

  try {
    const userInfo = await client.users.info({ user: pending.requestedBy });
    const tzOffsetSeconds: number = userInfo.user?.tz_offset ?? 0;

    const pillars = await buildCalendarPillars(pending.topic, contentStyle, weekdays, durationDays, timeHHMM, tzOffsetSeconds);

    const reviewId = randomUUID();
    await saveCalendarReview({
      id: reviewId,
      topic: pending.topic,
      contentStyle,
      weekdays,
      timeHHMM,
      tzOffsetSeconds,
      durationDays,
      pillars,
      channel,
      threadTs: pending.threadTs,
      requestedBy: pending.requestedBy,
      createdAt: Date.now(),
    });
    await deletePendingRequest(pendingId);

    await client.chat.update({
      channel,
      ts: messageTs,
      text: calendarSummaryText(pending.topic, contentStyle, durationDays, pillars, tzOffsetSeconds),
      blocks: calendarReviewBlocks(reviewId, calendarSummaryText(pending.topic, contentStyle, durationDays, pillars, tzOffsetSeconds)),
    });
  } catch (err: any) {
    console.error(err);
    await client.chat.update({ channel, ts: messageTs, text: `Something went wrong building the calendar: ${err.message}`, blocks: [] });
  }
}

// Computes the exact weekday slots within the chosen weekly/monthly window, then asks the
// LLM for exactly that many posts — the schedule (not the model) decides the post count, so
// the calendar always comes out fully and evenly filled for the window the user picked.
async function buildCalendarPillars(
  topic: string,
  contentStyle: ContentStyle,
  weekdays: number[],
  durationDays: number,
  timeHHMM: string,
  tzOffsetSeconds: number
): Promise<CalendarPillar[]> {
  const dates = scheduledDatesInWindow(weekdays, durationDays, timeHHMM, tzOffsetSeconds);
  const rawPillars = await generateContentPillars(topic, contentStyle, dates.length);
  // Defensive: models don't always return the exact count asked for — pair up only what
  // both arrays actually have rather than crashing on an index past either end.
  const count = Math.min(rawPillars.length, dates.length);
  return rawPillars.slice(0, count).map((p, i) => ({ ...p, scheduledAt: dates[i] }));
}

app.action("approve_calendar", async ({ ack, body, client }) => {
  await ack();
  const payload = body as any;
  const reviewId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  waitUntil(handleApproveCalendar(reviewId, channel, messageTs, client));
});

async function handleApproveCalendar(reviewId: string, channel: string, messageTs: string, client: any) {
  const review = await getCalendarReview(reviewId);
  if (!review) {
    await client.chat.update({ channel, ts: messageTs, text: "This calendar expired — ask me for a content calendar again.", blocks: [] });
    return;
  }

  await client.chat.update({ channel, ts: messageTs, text: "Scheduling…", blocks: [] });

  try {
    for (const pillar of review.pillars) {
      await scheduleCalendarEntry(pillar.scheduledAt, {
        topic: pillar.prompt,
        contentStyle: review.contentStyle,
        channel: review.channel,
        threadTs: review.threadTs,
        requestedBy: review.requestedBy,
      });
    }
    await deleteCalendarReview(reviewId);

    const first = formatScheduledDate(review.pillars[0].scheduledAt, review.tzOffsetSeconds);
    const last = formatScheduledDate(review.pillars[review.pillars.length - 1].scheduledAt, review.tzOffsetSeconds);
    await client.chat.update({
      channel,
      ts: messageTs,
      text: `✅ Scheduled ${review.pillars.length} posts, from ${first} to ${last}. Each will be sent here for confirmation on its date.`,
      blocks: [],
    });
  } catch (err: any) {
    console.error(err);
    await client.chat.update({ channel, ts: messageTs, text: `❌ Failed to schedule: ${err.message}`, blocks: [] });
  }
}

app.action("regenerate_calendar", async ({ ack, body, client }) => {
  await ack();
  const payload = body as any;
  const reviewId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  waitUntil(handleRegenerateCalendar(reviewId, channel, messageTs, client));
});

async function handleRegenerateCalendar(reviewId: string, channel: string, messageTs: string, client: any) {
  const review = await getCalendarReview(reviewId);
  if (!review) {
    await client.chat.update({ channel, ts: messageTs, text: "This calendar expired — ask me for a content calendar again.", blocks: [] });
    return;
  }

  await client.chat.update({ channel, ts: messageTs, text: "Regenerating the calendar… :writing_hand:", blocks: [] });

  try {
    const pillars = await buildCalendarPillars(review.topic, review.contentStyle, review.weekdays, review.durationDays, review.timeHHMM, review.tzOffsetSeconds);

    await saveCalendarReview({ ...review, pillars });

    await client.chat.update({
      channel,
      ts: messageTs,
      text: calendarSummaryText(review.topic, review.contentStyle, review.durationDays, pillars, review.tzOffsetSeconds),
      blocks: calendarReviewBlocks(reviewId, calendarSummaryText(review.topic, review.contentStyle, review.durationDays, pillars, review.tzOffsetSeconds)),
    });
  } catch (err: any) {
    console.error(err);
    await client.chat.update({ channel, ts: messageTs, text: `❌ Failed to regenerate: ${err.message}`, blocks: [] });
  }
}

app.action("dismiss_calendar", async ({ ack, body, client }) => {
  await ack();
  const payload = body as any;
  const reviewId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  waitUntil(handleDismissCalendar(reviewId, channel, messageTs, client));
});

async function handleDismissCalendar(reviewId: string, channel: string, messageTs: string, client: any) {
  await deleteCalendarReview(reviewId);
  await client.chat.update({ channel, ts: messageTs, text: "🗑️ Calendar discarded — nothing was scheduled.", blocks: [] });
}

async function handleTrigger(msg: any, client: any) {
  const topic = msg.text.replace(TRIGGER, "").trim().replace(LEADING_CONNECTOR, "").trim() || msg.text;
  const threadTs = msg.thread_ts || msg.ts;

  try {
    let threadContext: string | undefined;
    if (msg.thread_ts) {
      const replies = await client.conversations.replies({ channel: msg.channel, ts: msg.thread_ts, limit: 20 });
      threadContext = (replies.messages ?? [])
        .filter((m: any) => m.ts !== msg.ts && m.text)
        .map((m: any) => m.text)
        .join("\n");
    }

    const pendingId = randomUUID();
    await savePendingRequest({
      id: pendingId,
      topic,
      threadContext,
      channel: msg.channel,
      threadTs,
      requestedBy: msg.user,
      createdAt: Date.now(),
    });

    await client.chat.postMessage({
      channel: msg.channel,
      thread_ts: threadTs,
      text: "How should this post be written?",
      blocks: styleBlocks(pendingId),
    });
  } catch (err: any) {
    console.error(err);
    await client.chat.postMessage({ channel: msg.channel, thread_ts: threadTs, text: `Something went wrong: ${err.message}` });
  }
}

app.action(/^style_(simple|technical|architectural|business)$/, async ({ ack, action, body, client }) => {
  await ack();
  const contentStyle = (action as any).action_id.replace("style_", "") as ContentStyle;
  const payload = body as any;
  const pendingId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  waitUntil(handleStyleSelected(contentStyle, pendingId, channel, messageTs, client));
});

// Generates a post, saves it as a Draft, and posts both the draft text and the
// approve/reject buttons to Slack. Shared by the interactive "create a post" flow and
// the QStash-triggered content-calendar publish webhook (api/calendar/publish.ts).
export async function createDraftAndPostConfirmation(
  client: any,
  params: { topic: string; contentStyle: ContentStyle; threadContext?: string; channel: string; threadTs: string; requestedBy: string }
): Promise<void> {
  const { topic, contentStyle, threadContext, channel, threadTs, requestedBy } = params;
  const { postText } = await generatePostText(topic, contentStyle, threadContext);

  const draftId = randomUUID();
  const draftMessage = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: `*Draft LinkedIn post:*\n\n${postText}`,
  });

  await saveDraft({
    id: draftId,
    text: postText,
    topic,
    threadContext,
    contentStyle,
    messageTs: draftMessage.ts as string,
    channel,
    requestedBy,
    createdAt: Date.now(),
  });

  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: "Post the above to LinkedIn?",
    blocks: confirmBlocks(draftId),
  });
}

async function handleStyleSelected(contentStyle: ContentStyle, pendingId: string, channel: string, messageTs: string, client: any) {
  const pending = await getPendingRequest(pendingId);
  if (!pending) {
    await client.chat.update({ channel, ts: messageTs, text: "This request expired — ask me to create a post again.", blocks: [] });
    return;
  }

  const styleLabel = CONTENT_STYLES.find((s) => s.style === contentStyle)?.label ?? contentStyle;
  await client.chat.update({ channel, ts: messageTs, text: `Drafting a ${styleLabel} post… :writing_hand:`, blocks: [] });

  try {
    await createDraftAndPostConfirmation(client, {
      topic: pending.topic,
      contentStyle,
      threadContext: pending.threadContext,
      channel,
      threadTs: pending.threadTs,
      requestedBy: pending.requestedBy,
    });
    await deletePendingRequest(pendingId);

    await client.chat.update({ channel, ts: messageTs, text: `Drafted as a ${styleLabel} post.`, blocks: [] });
  } catch (err: any) {
    console.error(err);
    await client.chat.update({ channel, ts: messageTs, text: `Something went wrong drafting the post: ${err.message}`, blocks: [] });
  }
}

app.action("approve_post", async ({ ack, body, client }) => {
  await ack();
  const payload = body as any;
  const draftId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  waitUntil(handleApprove(draftId, channel, messageTs, client));
});

async function handleApprove(draftId: string, channel: string, messageTs: string, client: any) {
  const draft = await getDraft(draftId);
  if (!draft) {
    await client.chat.postMessage({ channel, thread_ts: messageTs, text: "This draft expired — ask me to create a post again." });
    return;
  }

  await client.chat.update({ channel, ts: messageTs, text: "Posting to LinkedIn…", blocks: [] });

  try {
    await publishPost(draft.text);
    await deleteDraft(draftId);
    await client.chat.postMessage({ channel, thread_ts: messageTs, text: "✅ Posted to LinkedIn." });
  } catch (err: any) {
    console.error(err);
    await client.chat.postMessage({ channel, thread_ts: messageTs, text: `❌ Failed to post to LinkedIn: ${err.message}` });
  }
}

app.action("reject_post", async ({ ack, body, client }) => {
  await ack();
  const payload = body as any;
  const draftId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  waitUntil(handleReject(draftId, channel, messageTs, client));
});

async function handleReject(draftId: string, channel: string, messageTs: string, client: any) {
  const draft = await getDraft(draftId);
  if (!draft) {
    await client.chat.update({ channel, ts: messageTs, text: "This draft expired — ask me to create a post again.", blocks: [] });
    return;
  }

  await client.chat.update({
    channel,
    ts: messageTs,
    text: "What would you like to change?",
    blocks: regenerateBlocks(draftId),
  });
}

app.action(/^regenerate_(shorter|professional|punchier|different-angle)$/, async ({ ack, action, body, client }) => {
  await ack();
  const style = (action as any).action_id.replace("regenerate_", "") as RefinementStyle;
  const payload = body as any;
  const draftId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  waitUntil(handleRegenerate(style, draftId, channel, messageTs, client));
});

async function handleRegenerate(style: RefinementStyle, draftId: string, channel: string, messageTs: string, client: any) {
  const draft = await getDraft(draftId);
  if (!draft) {
    await client.chat.update({ channel, ts: messageTs, text: "This draft expired — ask me to create a post again.", blocks: [] });
    return;
  }

  await client.chat.update({ channel, ts: messageTs, text: "Regenerating… :writing_hand:", blocks: [] });

  try {
    const { postText } = await generatePostText(draft.topic, draft.contentStyle, draft.threadContext, { style, previousText: draft.text });
    await updateDraftText(draftId, postText);

    await client.chat.update({ channel, ts: draft.messageTs, text: `*Draft LinkedIn post:*\n\n${postText}` });
    await client.chat.update({ channel, ts: messageTs, text: "Post the above to LinkedIn?", blocks: confirmBlocks(draftId) });
  } catch (err: any) {
    console.error(err);
    await client.chat.update({ channel, ts: messageTs, text: `❌ Failed to regenerate: ${err.message}`, blocks: [] });
  }
}

app.action("dismiss_draft", async ({ ack, body, client }) => {
  await ack();
  const payload = body as any;
  const draftId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  waitUntil(handleDismiss(draftId, channel, messageTs, client));
});

async function handleDismiss(draftId: string, channel: string, messageTs: string, client: any) {
  await deleteDraft(draftId);
  await client.chat.update({ channel, ts: messageTs, text: "🗑️ Discarded — nothing was posted to LinkedIn.", blocks: [] });
}
