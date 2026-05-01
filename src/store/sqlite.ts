import Database, { type Database as Db } from "better-sqlite3";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  Attachment,
  Message,
  Participant,
  SearchHit,
  SearchOptions,
  Source,
  Store,
  Thread,
} from "../types.js";

/**
 * SQLite-backed store. Single file, no daemon, embeddable.
 *
 * Schema rationale:
 *   - `messages` is the canonical row.
 *   - `messages_fts` is an FTS5 contentless table that mirrors
 *     `body` + `subject` + `from_name` for BM25 candidate retrieval.
 *   - `embeddings` stores the dense vector as a BLOB (Float32 little-endian).
 *     We deliberately do NOT use sqlite-vec in v0.1: the install story
 *     gets messier across platforms, and BM25-top-K + JS cosine rerank
 *     is fast and sufficient up to ~250k messages. Switching to
 *     sqlite-vec for >100k corpora is planned for v0.2.
 *
 * Search is hybrid by default: pull `candidates` BM25 hits (default 200),
 * load their vectors, rerank by cosine, return `limit` (default 10).
 * If no query vector is supplied we return the BM25 results directly,
 * which keeps `mneme search` cheap when an embedder isn't configured.
 */
export class SqliteStore implements Store {
  private readonly db: Db;
  private readonly stmts: ReturnType<typeof prepareStatements>;

  private constructor(db: Db) {
    this.db = db;
    this.stmts = prepareStatements(db);
  }

  static async open(path: string): Promise<SqliteStore> {
    await mkdir(dirname(path), { recursive: true });
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("temp_store = MEMORY");
    db.pragma("mmap_size = 268435456");
    applySchema(db);
    return new SqliteStore(db);
  }

  async upsertMessages(messages: Message[]): Promise<void> {
    if (messages.length === 0) return;
    const tx = this.db.transaction((batch: Message[]) => {
      for (const m of batch) {
        const fromJson = JSON.stringify(m.from);
        const toJson = JSON.stringify(m.to);
        const ccJson = m.cc ? JSON.stringify(m.cc) : null;
        const bccJson = m.bcc ? JSON.stringify(m.bcc) : null;
        const attachmentsJson = m.attachments ? JSON.stringify(m.attachments) : null;
        const provenanceJson = m.provenance ? JSON.stringify(m.provenance) : null;

        this.stmts.upsertMessage.run({
          id: m.id,
          source: m.source,
          source_id: m.sourceId,
          channel: m.channel ?? null,
          thread_id: m.threadId ?? null,
          subject: m.subject ?? null,
          body: m.body,
          from_id: m.from.id,
          from_name: m.from.name ?? null,
          from_email: m.from.email ?? null,
          from_json: fromJson,
          to_json: toJson,
          cc_json: ccJson,
          bcc_json: bccJson,
          timestamp: m.timestamp,
          attachments_json: attachmentsJson,
          provenance_json: provenanceJson,
        });

        // FTS uses rowid -> we link via the messages.rowid implicitly
        this.stmts.deleteFts.run(m.id);
        this.stmts.insertFts.run({
          id: m.id,
          subject: m.subject ?? "",
          body: m.body,
          from_text: [m.from.name, m.from.email, m.from.id]
            .filter(Boolean)
            .join(" "),
          to_text: m.to
            .map((p) => [p.name, p.email, p.id].filter(Boolean).join(" "))
            .join(" "),
        });
      }
    });
    tx(messages);
  }

  async upsertEmbeddings(
    rows: { id: string; modelId: string; vector: Float32Array }[],
  ): Promise<void> {
    if (rows.length === 0) return;
    const tx = this.db.transaction(
      (batch: { id: string; modelId: string; vector: Float32Array }[]) => {
        for (const r of batch) {
          this.stmts.upsertEmbedding.run({
            id: r.id,
            model_id: r.modelId,
            dim: r.vector.length,
            vector: Buffer.from(r.vector.buffer, r.vector.byteOffset, r.vector.byteLength),
          });
        }
      },
    );
    tx(rows);
  }

