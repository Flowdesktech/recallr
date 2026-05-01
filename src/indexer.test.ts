import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MboxConnector } from "./connectors/mbox.js";
import { indexConnector } from "./indexer.js";
import { SqliteStore } from "./store/sqlite.js";
import type { Embedder } from "./types.js";

/**
 * End-to-end indexer test using a deterministic, in-process embedder.
 * This exercises: mbox parse -> indexer batch -> store upsert -> FTS search.
 *
 * It does NOT exercise the real local embedder (which downloads a model
 * on first run and is therefore unsuitable for fast unit tests). The real
 * embedder is covered by a separate, opt-in integration test.
 */
class StubEmbedder implements Embedder {
  readonly modelId = "stub:hash-32";
  readonly dimension = 32;
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(hashEmbedding);
  }
}

function hashEmbedding(text: string): Float32Array {
  // Deterministic, content-sensitive 32-d vector. Good enough to verify
  // the indexer wires through to the store correctly.
  const v = new Float32Array(32);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    v[code % 32] = ((v[code % 32] ?? 0) + 1) / 2;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

describe("indexConnector + sample mbox e2e", () => {
  let dir: string;
  let store: SqliteStore;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "mneme-e2e-"));
    store = await SqliteStore.open(join(dir, "test.db"));
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("indexes the sample mbox and embeds every message", async () => {
    const connector = new MboxConnector(join(process.cwd(), "examples", "sample.mbox"));
    const embedder = new StubEmbedder();
    const progress = await indexConnector({ connector, store, embedder });

    expect(progress.fetched).toBeGreaterThanOrEqual(6);
    expect(progress.stored).toBe(progress.fetched);
    expect(progress.embedded).toBe(progress.fetched);
  });

  it("answers a pricing question via search", async () => {
    const embedder = new StubEmbedder();
    const [q] = await embedder.embed(["pricing decision tier"]);
    const hits = await store.search("pricing decision", q ?? null, { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    const subjects = hits.map((h) => h.message.subject ?? "");
    expect(subjects.some((s) => s.toLowerCase().includes("pricing"))).toBe(true);
  });

  it("is idempotent on re-index", async () => {
    const connector = new MboxConnector(join(process.cwd(), "examples", "sample.mbox"));
    const embedder = new StubEmbedder();
    const before = await store.stats();
    await indexConnector({ connector, store, embedder });
    const after = await store.stats();
    expect(after.messages).toBe(before.messages);
    expect(after.embeddings).toBe(before.embeddings);
  });
});
