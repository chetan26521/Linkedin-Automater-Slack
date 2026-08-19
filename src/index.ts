import { app } from "./slackApp.js";

(async () => {
  await app.start();
  console.log("⚡️ LinkedIn post bot is running (Socket Mode) — say \"create a post\" in Slack to try it.");
})();
