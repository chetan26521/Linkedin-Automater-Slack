// Measurement loop for the "does this read as AI-written" question — run it against a batch
// of generated posts whenever AI_TELL_RULES changes, to see if the change actually moved the
// needle instead of just feeling like it should have.
//
// Usage:
//   tsx scripts/check-ai-detection.ts --topic "why most CRM rollouts fail in year one"
//   tsx scripts/check-ai-detection.ts --topic "..." --compare        (also scores the pre-humanize draft)
//   tsx scripts/check-ai-detection.ts --text "paste any post text here"
//
// GPTZero and Originality.ai calls only run if GPTZERO_API_KEY / ORIGINALITY_API_KEY are set
// in .env — without them, only the free local heuristic scan runs. Get free/cheap keys at
// https://gptzero.me/api and https://app.originality.ai/api-access to run real detector checks.
import { config as loadEnv } from "dotenv";
loadEnv({ override: true });

import { AI_TELL_PHRASES, findAiTells, generatePostText, type ContentStyle } from "../src/postWriter.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (flag: string) => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  return {
    topic: get("--topic"),
    text: get("--text"),
    compare: args.includes("--compare"),
    style: (get("--style") as ContentStyle) ?? "thought-leadership",
  };
}

// ---- Free local heuristic (not a real detector — a cheap sanity check to run before
// spending a detector-API credit, catching the specific things AI_TELL_RULES asks the model
// to avoid). Burstiness is the one number worth trusting here: real detectors weight sentence
// -length uniformity heavily, and it's measurable without any external API. ----
function localHeuristicScan(text: string) {
  const lower = text.toLowerCase();
  const hitPhrases = AI_TELL_PHRASES.filter((p) => lower.includes(p.toLowerCase()));

  const sentences = text
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const lengths = sentences.map((s) => s.split(/\s+/).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / (lengths.length || 1);
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / (lengths.length || 1);
  const stdDev = Math.sqrt(variance);
  // Coefficient of variation: 0 = every sentence is the same length (a strong AI tell),
  // higher = more human-like unevenness. There's no official threshold — this is a rough
  // proxy, not a calibrated score — but under ~0.3 is worth a second look.
  const burstiness = mean > 0 ? stdDev / mean : 0;

  const hasEmDash = /[—–]/.test(text) || /\s-\s/.test(text);
  const hasContrastTemplate = /\bisn'?t (just )?about\b.{0,40}\bit'?s about\b/i.test(text) || /\bnot just\b.{0,40}\bit'?s\b/i.test(text);

  return { hitPhrases, sentenceCount: sentences.length, meanSentenceLength: mean, burstiness, hasEmDash, hasContrastTemplate };
}

// ---- GPTZero ----
async function checkGptZero(text: string) {
  const apiKey = process.env.GPTZERO_API_KEY;
  if (!apiKey) return { skipped: "no GPTZERO_API_KEY set" };

  const response = await fetch("https://api.gptzero.me/v2/predict/text", {
    method: "POST",
    headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ document: text }),
  });
  if (!response.ok) return { error: `GPTZero API failed: ${response.status} ${await response.text()}` };

  const json = (await response.json()) as {
    documents?: { average_generated_prob?: number; class_probabilities?: { human?: number; ai?: number; mixed?: number } }[];
  };
  const doc = json.documents?.[0];
  return {
    aiProbability: doc?.average_generated_prob,
    classProbabilities: doc?.class_probabilities,
  };
}

// ---- Originality.ai ----
async function checkOriginality(text: string) {
  const apiKey = process.env.ORIGINALITY_API_KEY;
  if (!apiKey) return { skipped: "no ORIGINALITY_API_KEY set" };

  const response = await fetch("https://api.originality.ai/api/v1/scan/ai", {
    method: "POST",
    headers: { "X-OAI-API-KEY": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
  if (!response.ok) return { error: `Originality.ai API failed: ${response.status} ${await response.text()}` };

  const json = (await response.json()) as { score?: { ai?: number; original?: number } };
  return { aiProbability: json.score?.ai, originalProbability: json.score?.original };
}

function printHeuristic(label: string, text: string) {
  const h = localHeuristicScan(text);
  console.log(`\n--- ${label}: local heuristic scan ---`);
  console.log(`Sentences: ${h.sentenceCount}, mean length: ${h.meanSentenceLength.toFixed(1)} words, burstiness (CV): ${h.burstiness.toFixed(2)}${h.burstiness < 0.3 ? "  <- low, sentence lengths look uniform" : ""}`);
  console.log(`Banned AI-tell phrases found: ${h.hitPhrases.length ? h.hitPhrases.join(", ") : "none"}`);
  console.log(`Em dash / hyphen-as-pause detected: ${h.hasEmDash}`);
  console.log(`"Not just X, it's Y" contrast template detected: ${h.hasContrastTemplate}`);
  // The same checks finalizePost uses to decide whether a post needs another fix-up pass.
  const tells = findAiTells(text);
  console.log(`Pipeline tell check: ${tells.length ? `\n  - ${tells.join("\n  - ")}` : "clean"}`);
}

async function printDetectors(label: string, text: string) {
  console.log(`\n--- ${label}: detector APIs ---`);
  const [gptZero, originality] = await Promise.all([checkGptZero(text), checkOriginality(text)]);
  console.log("GPTZero:", gptZero);
  console.log("Originality.ai:", originality);
}

async function scoreText(label: string, text: string) {
  console.log(`\n=== ${label} ===\n${text}`);
  printHeuristic(label, text);
  await printDetectors(label, text);
}

async function main() {
  const { topic, text, compare, style } = parseArgs();

  if (text) {
    await scoreText("Provided text", text);
    return;
  }

  if (!topic) {
    console.error('Pass --topic "..." to generate and score a fresh post, or --text "..." to score existing text.');
    process.exit(1);
  }

  if (compare) {
    const raw = await generatePostText(topic, style, undefined, undefined, true);
    await scoreText("Before humanize pass", raw.postText);
  }

  const final = await generatePostText(topic, style);
  await scoreText("After humanize pass (what actually ships)", final.postText);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
