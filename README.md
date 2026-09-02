# LinkedIn post bot for Slack

Say **"create a post: <topic>"** in a Slack channel the bot is in. It will:

1. Ask how the post should be written: **💡 Thought Leadership**, **📊 Industry Insight**, **🎯 Case Study**, or **📢 Announcement**.
2. Draft LinkedIn post copy in that style with your configured LLM provider ([OpenRouter](https://openrouter.ai), OpenAI, Anthropic, or Gemini), based on your message (and thread, if replying in one). When `LLM_PROVIDER=anthropic` or `gemini`, the model researches the topic first with its server-side web search tool (Claude's `web_search`, capped at 5 searches per post; Gemini's Google Search grounding) before writing, and the draft message lists the sources it actually cited. Not available on openrouter/openai; if the model judges a search unnecessary for the topic, no sources are shown either. The prompt also steers away from em-dash-as-pause and slash-as-shorthand patterns that read as obviously AI-written.
3. Design a poster graphic for the post with Gemini's image model, and preview it in the thread. A separate art-direction step decides the headline and visual concept from the finished post *before* anything is drawn, which is what makes the poster come out with one clear, correctly spelled message instead of a wall of garbled text — see [src/imageGen.ts](src/imageGen.ts). Skipped entirely if `POST_IMAGES=off` or no `GEMINI_API_KEY` is set.
4. Post the exact draft text back to Slack with **✅ Post with Poster** / **🖼️ New Poster** / **📄 Text Only** / **❌ Reject** buttons. **New Poster** redesigns the graphic for the same copy, as many times as you like (earlier attempts stay in the thread so you can compare them). **Text Only** publishes the copy with no image.
5. Only publish to your LinkedIn profile if you click one of the post buttons. Ignoring it entirely means nothing is ever posted (both the pending style request and any draft expire after 30 minutes).
6. Clicking **❌ Reject** doesn't discard anything yet — it shows a follow-up: **📐 More Concise**, **🎩 More Formal**, **📊 More Data-Driven**, **🔀 Different Angle**, or **🗑️ Dismiss**. Picking a style regenerates the post (same topic/thread context/content style, revised per that feedback), redesigns the poster to match the new copy, and shows the post buttons again — you can loop through as many regenerations as you like. **Dismiss** is the only action that actually throws the draft away.

Say **"content calendar"** for a second flow that plans and schedules a whole series of posts:

1. The bot asks what topic the calendar should be about — your *next message in the same thread* is treated as the answer (no need to repeat the trigger phrase).
2. It then shows a short form: a content-style dropdown, a multi-select for which weekdays to post on, a time picker, and a **Weekly (next 7 days)** / **Monthly (next 4 weeks)** length picker. Fill all four in and click **📅 Generate Calendar**.
3. The weekday selection + length together decide exactly how many posts the calendar needs (e.g. Mon & Thu, Monthly → 8 slots), and the bot asks the model to plan precisely that many posts, organized under the topic's natural content pillars (grouping several posts under the same pillar with distinct angles when there are more slots than pillars) — so the calendar always comes out fully and evenly filled for the window you picked, never a mismatched or partial one. The review message shows an actual Mon–Sun calendar grid (each scheduled post's pillar in its date's cell) alongside the detailed date/pillar list. Buttons: **✅ Approve & Schedule**, **🔄 Regenerate**, **🗑️ Dismiss**.
4. Approving schedules each post via [Upstash QStash](https://upstash.com/docs/qstash) to fire on its own date — nothing is generated yet. When a post's date arrives, it's generated automatically and sent to Slack with the exact same **✅ Post to LinkedIn** / **❌ Reject** flow as above; nothing publishes without that manual approval on the day.

Requires QStash to be configured (see step 7) — without it, the calendar can be built and reviewed but Approve will fail to schedule anything.

Say **"edit post"** to revise something already published:

1. The bot lists your last 10 published posts (date + preview) in a dropdown — pick one.
2. It asks what you'd like to change — your *next message in the same thread* is treated as the answer, same pattern as the calendar's "what topic?" step.
3. The AI rewrites the post based on your feedback and shows the proposed new text with **✅ Apply Update**, **🔄 Revise Again**, or **🗑️ Cancel**. **Revise Again** loops back to step 2, continuing from the latest proposal rather than the original, so successive rounds of feedback compound.
4. Only **Apply Update** actually changes the live LinkedIn post, via LinkedIn's partial-update API — nothing changes until you click it.

The bot remembers your last 20 published posts (including ones it scheduled via the content calendar) for this picker; older ones age out.

No message without "create a post", "content calendar", or "edit post" in it does anything — the bot ignores all other channel chatter.

## 1. Install dependencies

```
npm install
```

## 2. Pick a text-generation provider

Set `LLM_PROVIDER` in `.env` to one of `openrouter`, `openai`, `anthropic`, or `gemini`, and fill in only that provider's key:

- **openrouter** (default, free) — sign up at https://openrouter.ai/keys (email or GitHub, no card required), copy the key as `OPENROUTER_API_KEY`. The default model (`nvidia/nemotron-3-ultra-550b-a55b:free`) is free and currently the strongest free option, but free models rotate occasionally without notice. If drafting starts failing (404/error on the model id), check https://openrouter.ai/models?max_price=0 for a current free model and set `OPENROUTER_MODEL`. `z-ai/glm-5.2:free` is a solid, faster fallback if Nemotron Ultra is ever slow or rate-limited. Free-tier limits: 20 requests/min, 50 requests/day with no credits, 1,000/day after a one-time $10 credit purchase (credits don't expire).
- **openai** — get a key at https://platform.openai.com/api-keys, copy it as `OPENAI_API_KEY`. Optionally set `OPENAI_MODEL` (default `gpt-4o-mini`).
- **anthropic** — get a key at https://console.anthropic.com/settings/keys, copy it as `ANTHROPIC_API_KEY`. Optionally set `ANTHROPIC_MODEL` (default `claude-sonnet-5`).
- **gemini** — get a key at https://aistudio.google.com/apikey, copy it as `GEMINI_API_KEY`. Optionally set `GEMINI_MODEL` (default `gemini-2.5-flash`; `gemini-2.5-pro` writes better copy but is slower and has a much tighter free-tier rate limit). Gemini grounds its drafts with Google Search, so posts come back with real sources the same way the Anthropic path does.

openai and anthropic are paid (no free tier); openrouter's default model is free, and Gemini has a free tier with per-minute and per-day rate limits.

> **A Gemini Pro / Google AI Pro subscription does not cover this.** That subscription is for the Gemini app, Gemini in Workspace, and Gemini CLI — it grants no API access at all. `GEMINI_API_KEY` is a separate credential from [AI Studio](https://aistudio.google.com/apikey), billed on its own meter, with a free tier that is generally ample for this bot's volume.

### Poster images (Gemini)

Poster generation always runs through Gemini's image model, independently of `LLM_PROVIDER` — so you can keep writing copy with Claude or OpenAI and still get posters, as long as `GEMINI_API_KEY` is set. It switches itself on automatically when that key is present.

- `GEMINI_API_KEY` — required for posters, whichever provider writes the text.
- `POST_IMAGES` — `on` or `off`. Defaults to `on` when `GEMINI_API_KEY` is set and `off` otherwise. Set it to `off` for text-only posts without having to remove the key.
- `GEMINI_IMAGE_MODEL` — default `gemini-2.5-flash-image`, which is unusually good at rendering legible text inside an image (the whole point of a poster). `gemini-3-pro-image-preview` gives noticeably better typography and layout at a higher price, if it is available on your key.
- `POST_IMAGE_ASPECT_RATIO` — default `1:1`, which fills more of a mobile feed than a `1.91:1` banner without risking the crop that portrait ratios get in some LinkedIn surfaces.

## 3. Create the Slack app

The bot runs over Slack's HTTP Events API + Interactivity (no Socket Mode) so it can run as a Vercel serverless function — Slack needs a public HTTPS URL to send requests to, which means the app must already be deployed (or tunneled, for local dev — see step 6) before you can finish this section.

1. Go to https://api.slack.com/apps → **Create New App** → **From scratch**.
2. **Signing Secret**: under *Settings → Basic Information → App Credentials*, copy the **Signing Secret** as `SLACK_SIGNING_SECRET`.
3. **Bot Token Scopes**: under *Features → OAuth & Permissions*, add:
   - `chat:write`
   - `files:write` — needed to preview generated posters in the thread. Without it everything else still works and posters still publish, but you would be approving an image you cannot see, so the bot warns you in Slack instead.
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

Fill in `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`, `LLM_PROVIDER` + its matching API key, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`. Leave `KV_REST_API_URL`/`_TOKEN` for step 6 and `QSTASH_*`/`APP_BASE_URL` for step 7 (only needed for the content calendar).

Then run the one-time LinkedIn connect script:

```
npm run linkedin-auth
```

Open the printed URL, approve access, and copy the `LINKEDIN_ACCESS_TOKEN` / `LINKEDIN_PERSON_ID` it prints into `.env`.

> LinkedIn access tokens last ~60 days. When posting starts failing with an auth error, just re-run `npm run linkedin-auth`.

## 6. Deploy to Vercel

Drafts and pending style requests are stored in Redis (not in memory), since a serverless function has no persistent memory between invocations — so a Redis database has to exist before the bot can work at all, including locally.

1. Create a free Redis database via your Vercel project's **Storage** tab → **Create Database** → pick a Redis option (Upstash-backed; the free tier is enough for this bot). This automatically injects `KV_REST_API_URL` and `KV_REST_API_TOKEN` into your project — Vercel's Storage integration uses these legacy `KV_*` names (a holdover from the deprecated `@vercel/kv` product) even though it's really just Redis under the hood. Alternatively, create a database directly at https://console.upstash.com (no card required) and copy its **REST API** `URL`/`TOKEN` values into `KV_REST_API_URL`/`KV_REST_API_TOKEN` yourself, in both your local `.env` and Vercel's env vars — the code only cares about those two env var names, not which path produced them.
2. Push this repo to GitHub (already done if you're reading this from the repo) and import it into Vercel: https://vercel.com/new.
3. In **Settings → Environment Variables**, confirm `KV_REST_API_URL`/`KV_REST_API_TOKEN` are present, and add everything else from your `.env`: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`, `LLM_PROVIDER` + its key, `GEMINI_API_KEY` (for posters, whichever provider writes the text), `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_ACCESS_TOKEN`, `LINKEDIN_PERSON_ID` (and `TRIGGER_PHRASE` if you changed it). Skip `PORT` — that's local-only.
4. Deploy. Note the deployment URL (e.g. `https://your-app.vercel.app`).
5. Go back to your Slack app's **Event Subscriptions** and **Interactivity** settings (step 3) and set both Request URLs to `https://your-app.vercel.app/api/slack/events`, now that it's live. Slack will verify the URL on save.
6. For local dev, pull the same values with `vercel env pull .env.development.local` (after `vercel link`), or copy them manually into `.env` from step 1. To let Slack reach your machine for local testing, tunnel it (e.g. `ngrok http 3000`) and temporarily point the Slack Request URLs at the tunnel's `/api/slack/events` instead.

The `maxDuration` for both functions is set to 300s (5 minutes) in [vercel.json](vercel.json) — the maximum Vercel allows even on the free Hobby plan. A single "create a post" now does rather a lot in one invocation — a grounded draft (multiple search round-trips before the model finishes writing), an art-direction call, an image generation, a LinkedIn upload, and a Slack upload — and this needs enough headroom to not get silently cut off mid-request — a `waitUntil()`-wrapped promise that hits `maxDuration` is hard-cancelled, not a catchable error, so there'd be no error message in Slack either, just silence.

## 7. Set up QStash (only needed for "content calendar")

QStash schedules each calendar post to fire an HTTP call to this app at an exact future date/time — it's what makes "approve, then get posts automatically on their dates" work without a persistent server.

1. Go to https://console.upstash.com → **QStash** (same account as your Redis database from step 6).
2. Copy the **Token**, **Current Signing Key**, and **Next Signing Key** from the QStash dashboard into `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` — in both your local `.env` and Vercel's env vars.
3. `APP_BASE_URL` can usually be left blank — it falls back to `https://$VERCEL_URL`, which Vercel sets automatically at runtime. Set it explicitly (to your stable production URL or custom domain) only if you want QStash to always target that instead of whichever deployment happens to be current, or if you're testing locally via a tunnel.
4. Redeploy (or just start using it — env var changes apply on the next invocation/deploy).

If you skip this step, "create a post" works exactly as before; "content calendar" will build and let you review a schedule, but clicking **Approve & Schedule** will fail with a clear error until these are set.

## 8. Run it

```
npm run dev
```

Then in Slack: `create a post: we just shipped X, here's why it matters`, `content calendar` to plan a series, or `edit post` to revise something already published.

## Notes / things to check before relying on this

- LinkedIn bumps its API version string monthly (`LINKEDIN_VERSION` in [src/linkedin.ts](src/linkedin.ts)). If publishing starts failing with a version-related error, check LinkedIn's current version at https://learn.microsoft.com/en-us/linkedin/marketing/versioning and update it.
- Pending style requests and drafts (text only) live in Redis with a 30-minute TTL, keyed by an id on the Slack buttons. If you never click through, they just expire — you'd ask it to create the post again. Published-post history is different: it's a plain bounded list (last 20), not TTL'd, since it's real history rather than transient in-flight state.
- This is scoped to your personal LinkedIn profile (`w_member_social`). Posting to a company Page needs the `w_organization_social` scope and admin access to that Page, which isn't wired up here.
- The trigger phrases are `"create a post"`, `"content calendar"`, and `"edit post"` (case-insensitive substring match), configurable via `TRIGGER_PHRASE` / `CALENDAR_TRIGGER_PHRASE` / `EDIT_TRIGGER_PHRASE` in `.env`.
- OpenRouter's free models can be lower quality than paid ones and occasionally get rate-limited or rotated out (see step 2). Switching `LLM_PROVIDER` to `openai` or `anthropic` is a config-only change — no code edits needed.
- Every Slack button click acks immediately, then does the slow work (LLM call, LinkedIn publish) wrapped in `waitUntil()` from `@vercel/functions` ([src/slackApp.ts](src/slackApp.ts)) — this is required on Vercel because a serverless function's execution environment can otherwise be frozen right after the HTTP response is sent, silently killing any work still in flight.
- A generated calendar's schedule math ([src/calendar.ts](src/calendar.ts)) uses a fixed timezone offset captured once (from the requester's Slack profile) rather than a full IANA-aware calculation — a daylight-saving transition partway through a multi-week calendar could shift a post by an hour. Not worth a timezone library for this internal tool, but worth knowing.
- The "what topic?" question after "content calendar" only recognizes an answer if it's a reply *in the same thread* as the question, from the same person who triggered it, within 10 minutes — otherwise it expires and the message falls through to normal handling (so accidentally saying "create a post" right after won't get swallowed).
- QStash caps how far in the future a single message can be scheduled (7 days). A Monthly calendar's later posts can't be scheduled directly at Approve time, so [src/calendar.ts](src/calendar.ts) bundles anything past that cap into a "promote" job that re-checks ~6 days later, schedules whatever's now within range with its exact publish time, and re-defers the rest — self-chaining until every post has been handed to QStash. This is invisible day-to-day; worth knowing if you're debugging why a far-future post doesn't show up in the QStash dashboard immediately after approving.
- Every published poster is uploaded to LinkedIn at *draft* time, not at publish time, and the draft stores only the resulting `urn:li:image:...` — image bytes never have to be parked between serverless invocations, and whoever clicks approve is approving the exact image that goes out. An uploaded image that never gets attached to a post is simply an unused asset on your LinkedIn account.
- The poster prompt in [src/imageGen.ts](src/imageGen.ts) is mostly *negative* constraints (no invented statistics, no fake logos, no body copy, no stock-photo handshakes). That is deliberate: left unconstrained, image models fill professional-looking layouts with plausible-but-fabricated numbers and garbled captions, which is exactly what an audience of officials will notice. Posters are still worth a look before you approve them — that is what the Slack preview is for.
- Editing an already-published post (`edit post`) changes only the text. LinkedIn does not allow swapping the media on a live post, so an attached poster stays as published — if the poster itself is wrong, delete the post on LinkedIn and create a new one.
- Web search (Anthropic and Gemini only) is billed per search on top of normal token costs ($10 per 1,000 searches as of writing) and capped at `MAX_WEB_SEARCHES_PER_POST` (5) in [src/postWriter.ts](src/postWriter.ts). It also has to be enabled for your Anthropic organization — it is by default, but an admin can disable it or restrict which domains it searches in the Claude Console under Settings → Privacy; if disabled, generation fails with a 400 error rather than silently skipping search.
