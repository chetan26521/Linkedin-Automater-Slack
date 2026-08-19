import type { ContentStyle } from "./postWriter.js";

const TTL_MS = 30 * 60 * 1000; // entries expire 30 min after creation if never resolved

function createTtlStore<T extends { id: string }>() {
  const items = new Map<string, T>();
  const timers = new Map<string, NodeJS.Timeout>();

  function save(item: T): void {
    const existingTimer = timers.get(item.id);
    if (existingTimer) clearTimeout(existingTimer);

    items.set(item.id, item);
    const timer = setTimeout(() => {
      items.delete(item.id);
      timers.delete(item.id);
    }, TTL_MS);
    timer.unref();
    timers.set(item.id, timer);
  }

  function get(id: string): T | undefined {
    return items.get(id);
  }

  function remove(id: string): void {
    const existingTimer = timers.get(id);
    if (existingTimer) clearTimeout(existingTimer);
    timers.delete(id);
    items.delete(id);
  }

  return { save, get, remove };
}

export interface Draft {
  id: string;
  text: string;
  topic: string;
  threadContext?: string;
  contentStyle: ContentStyle;
  messageTs: string; // ts of the Slack message showing the draft text, so regenerate can edit it in place
  channel: string;
  requestedBy: string;
  createdAt: number;
}

const draftStore = createTtlStore<Draft>();
export const saveDraft = draftStore.save;
export const getDraft = draftStore.get;
export const deleteDraft = draftStore.remove;

export function updateDraftText(id: string, text: string): void {
  const draft = draftStore.get(id);
  if (!draft) return;
  draftStore.save({ ...draft, text });
}

// Holds a topic (and thread context) after "create a post" but before the user has
// picked a content style — the style-picker buttons carry only this id.
export interface PendingRequest {
  id: string;
  topic: string;
  threadContext?: string;
  channel: string;
  threadTs: string;
  requestedBy: string;
  createdAt: number;
}

const pendingRequestStore = createTtlStore<PendingRequest>();
export const savePendingRequest = pendingRequestStore.save;
export const getPendingRequest = pendingRequestStore.get;
export const deletePendingRequest = pendingRequestStore.remove;
