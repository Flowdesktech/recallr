import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MboxConnector } from "../connectors/mbox.js";
import { indexConnector } from "../indexer.js";
import { SqliteStore } from "../store/sqlite.js";
import { startServer } from "./server.js";

/**
 * Server-level smoke test. Spins up the real HTTP server bound to an
 * ephemeral port, points it at a freshly indexed temp database, and
 * exercises every public route end-to-end.
 *
 * The test stays hermetic by setting RECALLR_HOME to a tempdir and
 * pointing RECALLR_DB at a per-run database file, so it never touches
 * the developer's real ~/.recallr.
 */
describe("HTTP server", () => {
  let tempHome: string;
  let dbPath: string;
  let webRoot: string;
  let baseUrl: string;
  let close: () => Promise<void>;
  let originalHome: string | undefined;
  let originalDb: string | undefined;

  beforeAll(async () => {
    tempHome = mkdtempSync(join(tmpdir(), "recallr-server-"));
    dbPath = join(tempHome, "test.db");
    webRoot = join(tempHome, "web");

    // Minimal stand-in for the bundled web assets — server should serve
    // whatever is at index.html.
    mkdirSync(webRoot, { recursive: true });
    writeFileSync(join(webRoot, "index.html"), "<html><body>recallr test</body></html>");

    // Index the bundled sample mbox into the temp store.
    const store = await SqliteStore.open(dbPath);
    const connector = new MboxConnector(join(process.cwd(), "examples", "sample.mbox"));
    await indexConnector({ connector, store });
    store.close();

    originalHome = process.env.RECALLR_HOME;
    originalDb = process.env.RECALLR_DB;
    process.env.RECALLR_HOME = tempHome;
    process.env.RECALLR_DB = dbPath;

    const started = await startServer({
      port: 0,
      noEmbed: true,
      webRoot,
    });
    baseUrl = `http://127.0.0.1:${(started.server.address() as { port: number }).port}`;
    close = started.close;
  });

  afterAll(async () => {
    await close();
    if (originalHome === undefined) process.env.RECALLR_HOME = undefined;
    else process.env.RECALLR_HOME = originalHome;
    if (originalDb === undefined) process.env.RECALLR_DB = undefined;
    else process.env.RECALLR_DB = originalDb;
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("serves the web root", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("recallr test");
  });

  it("falls back to index.html for unknown routes (SPA mode)", async () => {
    const res = await fetch(`${baseUrl}/some/client/route`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("recallr test");
  });

  it("GET /api/status returns counts", async () => {
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { messages: number; sources: Record<string, number> };
    expect(json.messages).toBeGreaterThanOrEqual(6);
    expect(json.sources.mbox).toBeGreaterThanOrEqual(6);
  });

  it("GET /api/search returns hybrid results with non-zero bm25", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=pricing&limit=5`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      count: number;
      results: { bm25?: number; message: { subject?: string } }[];
    };
    expect(json.count).toBeGreaterThan(0);
    expect(json.results[0]?.message.subject?.toLowerCase()).toContain("pricing");
    // The bm25 precision regression: must surface the underlying float.
    expect(json.results[0]?.bm25).toBeGreaterThan(0);
  });

  it("GET /api/thread resolves a thread by any member id", async () => {
    const search = await fetch(`${baseUrl}/api/search?q=pricing&limit=1`).then(
      (r) => r.json() as Promise<{ results: { message: { id: string } }[] }>,
    );
    const id = search.results[0]?.message.id;
    expect(id).toBeTruthy();
    const res = await fetch(`${baseUrl}/api/thread/${encodeURIComponent(id!)}`);
    expect(res.status).toBe(200);
    const thread = (await res.json()) as {
      messages: { subject?: string; timestamp: string }[];
    };
    expect(thread.messages.length).toBeGreaterThanOrEqual(2);
    // Messages must be ordered chronologically.
    const ts = thread.messages.map((m) => Date.parse(m.timestamp));
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]!).toBeGreaterThanOrEqual(ts[i - 1]!);
    }
  });

  it("GET /api/thread returns 404 for missing ids", async () => {
    const res = await fetch(`${baseUrl}/api/thread/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("rejects directory traversal in static paths", async () => {
    const res = await fetch(`${baseUrl}/../../../../etc/passwd`);
    // Either resolves to index.html (200) — never the targeted file.
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("recallr test");
    expect(body).not.toContain("root:");
  });

  it("GET /api/threads lists recent threads with snippets", async () => {
    const res = await fetch(`${baseUrl}/api/threads?limit=5`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      count: number;
      threads: {
        id: string;
        source: string;
        subject?: string;
        snippet: string;
        messageCount: number;
        latestMessageId: string;
        lastTimestamp: number;
        participants: { id: string }[];
      }[];
    };
    expect(json.count).toBeGreaterThan(0);
    expect(json.threads.length).toBeLessThanOrEqual(5);
    // Threads are ordered by lastTimestamp DESC.
    for (let i = 1; i < json.threads.length; i++) {
      expect(json.threads[i]!.lastTimestamp).toBeLessThanOrEqual(
        json.threads[i - 1]!.lastTimestamp,
      );
    }
    // Each summary needs a usable latestMessageId so the UI can drill in.
    for (const t of json.threads) {
      expect(typeof t.latestMessageId).toBe("string");
      expect(t.latestMessageId.length).toBeGreaterThan(0);
      expect(t.messageCount).toBeGreaterThanOrEqual(1);
      expect(t.snippet.length).toBeGreaterThan(0);
    }
  });

  it("GET /api/threads filters by source", async () => {
    const res = await fetch(`${baseUrl}/api/threads?source=mbox&limit=3`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { threads: { source: string }[] };
    for (const t of json.threads) expect(t.source).toBe("mbox");

    const empty = await fetch(`${baseUrl}/api/threads?source=imap&limit=3`);
    expect(empty.status).toBe(200);
    const e = (await empty.json()) as { count: number };
    expect(e.count).toBe(0);
  });
});
