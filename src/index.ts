import { receiver } from "./slackApp.js";
import { config } from "./config.js";
import linkedinCallback from "../api/linkedin/callback.js";

// On Vercel this is its own function (api/linkedin/callback.ts); locally it rides on the same
// Express app so `npm run dev` covers the whole connect flow.
receiver.app.get("/api/linkedin/callback", (req, res) => void linkedinCallback(req, res));

receiver.app.listen(config.port, () => {
  console.log(`⚡️ LinkedIn post bot listening on http://localhost:${config.port}/api/slack/events`);
  console.log(`For Slack to reach this locally, tunnel it (e.g. \`ngrok http ${config.port}\`) and set the tunnel URL + /api/slack/events as your Slack app's Request URL.`);
});