  async embeddedIds(modelId: string): Promise<Set<string>> {
    const rows = this.stmts.listEmbeddedIds.all({ model_id: modelId }) as {
      id: string;
    }[];
    return new Set(rows.map((r) => r.id));
  }

  async search(
    query: string,
    queryVector: Float32Array | null,
    opts: SearchOptions = {},
  ): Promise<SearchHit[]> {
    const limit = opts.limit ?? 10;
    const candidates = Math.max(limit, opts.candidates ?? 200);

    // Build FTS query. We sanitize by splitting on whitespace and
    // wrapping each token in double quotes so FTS5 syntax characters
    // in user input don't blow up the parser.
    const ftsQuery = sanitizeFtsQuery(query);

    const filterSql: string[] = [];
    const filterParams: Record<string, unknown> = {};
    if (opts.source) {
      filterSql.push("m.source = @source");
      filterParams.source = opts.source;
    }
    if (opts.after !== undefined) {
      filterSql.push("m.timestamp >= @after");
      filterParams.after = opts.after;
    }
    if (opts.before !== undefined) {
      filterSql.push("m.timestamp <= @before");
      filterParams.before = opts.before;
    }
    if (opts.participant) {
      filterSql.push(
        "(m.from_id = @participant OR m.from_email = @participant OR m.from_name LIKE @participant_like OR m.to_json LIKE @participant_like)",
      );
      filterParams.participant = opts.participant;
      filterParams.participant_like = `%${opts.participant}%`;
    }
    const whereExtra = filterSql.length ? `AND ${filterSql.join(" AND ")}` : "";

    type Row = {
      id: string;
      source: Source;
      source_id: string;
      channel: string | null;
      thread_id: string | null;
      subject: string | null;
      body: string;
      from_json: string;
      to_json: string;
      cc_json: string | null;
      bcc_json: string | null;
      timestamp: number;
      attachments_json: string | null;
      provenance_json: string | null;
      bm25: number;
      vector: Buffer | null;
    };

    let rows: Row[];
    if (ftsQuery) {
      const sql = `
        SELECT m.*, bm25(messages_fts) AS bm25, e.vector AS vector
        FROM messages_fts
        JOIN messages m ON m.id = messages_fts.message_id
        LEFT JOIN embeddings e ON e.message_id = m.id
        WHERE messages_fts MATCH @q ${whereExtra}
        ORDER BY bm25 ASC
        LIMIT @candidates
      `;
      rows = this.db.prepare(sql).all({
        q: ftsQuery,
        candidates,
        ...filterParams,
      }) as Row[];
    } else {
      // No usable lexical query — fall back to recency over the filter.
      const sql = `
        SELECT m.*, 0 AS bm25, e.vector AS vector
        FROM messages m
        LEFT JOIN embeddings e ON e.message_id = m.id
        WHERE 1=1 ${whereExtra}
        ORDER BY m.timestamp DESC
        LIMIT @candidates
      `;
      rows = this.db.prepare(sql).all({
        candidates,
        ...filterParams,
      }) as Row[];
    }

    const hits: SearchHit[] = rows.map((r) => {
      // FTS5 bm25() returns a NEGATIVE score where smaller is better.
      // We invert so larger is better and add an epsilon so all scores are positive.
      const bm25Score = ftsQuery ? -r.bm25 : 0;
      let cosine: number | undefined;
      if (queryVector && r.vector) {
        cosine = cosineFromBuffer(queryVector, r.vector);
      }
      // Score fusion: if we have both signals, use a 0.4 BM25 / 0.6 cosine blend
      // after min-max normalization within the candidate set. We do that pass below.
      return {
        message: rowToMessage(r),
        score: cosine ?? bm25Score,
        bm25: ftsQuery ? bm25Score : undefined,
        cosine,
      };
    });

    // Min-max fuse if we have both signals.
    if (queryVector && ftsQuery) {
      const bms = hits.map((h) => h.bm25 ?? 0);
      const cos = hits.map((h) => h.cosine ?? 0);
      const minB = Math.min(...bms);
      const maxB = Math.max(...bms);
      const minC = Math.min(...cos);
      const maxC = Math.max(...cos);
      for (const h of hits) {
        const nb = maxB > minB ? ((h.bm25 ?? 0) - minB) / (maxB - minB) : 0;
        const nc = maxC > minC ? ((h.cosine ?? 0) - minC) / (maxC - minC) : 0;
        h.score = 0.4 * nb + 0.6 * nc;
      }
    }

    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }

