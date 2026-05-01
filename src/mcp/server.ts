import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig } from "../config.js";
import { LocalEmbedder } from "../embed/local.js";
import { SqliteStore } from "../store/sqlite.js";
import type { Embedder, Message, SearchHit } from "../types.js";

/**
 * Recallr as an MCP server.
 *
 * Exposes four tools to any MCP client (Cursor, Claude Desktop, Goose, etc):
 *
 *   - search_messages: hybrid BM25 + embedding search across all sources.
 *   - get_message:     fetch a full message by id (returned by search).
 *   - get_thread:      fetch the entire conversation containing a message.
 *   - status:          stats about the indexed corpus.
 *
 * The contract is intentionally tiny. MCP servers that try to expose
 * too much get noisy in tool-selection prompts; four sharp tools is
 * the sweet spot for retrieval.
 */
export async function runMcpServer(opts: { useEmbedder?: boolean } = {}): Promise<void> {
  const cfg = await loadConfig();
  const store = await SqliteStore.open(cfg.dbPath);
  let embedder: Embedder | undefined;
  if (opts.useEmbedder !== false) {
    try {
      embedder = await LocalEmbedder.load({
        model: cfg.embedModel,
        dimension: cfg.embedDimension,
      });
    } catch (err) {
      // Fall back to lexical-only search rather than killing the server —
      // a degraded retrieval is much better than no retrieval for the agent.
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `recallr: failed to load embedder, falling back to lexical search: ${msg}\n`,
      );
    }
  }

  const server = new Server(
    { name: "recallr", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "search_messages",
        description:
          "Search the user's indexed messages (email, Slack, Discord, etc.) " +
          "with hybrid BM25 + embedding retrieval. Returns the most relevant messages " +
          "with their full body, sender, recipients, and timestamp. Use this whenever " +
          "the user asks a question whose answer might be in their personal communications.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Natural-language search query.",
            },
            limit: {
              type: "number",
              description: "Maximum number of messages to return (default 10).",
              minimum: 1,
              maximum: 50,
            },
            source: {
              type: "string",
              description: "Restrict to a single source (imap, mbox, slack, discord, ...).",
            },
            participant: {
              type: "string",
              description: "Restrict to messages involving this person (email, name, or id).",
            },
            after: {
              type: "string",
              description: "ISO date — only return messages on or after this date.",
            },
            before: {
              type: "string",
              description: "ISO date — only return messages on or before this date.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_message",
        description: "Fetch a single message by its recallr id.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Message id from a search_messages result." },
          },
          required: ["id"],
        },
      },
      {
        name: "get_thread",
        description:
          "Fetch the full conversation containing a given message, ordered chronologically. " +
          "Use this when search_messages returned a hit and you need surrounding context.",
        inputSchema: {
          type: "object",
          properties: {
            message_id: { type: "string", description: "Any message id within the thread." },
          },
          required: ["message_id"],
        },
      },
      {
        name: "status",
        description: "Return counts of indexed messages and embeddings, broken down by source.",
        inputSchema: { type: "object", properties: {} },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      switch (req.params.name) {
        case "search_messages": {
          const query = String(args.query ?? "").trim();
          if (!query) throw new Error("`query` is required");
          const limit = clampInt(args.limit, 1, 50, 10);
          const after = args.after ? new Date(String(args.after)).getTime() : undefined;
          const before = args.before ? new Date(String(args.before)).getTime() : undefined;
          const queryVector = embedder
            ? (await embedder.embed([query]))[0] ?? null
            : null;
          const hits = await store.search(query, queryVector, {
            limit,
            source: args.source as never,
            participant: typeof args.participant === "string" ? args.participant : undefined,
            after,
            before,
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { count: hits.length, results: hits.map(serializeHit) },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "get_message": {
          const id = String(args.id ?? "");
          if (!id) throw new Error("`id` is required");
          const msg = await store.getMessage(id);
          if (!msg) {
            return { content: [{ type: "text", text: `No message with id ${id}` }] };
          }
          return {
            content: [{ type: "text", text: JSON.stringify(serializeMessage(msg), null, 2) }],
          };
        }

        case "get_thread": {
          const id = String(args.message_id ?? "");
          if (!id) throw new Error("`message_id` is required");
          const thread = await store.getThread(id);
          if (!thread) {
            return { content: [{ type: "text", text: `No thread for message ${id}` }] };
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    id: thread.id,
                    source: thread.source,
                    subject: thread.subject,
                    participants: thread.participants,
                    messages: thread.messages.map(serializeMessage),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case "status": {
          const s = await store.stats();
          return {
            content: [{ type: "text", text: JSON.stringify(s, null, 2) }],
          };
        }

        default:
          throw new Error(`Unknown tool: ${req.params.name}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: "text", text: `recallr error: ${msg}` }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Keep the process alive on the stdio transport — the MCP client will
  // close it when the assistant disconnects.
}

/* ------------------------------ serializers ------------------------------ */

function serializeMessage(m: Message) {
  return {
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
  };
}

function serializeHit(h: SearchHit) {
  const sig = (n: number) => Number(n.toPrecision(6));
  return {
    score: sig(h.score),
    bm25: h.bm25 != null ? sig(h.bm25) : undefined,
    cosine: h.cosine != null ? sig(h.cosine) : undefined,
    message: serializeMessage(h.message),
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
