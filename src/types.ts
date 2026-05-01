/**
 * Core domain types for mneme.
 *
 * Every connector (email, slack, discord, ...) normalizes its data into
 * a `Message`. Everything downstream — storage, indexing, search, RAG,
 * MCP — speaks only this shape.
 */

export type Source =
  | "imap"
  | "gmail"
  | "mbox"
  | "slack"
  | "discord"
  | "matrix"
  | "telegram"
  | "whatsapp"
  | "imessage"
  | "teams"
  | "other";

export interface Participant {
  /** Stable identity within the source (email address, slack user id, etc.) */
  id: string;
  /** Display name at the time of the message, if known. */
  name?: string;
  /** Email address, if applicable. */
  email?: string;
}

export interface Attachment {
  filename?: string;
  contentType?: string;
  size?: number;
}

/**
 * A single message normalized across every source.
 *
 * `id` must be globally unique within the database. It is the
 * responsibility of the connector to mint a stable id (typically
 * `${source}:${sourceId}`) so re-indexing is idempotent.
 */
export interface Message {
  id: string;
  source: Source;
  /** Original id within the source (e.g. IMAP UID, Slack ts). */
  sourceId: string;
  /**
   * Channel the message belongs to. For email this is the mailbox/folder
   * (`INBOX`, `Sent`, ...). For Slack/Discord it's the channel id.
   */
  channel?: string;
  /** Stable thread/conversation id when the source supports threading. */
  threadId?: string;
  /** Subject line for email; first message text or pinned title elsewhere. */
  subject?: string;
  /** Plain-text body. HTML is normalized away during ingestion. */
  body: string;
  from: Participant;
  to: Participant[];
  cc?: Participant[];
  bcc?: Participant[];
  /** Unix epoch milliseconds when the message was sent. */
  timestamp: number;
  attachments?: Attachment[];
  /**
   * Free-form provenance — e.g. mbox path, IMAP folder, Slack workspace.
   * Used for citation in answers ("from your Fastmail INBOX").
   */
  provenance?: Record<string, string>;
}

export interface Thread {
  id: string;
  source: Source;
  channel?: string;
  subject?: string;
  participants: Participant[];
  messages: Message[];
  /** Timestamp of the most recent message. */
  lastTimestamp: number;
}

/* --------------------------------- search -------------------------------- */

export interface SearchOptions {
  /** Final number of results to return after rerank. Default 10. */
  limit?: number;
  /** Number of FTS candidates to pull before embedding rerank. Default 200. */
  candidates?: number;
  /** Restrict to a single source. */
  source?: Source;
  /** Restrict to messages from / to / about a participant (matches id, name, or email). */
  participant?: string;
  /** Inclusive lower bound, epoch ms. */
  after?: number;
  /** Inclusive upper bound, epoch ms. */
  before?: number;
}

export interface SearchHit {
  message: Message;
  /** Final fused score, higher is better. */
  score: number;
  /** Sparse (BM25) score from FTS5, present when the message matched lexically. */
  bm25?: number;
  /** Dense (cosine) score, present when reranked by embedding. */
  cosine?: number;
}

/* ------------------------------- contracts ------------------------------- */

/**
 * Pulls messages from a source. Connectors are pure producers — they don't
 * touch the store; the indexer wires them together.
 *
 * `since` lets the indexer do incremental syncs; connectors should respect
 * it as a best-effort filter (skipping ahead is OK, returning extras is OK).
 */
export interface Connector {
  readonly name: string;
  readonly source: Source;
  fetch(opts?: { since?: number; signal?: AbortSignal }): AsyncIterable<Message>;
}

export interface Embedder {
  /** Vector dimension produced by `embed`. */
  readonly dimension: number;
  /** Identifier persisted alongside vectors so we can detect model changes. */
  readonly modelId: string;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface LlmClient {
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

export interface Store {
  /** Insert or replace messages by id. Idempotent. */
  upsertMessages(messages: Message[]): Promise<void>;
  /** Persist embeddings for messages keyed by message id. */
  upsertEmbeddings(
    rows: { id: string; modelId: string; vector: Float32Array }[],
  ): Promise<void>;
  /** Return ids that already have an embedding for the given model. */
  embeddedIds(modelId: string): Promise<Set<string>>;
  /** Hybrid search: BM25 candidates from FTS, optional embedding rerank. */
  search(query: string, queryVector: Float32Array | null, opts?: SearchOptions): Promise<SearchHit[]>;
  /** Look up a message by id. */
  getMessage(id: string): Promise<Message | null>;
  /** Return the full thread containing the given message id, ordered by time. */
  getThread(messageId: string): Promise<Thread | null>;
  /** Aggregate counts for diagnostics / `mneme status`. */
  stats(): Promise<{ messages: number; embeddings: number; sources: Record<string, number> }>;
  close(): void;
}