  async getMessage(id: string): Promise<Message | null> {
    const row = this.stmts.getMessage.get({ id }) as
      | (Omit<MessageRow, "bm25" | "vector"> & Record<string, unknown>)
      | undefined;
    return row ? rowToMessage(row as MessageRow) : null;
  }

  async getThread(messageId: string): Promise<Thread | null> {
    const seed = await this.getMessage(messageId);
    if (!seed) return null;
    if (!seed.threadId) {
      // Thread of one.
      return {
        id: seed.id,
        source: seed.source,
        channel: seed.channel,
        subject: seed.subject,
        participants: dedupeParticipants([seed.from, ...seed.to]),
        messages: [seed],
        lastTimestamp: seed.timestamp,
      };
    }
    const rows = this.stmts.getThread.all({
      thread_id: seed.threadId,
      source: seed.source,
    }) as MessageRow[];
    const messages = rows.map(rowToMessage);
    const participants = dedupeParticipants(
      messages.flatMap((m) => [m.from, ...m.to, ...(m.cc ?? [])]),
    );
    return {
      id: seed.threadId,
      source: seed.source,
      channel: seed.channel,
      subject: messages[0]?.subject,
      participants,
      messages,
      lastTimestamp: messages[messages.length - 1]?.timestamp ?? seed.timestamp,
    };
  }

  async stats(): Promise<{
    messages: number;
    embeddings: number;
    sources: Record<string, number>;
  }> {
    const messages =
      (this.db.prepare("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n;
    const embeddings =
      (this.db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number }).n;
    const sourceRows = this.db
      .prepare("SELECT source, COUNT(*) AS n FROM messages GROUP BY source")
      .all() as { source: string; n: number }[];
    const sources: Record<string, number> = {};
    for (const r of sourceRows) sources[r.source] = r.n;
    return { messages, embeddings, sources };
  }

  close(): void {
    this.db.close();
  }
}

/* ----------------------------- internal helpers --------------------------- */

interface MessageRow {
  id: string;
  source: Source;
  source_id: string;
  channel: string | null;
  thread_id: string | null;
  subject: string | null;
  body: string;
  from_json: string;
  to_json: string;
  cc_json: string | null;
  bcc_json: string | null;
  timestamp: number;
  attachments_json: string | null;
  provenance_json: string | null;
  bm25?: number;
  vector?: Buffer | null;
}

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    source: r.source,
    sourceId: r.source_id,
    channel: r.channel ?? undefined,
    threadId: r.thread_id ?? undefined,
    subject: r.subject ?? undefined,
    body: r.body,
    from: JSON.parse(r.from_json) as Participant,
    to: JSON.parse(r.to_json) as Participant[],
    cc: r.cc_json ? (JSON.parse(r.cc_json) as Participant[]) : undefined,
    bcc: r.bcc_json ? (JSON.parse(r.bcc_json) as Participant[]) : undefined,
    timestamp: r.timestamp,
    attachments: r.attachments_json
      ? (JSON.parse(r.attachments_json) as Attachment[])
      : undefined,
    provenance: r.provenance_json
      ? (JSON.parse(r.provenance_json) as Record<string, string>)
      : undefined,
  };
}

function dedupeParticipants(ps: Participant[]): Participant[] {
  const seen = new Map<string, Participant>();
  for (const p of ps) {
    if (!seen.has(p.id)) seen.set(p.id, p);
  }
  return [...seen.values()];
}

