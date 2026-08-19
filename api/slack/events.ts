import type { IncomingMessage, ServerResponse } from "node:http";
import { receiver } from "../../src/slackApp.js";

// Bolt's ExpressReceiver exposes an Express app, which is itself a valid
// (req, res) request handler — hand it straight to Vercel's Node.js runtime.
export default function handler(req: IncomingMessage, res: ServerResponse) {
  return (receiver.app as unknown as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
}
