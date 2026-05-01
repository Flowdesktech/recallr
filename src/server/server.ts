import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ask, askStream } from "../ask.js";
import { loadConfig } from "../config.js";
import { LocalEmbedder } from "../embed/local.js";
import { llmFromEnv } from "../llm/openai.js";
import { SqliteStore } from "../store/sqlite.js";
import type { Embedder, LlmClient, SearchHit, Source, Store } from "../types.js";

export interface ServerOptions {
  /** Port to listen on. Default 7474 (a memorable, rarely-used port). */
  port?: number;
  /** Hostname to bind to. Default "127.0.0.1" — never expose to the network by default. */
  host?: string;
  /** Skip embedder initialization (lexical-only mode). */
  noEmbed?: boolean;
  /** Override the directory of static web assets. Defaults to the bundled `dist-web`. */
  webRoot?: string;
}

/**
 * Spin up the local recallr HTTP server.
 *
 * The server intentionally has no auth: it binds to 127.0.0.1 only,
 * exactly like Ollama, LM Studio, and Jupyter. Exposing it on a LAN
 * is a future roadmap item that will require token-based auth.
 *
 * Static asset serving is bare-bones because we only have ~5 files in
 * `dist-web`. We refuse to serve anything outside that directory by
 * normalizing every path and re-checking the prefix — the standard
 * directory-traversal mitigation.
 */
export async function startServer(opts: ServerOptions = {}): Promise<{
  server: Server;
  port: number;
  url: string;
  close: () => Promise<void>;
}> {
  const port = opts.port ?? 7474;
  const host = opts.host ?? "127.0.0.1";
  const cfg = await loadConfig();
  const store = await SqliteStore.open(cfg.dbPath);

  let embedder: Embedder | undefined;
  if (!opts.noEmbed) {
    try {
      embedder = await LocalEmbedder.load({
        model: cfg.embedModel,
        dimension: cfg.embedDimension,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `recallr: embedder failed to load, falling back to lexical search: ${msg}\n`,
      );
    }
  }

  const llm = llmFromEnv({}, cfg.llm);
  const webRoot = resolve(opts.webRoot ?? defaultWebRoot());

  const server = createServer((req, res) => {
    handle(req, res, { store, embedder, llm, webRoot }).catch((err) => {
      writeError(res, 500, err instanceof Error ? err.message : String(err));
    });
  });

  await new Promise<void>((res) => server.listen(port, host, res));
  const url = `http://${host}:${port}`;

  return {
    server,
    port,
    url,
    close: async () => {
      await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
      store.close();
    },
  };
}

interface RequestContext {
  store: Store;
  embedder?: Embedder;
  llm: LlmClient;
  webRoot: string;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const { pathname } = url;

  // CORS preflight is rejected by default. We are 127.0.0.1-only and
  // intend to stay that way; any cross-origin client should be talking
  // to recallr via MCP, not HTTP.
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (pathname.startsWith("/api/")) {
    return handleApi(req, res, ctx, pathname);
  }
  return handleStatic(req, res, ctx.webRoot, pathname);
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  pathname: string,
): Promise<void> {
  if (pathname === "/api/status" && req.method === "GET") {
    const stats = await ctx.store.stats();
    return writeJson(res, 200, stats);
  }

  if (pathname === "/api/ask" && req.method === "POST") {
    const body = await readJson<{
      question: string;
      limit?: number;
      source?: string;
      participant?: string;
      after?: number;
      before?: number;
    }>(req);
    const result = await ask({
      question: body.question,
      store: ctx.store,
      llm: ctx.llm,
      embedder: ctx.embedder,
      options: {
        limit: body.limit,
        source: body.source as Source | undefined,
        participant: body.participant,
        after: body.after,
        before: body.before,
      },
    });
    return writeJson(res, 200, {
      answer: result.answer,
      citations: result.citations.map(serializeHit),
    });
  }

  if (pathname === "/api/ask/stream" && req.method === "POST") {
    const body = await readJson<{
      question: string;
      limit?: number;
      source?: string;
      participant?: string;
      after?: number;
      before?: number;
    }>(req);
    return streamAsk(res, ctx, body);
  }

  if (pathname === "/api/threads" && req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "30", 10);
    const source = url.searchParams.get("source") ?? undefined;
    const before = url.searchParams.get("before");
    const threads = await ctx.store.listThreads({
      limit: Number.isFinite(limit) ? Math.min(limit, 200) : 30,
      source: source as Source | undefined,
      before: before ? Number(before) : undefined,
    });
    return writeJson(res, 200, { count: threads.length, threads });
  }

  if (pathname === "/api/search" && req.method === "GET") {
    const url = new URL(req.url ?? "/", "http://localhost");
    const query = url.searchParams.get("q") ?? "";
    const limit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
    const source = url.searchParams.get("source") ?? undefined;
    const participant = url.searchParams.get("participant") ?? undefined;
    const after = url.searchParams.get("after");
    const before = url.searchParams.get("before");
    const queryVector = ctx.embedder ? ((await ctx.embedder.embed([query]))[0] ?? null) : null;
    const hits = await ctx.store.search(query, queryVector, {
      limit: Number.isFinite(limit) ? limit : 10,
      source: source as Source | undefined,
      participant,
      after: after ? Number(after) : undefined,
      before: before ? Number(before) : undefined,
    });
    return writeJson(res, 200, {
      count: hits.length,
      results: hits.map(serializeHit),
    });
  }

  if (pathname.startsWith("/api/thread/") && req.method === "GET") {
    const id = decodeURIComponent(pathname.slice("/api/thread/".length));
    const thread = await ctx.store.getThread(id);
    if (!thread) return writeError(res, 404, `no thread for message ${id}`);
    return writeJson(res, 200, {
      id: thread.id,
      source: thread.source,
      subject: thread.subject,
      participants: thread.participants,
      messages: thread.messages.map((m) => ({
        id: m.id,
        source: m.source,
        channel: m.channel,
        thread_id: m.threadId,
        subject: m.subject,
        from: m.from,
        to: m.to,
        cc: m.cc,
        timestamp: new Date(m.timestamp).toISOString(),
        body: m.body,
        provenance: m.provenance,
      })),
    });
  }

  return writeError(res, 404, `unknown api route: ${pathname}`);
}

