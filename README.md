# LinkedIn post bot for Slack

Say **"create a post: <topic>"** in a Slack channel the bot is in. It will:

1. Ask how the post should be written: **🧩 Simple**, **⚙️ Technical**, **🏗️ Architectural**, or **💼 Business**.
2. Draft LinkedIn post copy in that style with your configured LLM provider ([OpenRouter](https://openrouter.ai), OpenAI, or Anthropic), based on your message (and thread, if replying in one).
3. Post the exact draft text back to Slack with **✅ Post to LinkedIn** / **❌ Reject** buttons.
4. Only publish to your LinkedIn profile if you click **Post to LinkedIn**. Ignoring it entirely means nothing is ever posted (both the pending style request and any draft expire after 30 minutes).
5. Clicking **❌ Reject** doesn't discard anything yet — it shows a follow-up: **📏 Shorter**, **👔 More Professional**, **🔥 Punchier**, **🔀 Different Angle**, or **🗑️ Dismiss**. Picking a style regenerates the post (same topic/thread context/content style, revised per that feedback) and shows the Post/Reject buttons again — you can loop through as many regenerations as you like. **Dismiss** is the only action that actually throws the draft away.

No message without "create a post" in it does anything — the bot ignores all other channel chatter.

## 1. Install dependencies

```
npm install
```

## 2. Pick a text-generation provider

Set `LLM_PROVIDER` in `.env` to one of `openrouter`, `openai`, or `anthropic`, and fill in only that provider's key:

- **openrouter** (default, free) — sign up at https://openrouter.ai/keys (email or GitHub, no card required), copy the key as `OPENROUTER_API_KEY`. The default model (`nvidia/nemotron-3-ultra-550b-a55b:free`) is free and currently the strongest free option, but free models rotate occasionally without notice. If drafting starts failing (404/error on the model id), check https://openrouter.ai/models?max_price=0 for a current free model and set `OPENROUTER_MODEL`. `z-ai/glm-5.2:free` is a solid, faster fallback if Nemotron Ultra is ever slow or rate-limited. Free-tier limits: 20 requests/min, 50 requests/day with no credits, 1,000/day after a one-time $10 credit purchase (credits don't expire).
- **openai** — get a key at https://platform.openai.com/api-keys, copy it as `OPENAI_API_KEY`. Optionally set `OPENAI_MODEL` (default `gpt-4o-mini`).
- **anthropic** — get a key at https://console.anthropic.com/settings/keys, copy it as `ANTHROPIC_API_KEY`. Optionally set `ANTHROPIC_MODEL` (default `claude-sonnet-5`).

Both openai and anthropic are paid (no free tier); openrouter's default model is free.

## 3. Create the Slack app

The bot runs over Slack's HTTP Events API + Interactivity (no Socket Mode) so it can run as a Vercel serverless function — Slack needs a public HTTPS URL to send requests to, which means the app must already be deployed (or tunneled, for local dev — see step 6) before you can finish this section.

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**.
2. **Signing Secret**: under *Settings → Basic Information → App Credentials*, copy the **Signing Secret** as `SLACK_SIGNING_SECRET`.
3. **Bot Token Scopes**: under *Features → OAuth & Permissions*, add:
   - `chat:write`
   - `channels:history` (and `groups:history` / `im:history` if you'll use private channels or DMs)
4. **Event Subscriptions**: turn on, set the **Request URL** to `https://<your-deployment>/api/slack/events` (Slack verifies this URL immediately, so it must be live first), then subscribe to bot event `message.channels` (add `message.groups` / `message.im` as needed).
5. **Interactivity**: turn on, set the **Request URL** to the same `https://<your-deployment>/api/slack/events`.
6. Install the app to your workspace, copy the **Bot User OAuth Token** as `SLACK_BOT_TOKEN`.
7. Invite the bot to the channel you'll post from: `/invite @your-bot-name`.
8. Get that channel's ID (right-click the channel → **View channel details** → ID is at the bottom of the panel, or it's the `C...`/`D...` segment in the channel's URL) and set it as `SLACK_CHANNEL_ID`. The bot ignores messages from every other channel.

## 4. Create the LinkedIn app

1. Go to https://www.linkedin.com/developers/apps → **Create app**, attach it to a LinkedIn Page you administer (required by LinkedIn even for posting as yourself).
2. Under **Products**, request:
   - **Sign In with LinkedIn using OpenID Connect** (self-serve, instant)
   - **Share on LinkedIn** (self-serve, instant) — this grants `w_member_social`, needed to publish posts.
3. Under **Auth**, add `http://localhost:3000/callback` as an **Authorized redirect URL**.
4. Copy the **Client ID** and **Client Secret** into `.env`.

## 5. Fill in `.env`

```
cp .env.example .env
```

Fill in `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`, `LLM_PROVIDER` + its matching API key, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`. Leave `UPSTASH_REDIS_REST_URL`/`_TOKEN` for step 6.

Then run the one-time LinkedIn connect script:

```
npm run linkedin-auth
```

Open the printed URL, approve access, and copy the `LINKEDIN_ACCESS_TOKEN` / `LINKEDIN_PERSON_ID` it prints into `.env`.

> LinkedIn access tokens last ~60 days. When posting starts failing with an auth error, just re-run `npm run linkedin-auth`.

## 6. Deploy to Vercel

Drafts and pending style requests are stored in Redis (not in memory), since a serverless function has no persistent memory between invocations — so a Redis database has to exist before the bot can work at all, including locally.

1. Create a free Redis database — either via your Vercel project's **Storage** tab → **Create Database** → **Redis** (Upstash's Marketplace integration includes a free tier), or directly at https://console.upstash.com (sign up, no card required — free tier is 256 MB / 500K commands per month, comfortably more than this bot needs). Either way you end up with `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`; if created via Vercel's Storage tab these are injected into your project automatically, otherwise copy them from the database's **REST API** section into your local `.env` and add them to Vercel's env vars yourself. The code doesn't care which path you used — it just reads those two env var names.
2. Push this repo to GitHub (already done if you're reading this from the repo) and import it into Vercel: https://vercel.com/new.
3. In **Settings → Environment Variables**, add `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, plus everything else from your `.env`: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`, `LLM_PROVIDER` + its key, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_ID` (and `TRIGGER_PHRASE` if you changed it). Skip `PORT` — that's local-only.
4. Deploy. Note the deployment URL (e.g. `https://your-app.vercel.app`).
5. Go back to your Slack app's **Event Subscriptions** and **Interactivity** settings (step 3) and set both Request URLs to `https://your-app.vercel.app/api/slack/events`, now that it's live. Slack will verify the URL on save.
6. For local dev, your `.env` already has the Upstash values from step 1 above. To let Slack reach your machine for local testing, tunnel it (e.g. `ngrok http 3000`) and temporarily point the Slack Request URLs at the tunnel's `/api/slack/events` instead.

The `maxDuration` for the function is set to 60s in [vercel.json](vercel.json) — LLM generation and LinkedIn publishing can both take a few seconds, and this needs enough headroom to not get cut off mid-request. Increase it if you're on a plan that allows longer, or if a slower model needs more room.

## 7. Run it

```
npm run dev
```

Then in Slack: `create a post: we just shipped X, here's why it matters`

## Notes / things to check before relying on this

- LinkedIn bumps its API version string monthly (`LINKEDIN_VERSION` in [src/linkedin.ts](src/linkedin.ts)). If publishing starts failing with a version-related error, check LinkedIn's current version at https://learn.microsoft.com/en-us/linkedin/marketing/versioning and update it.
- Pending style requests and drafts (text only) live in Redis with a 30-minute TTL, keyed by an id on the Slack buttons. If you never click through, they just expire — you'd ask it to create the post again.
- This is scoped to your personal LinkedIn profile (`w_member_social`). Posting to a company Page needs the `w_organization_social` scope and admin access to that Page, which isn't wired up here.
- The trigger phrase is `"create a post"` (case-insensitive substring match), configurable via `TRIGGER_PHRASE` in `.env`.
- OpenRouter's free models can be lower quality than paid ones and occasionally get rate-limited or rotated out (see step 2). Switching `LLM_PROVIDER` to `openai` or `anthropic` is a config-only change — no code edits needed.
- Every Slack button click acks immediately, then does the slow work (LLM call, LinkedIn publish) wrapped in `waitUntil()` from `@vercel/functions` ([src/slackApp.ts](src/slackApp.ts)) — this is required on Vercel because a serverless function's execution environment can otherwise be frozen right after the HTTP response is sent, silently killing any work still in flight.
