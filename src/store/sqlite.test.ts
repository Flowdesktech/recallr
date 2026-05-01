import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Message } from "../types.js";
import { SqliteStore } from "./sqlite.js";

describe("SqliteStore", () => {
  let dir: string;
  let store: SqliteStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "recallr-test-"));
    store = await SqliteStore.open(join(dir, "test.db"));
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upserts and round-trips messages", async () => {
    const messages: Message[] = [
      mkMessage("a", "Q3 pricing decision", "Pro at 19 dollars per month", 1000),
      mkMessage("b", "Onboarding flow", "Skip workspace setup", 2000),
    ];
    await store.upsertMessages(messages);

    const got = await store.getMessage("a");
    expect(got?.subject).toBe("Q3 pricing decision");
    expect(got?.body).toContain("Pro at 19");
  });

  it("performs lexical search via FTS5", async () => {
    const hits = await store.search("pricing", null, { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.message.id).toBe("a");
  });

  it("reranks with a query vector when supplied", async () => {
    // Two messages, identical lexical match for "pricing"; vector should break ties.
    await store.upsertMessages([
      mkMessage("c", "pricing change", "we changed the pricing", 3000),
      mkMessage("d", "pricing fyi", "pricing is fine", 4000),
    ]);
    // Inject deterministic vectors — c is closer to the query.
    const dim = 4;
    const q = new Float32Array([1, 0, 0, 0]);
    await store.upsertEmbeddings([
      { id: "c", modelId: "test", vector: new Float32Array([0.9, 0.1, 0, 0]) },
      { id: "d", modelId: "test", vector: new Float32Array([0.1, 0.9, 0, 0]) },
    ]);
    void dim;

    const hits = await store.search("pricing", q, { limit: 2 });
    expect(hits[0]?.message.id).toBe("c");
  });

  it("tracks embedded ids by model", async () => {
    const ids = await store.embeddedIds("test");
    expect(ids.has("c")).toBe(true);
    expect(ids.has("d")).toBe(true);
    expect(ids.has("a")).toBe(false);
  });

  it("returns stats", async () => {
    const stats = await store.stats();
    expect(stats.messages).toBeGreaterThanOrEqual(4);
    expect(stats.embeddings).toBeGreaterThanOrEqual(2);
  });
});

function mkMessage(id: string, subject: string, body: string, ts: number): Message {
  return {
    id,
    source: "mbox",
    sourceId: id,
    subject,
    body,
    from: { id: "ana@flowdesk.tech", email: "ana@flowdesk.tech", name: "Ana" },
    to: [{ id: "team@flowdesk.tech", email: "team@flowdesk.tech" }],
    timestamp: ts,
  };
}
