import Bolt from "@slack/bolt";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { generatePostText, CONTENT_STYLES, REFINEMENT_STYLES, type ContentStyle, type RefinementStyle } from "./postWriter.js";
import { publishPost } from "./linkedin.js";
import { saveDraft, getDraft, updateDraftText, deleteDraft, savePendingRequest, getPendingRequest, deletePendingRequest } from "./store.js";

const { App } = Bolt;

// Matches "create a post" anywhere in the message, case-insensitive.
const TRIGGER = new RegExp(config.triggerPhrase, "i");
// Strips a leading connector word left behind after the trigger phrase, e.g.
// "create a post on Zoho IoT" -> topic "Zoho IoT" instead of "on Zoho IoT".
const LEADING_CONNECTOR = /^(on|about|regarding|for)\s+/i;

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

export const app = new App({
  token: config.slackBotToken,
  appToken: config.slackAppToken,
  socketMode: true,
});

app.message(async ({ message, say, client }) => {
  const msg = message as any;
  if (msg.subtype || !msg.text || msg.bot_id) return;
  if (msg.channel !== config.slackChannelId) return; // only listen in the configured channel
  if (!TRIGGER.test(msg.text)) return; // only the "create a post" flow triggers anything

  const topic = msg.text.replace(TRIGGER, "").trim().replace(LEADING_CONNECTOR, "").trim() || msg.text;
  const threadTs = msg.thread_ts || msg.ts;

  try {
    let threadContext: string | undefined;
    if (msg.thread_ts) {
      const replies = await client.conversations.replies({ channel: msg.channel, ts: msg.thread_ts, limit: 20 });
      threadContext = (replies.messages ?? [])
        .filter((m) => m.ts !== msg.ts && m.text)
        .map((m) => m.text)
        .join("\n");
    }

    const pendingId = randomUUID();
    savePendingRequest({
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
    await say({ text: `Something went wrong: ${err.message}`, thread_ts: threadTs });
  }
});

app.action(/^style_(simple|technical|architectural|business)$/, async ({ ack, action, body, client }) => {
  await ack();
  const contentStyle = (action as any).action_id.replace("style_", "") as ContentStyle;
  const payload = body as any;
  const pendingId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  const pending = getPendingRequest(pendingId);
  if (!pending) {
    await client.chat.update({ channel, ts: messageTs, text: "This request expired — ask me to create a post again.", blocks: [] });
    return;
  }

  const styleLabel = CONTENT_STYLES.find((s) => s.style === contentStyle)?.label ?? contentStyle;
  await client.chat.update({ channel, ts: messageTs, text: `Drafting a ${styleLabel} post… :writing_hand:`, blocks: [] });

  try {
    const { postText } = await generatePostText(pending.topic, contentStyle, pending.threadContext);
    deletePendingRequest(pendingId);

    const draftId = randomUUID();
    const draftMessage = await client.chat.postMessage({
      channel,
      thread_ts: pending.threadTs,
      text: `*Draft LinkedIn post:*\n\n${postText}`,
    });

    saveDraft({
      id: draftId,
      text: postText,
      topic: pending.topic,
      threadContext: pending.threadContext,
      contentStyle,
      messageTs: draftMessage.ts as string,
      channel,
      requestedBy: pending.requestedBy,
      createdAt: Date.now(),
    });

    await client.chat.postMessage({
      channel,
      thread_ts: pending.threadTs,
      text: "Post the above to LinkedIn?",
      blocks: confirmBlocks(draftId),
    });

    await client.chat.update({ channel, ts: messageTs, text: `Drafted as a ${styleLabel} post.`, blocks: [] });
  } catch (err: any) {
    console.error(err);
    await client.chat.update({ channel, ts: messageTs, text: `Something went wrong drafting the post: ${err.message}`, blocks: [] });
  }
});

app.action("approve_post", async ({ ack, body, client }) => {
  await ack();
  const payload = body as any;
  const draftId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  const draft = getDraft(draftId);
  if (!draft) {
    await client.chat.postMessage({ channel, thread_ts: messageTs, text: "This draft expired — ask me to create a post again." });
    return;
  }

  await client.chat.update({ channel, ts: messageTs, text: "Posting to LinkedIn…", blocks: [] });

  try {
    await publishPost(draft.text);
    deleteDraft(draftId);
    await client.chat.postMessage({ channel, thread_ts: messageTs, text: "✅ Posted to LinkedIn." });
  } catch (err: any) {
    console.error(err);
    await client.chat.postMessage({ channel, thread_ts: messageTs, text: `❌ Failed to post to LinkedIn: ${err.message}` });
  }
});

app.action("reject_post", async ({ ack, body, client }) => {
  await ack();
  const payload = body as any;
  const draftId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  const draft = getDraft(draftId);
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
});

app.action(/^regenerate_(shorter|professional|punchier|different-angle)$/, async ({ ack, action, body, client }) => {
  await ack();
  const style = (action as any).action_id.replace("regenerate_", "") as RefinementStyle;
  const payload = body as any;
  const draftId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  const draft = getDraft(draftId);
  if (!draft) {
    await client.chat.update({ channel, ts: messageTs, text: "This draft expired — ask me to create a post again.", blocks: [] });
    return;
  }

  await client.chat.update({ channel, ts: messageTs, text: "Regenerating… :writing_hand:", blocks: [] });

  try {
    const { postText } = await generatePostText(draft.topic, draft.contentStyle, draft.threadContext, { style, previousText: draft.text });
    updateDraftText(draftId, postText);

    await client.chat.update({ channel, ts: draft.messageTs, text: `*Draft LinkedIn post:*\n\n${postText}` });
    await client.chat.update({ channel, ts: messageTs, text: "Post the above to LinkedIn?", blocks: confirmBlocks(draftId) });
  } catch (err: any) {
    console.error(err);
    await client.chat.update({ channel, ts: messageTs, text: `❌ Failed to regenerate: ${err.message}`, blocks: [] });
  }
});

app.action("dismiss_draft", async ({ ack, body, client }) => {
  await ack();
  const payload = body as any;
  const draftId = payload.actions[0].value as string;
  const channel = payload.channel.id as string;
  const messageTs = payload.message.ts as string;

  deleteDraft(draftId);
  await client.chat.update({ channel, ts: messageTs, text: "🗑️ Discarded — nothing was posted to LinkedIn.", blocks: [] });
});
