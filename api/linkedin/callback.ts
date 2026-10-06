import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../../src/config.js";
import { app } from "../../src/slackApp.js";
import { completeConnection, consumeOAuthState } from "../../src/linkedinAccounts.js";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

// Looked up once per warm instance — the workspace never changes for this bot.
let teamIdPromise: Promise<string | undefined> | undefined;
function workspaceTeamId(): Promise<string | undefined> {
  teamIdPromise ??= app.client.auth
    .test()
    .then((r) => r.team_id)
    .catch((err) => {
      console.error("Couldn't look up the Slack workspace id:", err);
      teamIdPromise = undefined;
      return undefined;
    });
  return teamIdPromise;
}

// Slack's own redirect link: opens the channel in the Slack desktop/mobile app if it's
// installed, or in Slack on the web otherwise.
async function slackChannelUrl(): Promise<string> {
  const params = new URLSearchParams({ channel: config.slackChannelId });
  const teamId = await workspaceTeamId();
  if (teamId) params.set("team", teamId);
  return `https://slack.com/app_redirect?${params}`;
}

/**
 * Every page this endpoint shows ends with a way back to the Slack channel, since that's where
 * the user actually works. On success it first tries to close the tab outright; browsers only
 * allow that for windows a script opened (not ones Slack opened), so when the close is ignored
 * it falls through to sending them back to Slack instead. The <noscript> refresh covers
 * browsers with JavaScript off.
 */
async function page(res: ServerResponse, status: number, title: string, message: string, options: { autoReturn?: boolean } = {}) {
  const slackUrl = escapeHtml(await slackChannelUrl());
  const refresh = options.autoReturn
    ? `<noscript><meta http-equiv="refresh" content="2;url=${slackUrl}"></noscript>
<script>
setTimeout(function () {
  window.close();
  // Still here a moment later means the browser refused to close the tab.
  setTimeout(function () { window.location.href = ${JSON.stringify(await slackChannelUrl())}; }, 300);
}, 1500);
</script>`
    : "";
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh}<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5;color:#1d1d1f;background:#fff}
h1{font-size:1.4rem}
a.button{display:inline-block;margin-top:1rem;padding:.7rem 1.2rem;border-radius:8px;background:#4a154b;color:#fff;text-decoration:none;font-weight:600}
.hint{color:#6e6e73;font-size:.9rem}
</style>
</head><body>
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<a class="button" href="${slackUrl}">Back to Slack</a>
${options.autoReturn ? `<p class="hint">Taking you back to Slack…</p>` : ""}
</body></html>`);
}

// LinkedIn redirects here after someone approves the "connect linkedin" link the bot gave
// them in Slack. The `state` param maps back to the Slack user that link was issued to —
// that, not anything LinkedIn says, decides whose Slack identity this LinkedIn account
// gets attached to.
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://localhost");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");

  if (error) {
    await page(res, 400, "LinkedIn wasn't connected", `LinkedIn said: ${error}. Go back to Slack and say "${config.connectTriggerPhrase}" to try again.`);
    return;
  }

  if (!code || !state) {
    await page(res, 400, "Invalid link", `This link is missing information. Go back to Slack and say "${config.connectTriggerPhrase}" for a fresh one.`);
    return;
  }

  const slackUserId = await consumeOAuthState(state);
  if (!slackUserId) {
    await page(res, 400, "This link has expired", `Connect links work once and expire after 15 minutes. Say "${config.connectTriggerPhrase}" in Slack for a new one.`);
    return;
  }

  try {
    const account = await completeConnection(slackUserId, code);

    try {
      await app.client.chat.postEphemeral({
        channel: config.slackChannelId,
        user: slackUserId,
        text: `✅ LinkedIn connected as *${account.name}*. You're all set. Say "${config.triggerPhrase} about ..." and the post will go to your profile.`,
      });
    } catch (err) {
      // The connection itself succeeded — a missed Slack confirmation isn't worth failing over.
      console.error("Connected LinkedIn but couldn't confirm in Slack:", err);
    }

    await page(res, 200, "LinkedIn connected", `You're connected as ${account.name}. Head back to Slack and say "${config.triggerPhrase} about ..." to get started.`, { autoReturn: true });
  } catch (err: any) {
    console.error("LinkedIn connection failed:", err);
    await page(res, 500, "Something went wrong", `${err.message}. Say "${config.connectTriggerPhrase}" in Slack to try again.`);
  }
}