async function handleStatic(
  _req: IncomingMessage,
  res: ServerResponse,
  webRoot: string,
  pathname: string,
): Promise<void> {
  // Single-page app: any path that isn't a real file falls through to
  // index.html so client-side routing (currently none) can take over.
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = resolveSafe(webRoot, requested);

  if (safePath) {
    try {
      const s = await stat(safePath);
      if (s.isFile()) return streamFile(res, safePath);
    } catch {
      // fall through
    }
  }

  // Fallback to index.html.
  const indexPath = join(webRoot, "index.html");
  try {
    const s = await stat(indexPath);
    if (s.isFile()) return streamFile(res, indexPath);
  } catch {
    return writeError(
      res,
      404,
      `web assets not found at ${webRoot}. Run \`npm run build:web\` or reinstall recallr.`,
    );
  }
}

function resolveSafe(root: string, requestedPath: string): string | null {
  const abs = normalize(join(root, requestedPath));
  // Re-check the prefix on the normalized path to catch ../ escapes.
  return abs.startsWith(root) ? abs : null;
}

function streamFile(res: ServerResponse, path: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const ct = contentTypeFor(path);
    res.writeHead(200, { "content-type": ct, "cache-control": cacheControlFor(path) });
    const stream = createReadStream(path);
    stream.on("error", (err) => rejectP(err));
    stream.on("end", () => resolveP());
    stream.pipe(res);
  });
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function cacheControlFor(path: string): string {
  // Vite emits hashed filenames under `assets/`; those are safe to long-cache.
  // Match either separator so this works on both POSIX and Windows.
  if (/[\\/]assets[\\/]/.test(path)) return "public, max-age=31536000, immutable";
  return "no-cache";
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error("invalid JSON body");
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function writeError(res: ServerResponse, status: number, message: string): void {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: message }));
}

/**
 * Stream `askStream` events to a Server-Sent Events response. Each event
 * is encoded as a single SSE frame with a typed `event:` and a JSON `data:`
 * payload, which is what `EventSource` and `fetch+ReadableStream` clients
 * expect.
 *
 * We flush after every event because some proxies / Node's HTTP layer will
 * otherwise coalesce a long stream of small writes into one TCP segment
 * that arrives only when the response ends — defeating the whole point.
 */
async function streamAsk(
  res: ServerResponse,
  ctx: RequestContext,
  body: {
    question: string;
    limit?: number;
    source?: string;
    participant?: string;
    after?: number;
    before?: number;
  },
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Heartbeat every 15s so intermediate proxies (and Node itself) don't
  // close an apparently-idle connection during a slow LLM warmup.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": heartbeat\n\n");
  }, 15_000);

  try {
    for await (const evt of askStream({
      question: body.question,
      store: ctx.store,
      llm: ctx.llm,
      embedder: ctx.embedder,
      options: {
        limit: body.limit,
        source: body.source as Source | undefined,
        participant: body.participant,
        after: body.after,
        before: body.before,
      },
    })) {
      if (evt.type === "citations") {
        send("citations", { citations: evt.citations.map(serializeHit) });
      } else if (evt.type === "token") {
        send("token", { value: evt.value });
      } else if (evt.type === "done") {
        send("done", {
          answer: evt.answer,
          citations: evt.citations.map(serializeHit),
        });
      } else {
        send("error", { message: evt.message });
      }
    }
  } catch (err) {
    send("error", { message: err instanceof Error ? err.message : String(err) });
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}

function serializeHit(h: SearchHit) {
  const m = h.message;
  // FTS5 bm25 values can be very small floats on small corpora (~1e-6),
  // so we keep 6 sig-figs rather than rounding to 4 decimal places.
  const sig = (n: number) => Number(n.toPrecision(6));
  return {
    score: sig(h.score),
    bm25: h.bm25 != null ? sig(h.bm25) : undefined,
    cosine: h.cosine != null ? sig(h.cosine) : undefined,
    message: {
      id: m.id,
      source: m.source,
      channel: m.channel,
      thread_id: m.threadId,
      subject: m.subject,
      from: m.from,
      to: m.to,
      cc: m.cc,
      timestamp: new Date(m.timestamp).toISOString(),
      body: m.body,
      provenance: m.provenance,
    },
  };
}

/**
 * Locate the bundled `dist-web` directory.
 *
 * In production (installed as an npm package) this file lives at
 * `<pkg>/dist/server/server.js`, so the assets are at `<pkg>/dist-web`.
 * In dev/test we may also be running from `src/server/server.ts` via
 * tsx — in which case the assets are at `<repo>/dist-web`.
 */
function defaultWebRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/server -> dist-web is two levels up + dist-web
  // src/server  -> dist-web is two levels up + dist-web
  return resolve(here, "..", "..", "dist-web");
}
