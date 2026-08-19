import type { IncomingMessage, ServerResponse } from "node:http";
import { Receiver } from "@upstash/qstash";
import { config } from "../../src/config.js";
import { app, createDraftAndPostConfirmation } from "../../src/slackApp.js";
import type { ContentStyle } from "../../src/postWriter.js";
import type { CalendarPublishJob } from "../../src/calendar.js";

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Fired by QStash at the scheduled time for one content-calendar pillar. Unlike the Slack
// endpoint, there's no 3-second-ack requirement here — QStash just waits for the HTTP
// response, so this runs synchronously without needing waitUntil().
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") {
    res.writeHead(405).end("Method Not Allowed");
    return;
  }

  const body = await readRawBody(req);
  const signature = req.headers["upstash-signature"];

  try {
    const receiver = new Receiver({
      currentSigningKey: config.qstashCurrentSigningKey,
      nextSigningKey: config.qstashNextSigningKey,
    });
    const valid = await receiver.verify({ signature: signature as string, body });
    if (!valid) throw new Error("invalid signature");
  } catch (err) {
    console.error("QStash signature verification failed:", err);
    res.writeHead(401).end("Unauthorized");
    return;
  }

  let job: CalendarPublishJob;
  try {
    job = JSON.parse(body);
  } catch {
    res.writeHead(400).end("Invalid JSON body");
    return;
  }

  try {
    await createDraftAndPostConfirmation(app.client, {
      topic: job.topic,
      contentStyle: job.contentStyle as ContentStyle,
      channel: job.channel,
      threadTs: job.threadTs,
      requestedBy: job.requestedBy,
    });
    res.writeHead(200).end("OK");
  } catch (err: any) {
    console.error("Failed to publish scheduled calendar entry:", err);
    // Let QStash retry on failure — a non-2xx response triggers its retry policy.
    res.writeHead(500).end(`Failed: ${err.message}`);
  }
}
