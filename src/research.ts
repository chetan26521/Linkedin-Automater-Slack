import { config } from "./config.js";

// Multi-platform research that runs before a post is drafted. Instead of one search-enabled call
// that tends to stop at the first news article, the topic is researched in parallel "lanes", each
// pinned to a different kind of source with allowed_domains — so the post always hears from the
// official source, practitioners, the social conversation, and independent analysts, rather than
// whichever of those a single search happened to surface. Each lane returns structured notes with
// a URL on every claim; the writer works only from those notes.
//
// Search can only see what the search index can: Reddit, Hacker News, YouTube, and blogs are well
// covered, but LinkedIn and X mostly hide content behind login, so those lanes see public posts and
// articles only, not the full feed.

export interface ResearchResult {
  /** Combined lane notes, ready to drop into the writing prompt. */
  brief: string;
  sources: { url: string; title: string }[];
}

interface Lane {
  name: string;
  focus: string;
  allowedDomains?: string[];
  // Lets the lane read a full page (e.g. the official announcement) instead of only search snippets.
  fetch?: boolean;
}

const LANES: Lane[] = [
  {
    name: "Official and primary sources",
    focus:
      "the official source for this topic: the company or project's own website, announcement, release notes, documentation, pricing page, or official blog, plus credible news coverage. Establish exactly what is new or true, with dates, version names, and numbers, and separate official claims from independently verified facts. Fetch the most important official page to read it in full.",
    fetch: true,
  },
  {
    name: "Practitioner community",
    focus:
      "what practitioners are actually saying in community discussions: real usage reports, complaints, workarounds, surprises, and disagreements. Look for the details that only people who have used it would know.",
    allowedDomains: ["reddit.com", "news.ycombinator.com", "stackoverflow.com", "stackexchange.com", "github.com", "community.openai.com"],
  },
  {
    name: "Social conversation",
    focus:
      "how the topic is being discussed on social platforms: which takes are getting attention, which recognized voices are commenting and what they say, and which angles are already overused and would read as repetitive.",
    allowedDomains: ["linkedin.com", "x.com", "twitter.com", "youtube.com", "threads.net"],
  },
  {
    name: "Independent analysis",
    focus:
      "independent expert analysis: newsletters, analyst write-ups, technical blogs, and podcasts. Look for numbers, comparisons, second-order effects, and critiques that go beyond the announcement.",
    allowedDomains: ["substack.com", "medium.com", "dev.to", "hashnode.dev", "towardsdatascience.com", "stratechery.com", "a16z.com", "hbr.org", "techcrunch.com", "theverge.com", "arstechnica.com", "wired.com"],
  },
];

// Per lane, so total searches per post stay bounded: searches are billed per use ($10 per 1,000).
const MAX_SEARCHES_PER_LANE = 4;
const MAX_FETCHES_PER_LANE = 2;
// Each lane gets its own deadline so one slow lane can't eat the whole function's time budget —
// the post still gets written from whichever lanes finished.
// 90s leaves room inside the 300s function limit for drafting, the humanize passes, and the
// poster (which can take two image generations), all of which run in the same invocation.
const LANE_TIMEOUT_MS = 90_000;
// The API pauses long server-tool turns (stop_reason "pause_turn"); resending the conversation
// lets it carry on. Bounded so a lane can't loop forever.
const MAX_LANE_CONTINUATIONS = 3;
const MAX_SOURCES = 12;

type ContentBlock = { type: string; [key: string]: any };

function lanePrompt(lane: Lane, topic: string, threadContext: string | undefined, today: string): string {
  return `You are a research assistant preparing notes for a LinkedIn post. Today's date is ${today}.

Topic requested: "${topic}"
${threadContext ? `\nExtra context from the requester:\n${threadContext}\n` : ""}
Your job in this pass is to research ${lane.focus}

Search before you answer, and search more than once with different queries if the first results are thin. Prefer the most recent material, and say how recent each point is. If the topic name is ambiguous or slightly misspelled, work out what the requester most likely means from current results and research that.

Respond with research notes only (not a post), in this shape:
FACTS: verified facts with dates and numbers, each ending with its source URL in parentheses.
WHAT PEOPLE ARE SAYING: concrete reactions, experiences, praise, and complaints, each with its source URL.
OVERUSED TAKES: angles that are already everywhere and would sound repetitive.
UNDEREXPLORED ANGLES: interesting points, tensions, or implications that few sources are making.
OPEN QUESTIONS: what is still unclear, disputed, or unverified.

Rules: every claim needs a URL you actually saw. Never invent facts, quotes, numbers, or sources. If this pass found little that is useful, say so plainly in one line instead of padding.`;
}

