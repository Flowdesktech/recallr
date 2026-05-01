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

const BASE = "/api";

async function call<T>(
  path: string,
  init?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
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
  ask: (
    question: string,
    opts?: { limit?: number; source?: string; signal?: AbortSignal },
  ) =>
    call<AskResponse>("/ask", {
      method: "POST",
      body: JSON.stringify({
        question,
        limit: opts?.limit,
        source: opts?.source,
      }),
      signal: opts?.signal,
    }),
  search: (query: string, opts?: { limit?: number; source?: string }) => {
    const params = new URLSearchParams({ q: query });
    if (opts?.limit) params.set("limit", String(opts.limit));
    if (opts?.source) params.set("source", opts.source);
    return call<{ count: number; results: SearchHit[] }>(`/search?${params}`);
  },
  thread: (messageId: string) =>
    call<ThreadResponse>(`/thread/${encodeURIComponent(messageId)}`),
};