function cosineFromBuffer(query: Float32Array, buf: Buffer): number {
  // Buffer is a Float32 little-endian dump of the stored vector.
  const stored = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  if (stored.length !== query.length) return 0;
  let dot = 0;
  let qn = 0;
  let sn = 0;
  for (let i = 0; i < stored.length; i++) {
    const q = query[i] ?? 0;
    const s = stored[i] ?? 0;
    dot += q * s;
    qn += q * q;
    sn += s * s;
  }
  const denom = Math.sqrt(qn) * Math.sqrt(sn);
  return denom === 0 ? 0 : dot / denom;
}

function sanitizeFtsQuery(input: string): string {
  // FTS5 treats special characters specially. We split on whitespace,
  // strip non-word/non-dash chars from each token, and quote them.
  // Empty result -> caller falls back to a non-FTS path.
  const tokens = input
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_-]/gu, ""))
    .filter((t) => t.length > 1);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

function applySchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id               TEXT PRIMARY KEY,
      source           TEXT NOT NULL,
      source_id        TEXT NOT NULL,
      channel          TEXT,
      thread_id        TEXT,
      subject          TEXT,
      body             TEXT NOT NULL,
      from_id          TEXT NOT NULL,
      from_name        TEXT,
      from_email       TEXT,
      from_json        TEXT NOT NULL,
      to_json          TEXT NOT NULL,
      cc_json          TEXT,
      bcc_json         TEXT,
      timestamp        INTEGER NOT NULL,
      attachments_json TEXT,
      provenance_json  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_thread
      ON messages(thread_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp
      ON messages(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_source
      ON messages(source, timestamp DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      subject,
      body,
      from_text,
      to_text,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      model_id   TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      vector     BLOB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_embeddings_model ON embeddings(model_id);
  `);
}

function prepareStatements(db: Db) {
  return {
    upsertMessage: db.prepare(`
      INSERT INTO messages (
        id, source, source_id, channel, thread_id, subject, body,
        from_id, from_name, from_email, from_json,
        to_json, cc_json, bcc_json,
        timestamp, attachments_json, provenance_json
      ) VALUES (
        @id, @source, @source_id, @channel, @thread_id, @subject, @body,
        @from_id, @from_name, @from_email, @from_json,
        @to_json, @cc_json, @bcc_json,
        @timestamp, @attachments_json, @provenance_json
      )
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        source_id = excluded.source_id,
        channel = excluded.channel,
        thread_id = excluded.thread_id,
        subject = excluded.subject,
        body = excluded.body,
        from_id = excluded.from_id,
        from_name = excluded.from_name,
        from_email = excluded.from_email,
        from_json = excluded.from_json,
        to_json = excluded.to_json,
        cc_json = excluded.cc_json,
        bcc_json = excluded.bcc_json,
        timestamp = excluded.timestamp,
        attachments_json = excluded.attachments_json,
        provenance_json = excluded.provenance_json
    `),
    deleteFts: db.prepare("DELETE FROM messages_fts WHERE message_id = ?"),
    insertFts: db.prepare(`
      INSERT INTO messages_fts (message_id, subject, body, from_text, to_text)
      VALUES (@id, @subject, @body, @from_text, @to_text)
    `),
    upsertEmbedding: db.prepare(`
      INSERT INTO embeddings (message_id, model_id, dim, vector)
      VALUES (@id, @model_id, @dim, @vector)
      ON CONFLICT(message_id) DO UPDATE SET
        model_id = excluded.model_id,
        dim      = excluded.dim,
        vector   = excluded.vector
    `),
    listEmbeddedIds: db.prepare(
      "SELECT message_id AS id FROM embeddings WHERE model_id = @model_id",
    ),
    getMessage: db.prepare("SELECT * FROM messages WHERE id = @id"),
    getThread: db.prepare(`
      SELECT * FROM messages
      WHERE thread_id = @thread_id AND source = @source
      ORDER BY timestamp ASC
    `),
  };
}
