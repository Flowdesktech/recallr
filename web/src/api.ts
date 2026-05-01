/**
 * Tiny client for the local recallr HTTP server.
 *
 * Lives at the same origin as the UI in production. In `vite dev` mode
 * Vite's dev server proxies /api -> http://localhost:7474 (see
 * `web/vite.config.ts`).
 */

export interface Participant {
  id: string;
  name?: string;
  email?: string;
}

export interface ApiMessage {
  id: string;
  source: string;
  channel?: string;
  thread_id?: string;
  subject?: string;
  body: string;
  from: Participant;
  to: Participant[];
  cc?: Participant[];
  timestamp: string;
  provenance?: Record<string, string>;
}

export interface SearchHit {
  score: number;
  bm25?: number;
  cosine?: number;
  message: ApiMessage;
}

export interface AskResponse {
  answer: string;
  citations: SearchHit[];
}

export interface ThreadResponse {
  id: string;
  source: string;
  subject?: string;
  participants: Participant[];
  messages: ApiMessage[];
}

export interface StatusResponse {
  messages: number;
  embeddings: number;
  sources: Record<string, number>;
}

export interface ThreadSummary {
  id: string;
  source: string;
  channel?: string;
  subject?: string;
  messageCount: number;
  participants: Participant[];
  lastTimestamp: number;
  snippet: string;
  latestMessageId: string;
}

export interface AskFilters {
  source?: string;
  participant?: string;
  after?: number;
  before?: number;
}

export type AskStreamEvent =
  | { type: "citations"; citations: SearchHit[] }
  | { type: "token"; value: string }
  | { type: "done"; answer: string; citations: SearchHit[] }
  | { type: "error"; message: string };

const BASE = "/api";

async function call<T>(path: string, init?: RequestInit & { signal?: AbortSignal }): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text || path}`);
  }
  return (await res.json()) as T;
}

export const api = {
  status: () => call<StatusResponse>("/status"),

  ask: (question: string, opts?: { limit?: number; signal?: AbortSignal } & AskFilters) =>
    call<AskResponse>("/ask", {
      method: "POST",
      body: JSON.stringify({
        question,
        limit: opts?.limit,
        source: opts?.source,
        participant: opts?.participant,
        after: opts?.after,
        before: opts?.before,
      }),
      signal: opts?.signal,
    }),

  /**
   * Stream the ask pipeline. Yields `citations` once the search step finishes,
   * then a sequence of `token` events as the LLM emits deltas, then a final
   * `done` event with the assembled answer. On failure, a single `error`
   * event is yielded.
   *
   * The caller can abort mid-stream via `opts.signal`; we clean up and
   * return rather than throwing in that case.
   */
  askStream: async function* (
    question: string,
    opts?: { limit?: number; signal?: AbortSignal } & AskFilters,
  ): AsyncGenerator<AskStreamEvent, void, void> {
    const res = await fetch(`${BASE}/ask/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        question,
        limit: opts?.limit,
        source: opts?.source,
        participant: opts?.participant,
        after: opts?.after,
        before: opts?.before,
      }),
      signal: opts?.signal,
    });
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield {
        type: "error",
        message: `${res.status} ${res.statusText}: ${text || "/ask/stream"}`,
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sepIndex: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic SSE frame walker — assign-and-test is the clearest expression of "consume each completed frame out of the buffer".
        while ((sepIndex = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sepIndex);
          buffer = buffer.slice(sepIndex + 2);
          const evt = parseSseFrame(frame);
          if (evt) yield evt;
        }
      }
    } finally {
      reader.releaseLock();
    }
  },

  search: (query: string, opts?: { limit?: number } & AskFilters) => {
    const params = new URLSearchParams({ q: query });
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.source) params.set("source", opts.source);
    if (opts?.participant) params.set("participant", opts.participant);
    if (opts?.after !== undefined) params.set("after", String(opts.after));
    if (opts?.before !== undefined) params.set("before", String(opts.before));
    return call<{ count: number; results: SearchHit[] }>(`/search?${params}`);
  },

  thread: (messageId: string) => call<ThreadResponse>(`/thread/${encodeURIComponent(messageId)}`),

  threads: (opts?: { limit?: number; source?: string; before?: number }) => {
    const params = new URLSearchParams();
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.source) params.set("source", opts.source);
    if (opts?.before !== undefined) params.set("before", String(opts.before));
    const qs = params.toString();
    return call<{ count: number; threads: ThreadSummary[] }>(qs ? `/threads?${qs}` : "/threads");
  },
};

function parseSseFrame(frame: string): AskStreamEvent | null {
  let event = "message";
  let data = "";
  for (const rawLine of frame.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.startsWith(":")) continue; // comment / heartbeat
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trim();
  }
  if (!data) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  switch (event) {
    case "citations":
      return { type: "citations", citations: (payload as { citations: SearchHit[] }).citations };
    case "token":
      return { type: "token", value: (payload as { value: string }).value };
    case "done": {
      const p = payload as { answer: string; citations: SearchHit[] };
      return { type: "done", answer: p.answer, citations: p.citations };
    }
    case "error":
      return { type: "error", message: (payload as { message: string }).message };
    default:
      return null;
  }
}
