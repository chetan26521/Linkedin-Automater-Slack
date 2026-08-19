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

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**.
2. **Socket Mode**: under *Settings → Socket Mode*, turn it on. This generates an **App-Level Token** — give it the `connections:write` scope, copy it as `SLACK_APP_TOKEN`.
3. **Bot Token Scopes**: under *Features → OAuth & Permissions*, add:
   - `chat:write`
   - `channels:history` (and `groups:history` / `im:history` if you'll use private channels or DMs)
4. **Event Subscriptions**: turn on, subscribe to bot event `message.channels` (add `message.groups` / `message.im` as needed). With Socket Mode on, no request URL is needed.
5. **Interactivity**: turn on (also works over Socket Mode, no URL needed).
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

Fill in `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL_ID`, `LLM_PROVIDER` + its matching API key, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`.

Then run the one-time LinkedIn connect script:

```
npm run linkedin-auth
```

Open the printed URL, approve access, and copy the `LINKEDIN_ACCESS_TOKEN` / `LINKEDIN_PERSON_ID` it prints into `.env`.

> LinkedIn access tokens last ~60 days. When posting starts failing with an auth error, just re-run `npm run linkedin-auth`.

## 6. Run it

```
npm run dev
```

Then in Slack: `create a post: we just shipped X, here's why it matters`

## Notes / things to check before relying on this

- LinkedIn bumps its API version string monthly (`LINKEDIN_VERSION` in [src/linkedin.ts](src/linkedin.ts)). If publishing starts failing with a version-related error, check LinkedIn's current version at https://learn.microsoft.com/en-us/linkedin/marketing/versioning and update it.
- Pending style requests and drafts (text only) are held in memory only, keyed by an id on the Slack buttons. Restarting the bot between picking a style and getting a draft, or between generating a draft and clicking approve, will lose it; you'd just ask it to create the post again.
- This is scoped to your personal LinkedIn profile (`w_member_social`). Posting to a company Page needs the `w_organization_social` scope and admin access to that Page, which isn't wired up here.
- The trigger phrase is `"create a post"` (case-insensitive substring match), configurable via `TRIGGER_PHRASE` in `.env`.
- OpenRouter's free models can be lower quality than paid ones and occasionally get rate-limited or rotated out (see step 2). Switching `LLM_PROVIDER` to `openai` or `anthropic` is a config-only change — no code edits needed.