async function runLane(lane: Lane, topic: string, threadContext: string | undefined, today: string): Promise<{ notes: string; seen: Map<string, string> }> {
  const tools: ContentBlock[] = [
    {
      type: "web_search_20260209",
      name: "web_search",
      max_uses: MAX_SEARCHES_PER_LANE,
      ...(lane.allowedDomains ? { allowed_domains: lane.allowedDomains } : {}),
    },
  ];
  if (lane.fetch) tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: MAX_FETCHES_PER_LANE });

  const messages: { role: "user" | "assistant"; content: string | ContentBlock[] }[] = [
    { role: "user", content: lanePrompt(lane, topic, threadContext, today) },
  ];
  const seen = new Map<string, string>();
  const signal = AbortSignal.timeout(LANE_TIMEOUT_MS);

  for (let turn = 0; turn <= MAX_LANE_CONTINUATIONS; turn++) {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: config.anthropicModel, max_tokens: 8000, messages, tools }),
      signal,
    });
    if (!response.ok) throw new Error(`${lane.name} research failed: ${response.status} ${await response.text()}`);

    const json = (await response.json()) as { content?: ContentBlock[]; stop_reason?: string };
    const content = json.content ?? [];

    for (const block of content) {
      if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
        for (const r of block.content) if (r.type === "web_search_result" && r.url) seen.set(r.url, r.title ?? r.url);
      } else if (block.type === "web_fetch_tool_result" && block.content?.url) {
        seen.set(block.content.url, block.content.content?.title ?? block.content.url);
      }
    }

    if (json.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content });
      continue;
    }

    const notes = content.filter((b) => b.type === "text").map((b) => b.text as string).join("").trim();
    return { notes, seen };
  }

  throw new Error(`${lane.name} research didn't finish within ${MAX_LANE_CONTINUATIONS} continuations`);
}

// Only sources the notes actually cite, in the order they're cited: lanes see far more search
// results than they use, and listing all of them would bury the ones the post is built on.
function citedSources(notes: string, seen: Map<string, string>): { url: string; title: string }[] {
  const cited = new Map<string, string>();
  for (const match of notes.matchAll(/https?:\/\/[^\s)\]>"']+/g)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (!cited.has(url)) cited.set(url, seen.get(url) ?? new URL(url).hostname);
  }
  return [...cited].map(([url, title]) => ({ url, title }));
}

/** Researches a topic across every lane in parallel. Throws only if every lane failed. */
export async function researchTopic(topic: string, threadContext?: string): Promise<ResearchResult> {
  const today = new Date().toISOString().slice(0, 10);
  const results = await Promise.allSettled(LANES.map((lane) => runLane(lane, topic, threadContext, today)));

  const sections: string[] = [];
  const sourcesByUrl = new Map<string, string>();
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      console.warn(`Research lane "${LANES[i].name}" failed:`, result.reason);
      return;
    }
    if (!result.value.notes) return;
    sections.push(`### ${LANES[i].name}\n${result.value.notes}`);
    for (const s of citedSources(result.value.notes, result.value.seen)) if (!sourcesByUrl.has(s.url)) sourcesByUrl.set(s.url, s.title);
  });

  if (sections.length === 0) {
    const reasons = results.map((r) => (r.status === "rejected" ? String(r.reason?.message ?? r.reason) : "no notes")).join("; ");
    throw new Error(`Research failed on every source: ${reasons}`);
  }

  return {
    brief: sections.join("\n\n"),
    sources: [...sourcesByUrl].slice(0, MAX_SOURCES).map(([url, title]) => ({ url, title })),
  };
}
