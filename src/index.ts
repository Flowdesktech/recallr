/**
 * Public programmatic API.
 *
 * `recallr` ships as both a CLI and a library. Most users will reach for
 * the CLI (`recallr index`, `recallr ask`, `recallr mcp`), but the library
 * surface lets you embed recallr inside other Node services — for example,
 * a backend that builds a personal knowledge graph for each of its users.
 *
 * Example:
 *
 *     import { SqliteStore, LocalEmbedder, MboxConnector, indexConnector, ask, llmFromEnv } from "recallr";
 *
 *     const store = await SqliteStore.open("./recallr.db");
 *     const embedder = await LocalEmbedder.load();
 *     await indexConnector({
 *       connector: new MboxConnector("./inbox.mbox"),
 *       store,
 *       embedder,
 *     });
 *     const llm = llmFromEnv();
 *     const result = await ask({
 *       question: "What did the team decide about pricing?",
 *       store, llm, embedder,
 *     });
 *     console.log(result.answer);
 */

export type {
  Attachment,
  ChatMessage,
  ChatOptions,
  Connector,
  Embedder,
  LlmClient,
  Message,
  Participant,
  SearchHit,
  SearchOptions,
  Source,
  Store,
  Thread,
} from "./types.js";

export { SqliteStore } from "./store/sqlite.js";
export { LocalEmbedder } from "./embed/local.js";
export { OpenAiCompatClient, llmFromEnv } from "./llm/openai.js";
export { MboxConnector, mailToMessage } from "./connectors/mbox.js";
export { ImapConnector, type ImapConfig } from "./connectors/imap.js";
export { SlackExportConnector } from "./connectors/slack.js";
export {
  indexConnector,
  type IndexOptions,
  type IndexProgress,
} from "./indexer.js";
export { ask, type AskOptions, type AskResult } from "./ask.js";
export {
  loadConfig,
  type RecallrConfig,
  type SourceConfig,
} from "./config.js";
export { startServer, type ServerOptions } from "./server/server.js";
