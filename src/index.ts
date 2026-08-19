import { receiver } from "./slackApp.js";
import { config } from "./config.js";

receiver.app.listen(config.port, () => {
  console.log(`⚡️ LinkedIn post bot listening on http://localhost:${config.port}/api/slack/events`);
  console.log(`For Slack to reach this locally, tunnel it (e.g. \`ngrok http ${config.port}\`) and set the tunnel URL + /api/slack/events as your Slack app's Request URL.`);
});
