import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askStream } from "./ask.js";
import { SqliteStore } from "./store/sqlite.js";
import type { ChatMessage, ChatOptions, LlmClient, Message } from "./types.js";

/**
 * In-memory LLM that yields a fixed sequence of token chunks. Used to
 * verify the streaming wiring without spinning up a real model.
 */
class FakeStreamLlm implements LlmClient {
  constructor(private readonly chunks: string[]) {}
  async chat(_msgs: ChatMessage[], _opts?: ChatOptions): Promise<string> {
    return this.chunks.join("");
  }
  async *chatStream(_msgs: ChatMessage[], _opts?: ChatOptions): AsyncIterable<string> {
    for (const c of this.chunks) {
      // simulate network latency between SSE frames
      await new Promise((r) => setTimeout(r, 0));
      yield c;
    }
  }
}

class FakeNonStreamLlm implements LlmClient {
  constructor(private readonly answer: string) {}
  async chat(_msgs: ChatMessage[], _opts?: ChatOptions): Promise<string> {
    return this.answer;
  }
}

function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: "test:1",
    source: "mbox",
    sourceId: "1",
    subject: "Q3 pricing decision",
    body: "We agreed on $29/mo entry tier and a 14-day trial.",
    from: { id: "ana@example.com", email: "ana@example.com", name: "Ana" },
    to: [{ id: "bob@example.com", email: "bob@example.com" }],
    timestamp: Date.parse("2025-04-01T10:00:00Z"),
    ...over,
  };
}

describe("askStream", () => {
  it("emits citations, then tokens in order, then done", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "recallr-ask-stream-"));
    const store = await SqliteStore.open(join(tempHome, "db.sqlite"));
    try {
      await store.upsertMessages([makeMessage()]);

      const llm = new FakeStreamLlm(["The team ", "agreed on ", "$29/mo [#1]."]);
      const events: string[] = [];
      let citations: number | undefined;
      let finalAnswer: string | undefined;

      for await (const evt of askStream({
        question: "what was the pricing decision?",
        store,
        llm,
      })) {
        events.push(evt.type);
        if (evt.type === "citations") citations = evt.citations.length;
        if (evt.type === "done") finalAnswer = evt.answer;
      }

      expect(events[0]).toBe("citations");
      expect(events.at(-1)).toBe("done");
      // every event between citations and done must be a token
      const middle = events.slice(1, -1);
      expect(middle.every((e) => e === "token")).toBe(true);
      expect(middle.length).toBe(3);
      expect(citations).toBe(1);
      expect(finalAnswer).toBe("The team agreed on $29/mo [#1].");
    } finally {
      store.close();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("falls back to chat() when chatStream is missing — single token + done", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "recallr-ask-fallback-"));
    const store = await SqliteStore.open(join(tempHome, "db.sqlite"));
    try {
      await store.upsertMessages([makeMessage()]);

      const llm = new FakeNonStreamLlm("Trial is 14 days [#1].");
      const tokens: string[] = [];
      let done = false;

      for await (const evt of askStream({
        question: "trial length?",
        store,
        llm,
      })) {
        if (evt.type === "token") tokens.push(evt.value);
        if (evt.type === "done") done = true;
      }

      expect(tokens).toEqual(["Trial is 14 days [#1]."]);
      expect(done).toBe(true);
    } finally {
      store.close();
      rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("yields a single error event when retrieval throws", async () => {
    const broken = {
      search: async () => {
        throw new Error("simulated store failure");
      },
    } as unknown as SqliteStore;

    const events: { type: string; message?: string }[] = [];
    for await (const evt of askStream({
      question: "anything",
      store: broken,
      llm: new FakeNonStreamLlm("unreachable"),
    })) {
      events.push(evt as { type: string; message?: string });
    }
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("error");
    expect(events[0]!.message).toContain("simulated store failure");
  });
});
