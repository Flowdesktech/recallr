import type { Connector, Embedder, Message, Store } from "./types.js";

export interface IndexProgress {
  fetched: number;
  stored: number;
  embedded: number;
  /** Messages skipped because they were already indexed and embedded. */
  skipped: number;
  /** The most recent message just touched, for live progress UIs. */
  lastSubject?: string;
}

export interface IndexOptions {
  /**
   * Skip embedding (lexical-only index). Useful for very large initial
   * imports; you can run `recallr reindex --embed` afterwards.
   */
  skipEmbeddings?: boolean;
  /** Only fetch messages newer than this epoch ms. */
  since?: number;
  /** Called periodically with progress. */
  onProgress?: (p: IndexProgress) => void;
  /** Cancel an in-progress sync. */
  signal?: AbortSignal;
  /** How many messages to flush per batch. Default 100. */
  batchSize?: number;
}

/**
 * Drive a connector to completion: fetch -> store -> embed -> persist.
 *
 * The indexer is intentionally a free function (not a class) because it
 * has no state of its own. State lives in the Store; everything else is
 * pure transformation.
 *
 * Embedding is the slow path so we batch aggressively. The default of 100
 * messages per flush gives a good balance between checkpoint frequency
 * (so a Ctrl+C doesn't lose much) and embed throughput.
 */
export async function indexConnector(args: {
  connector: Connector;
  store: Store;
  embedder?: Embedder;
  options?: IndexOptions;
}): Promise<IndexProgress> {
  const { connector, store, embedder, options } = args;
  const onProgress = options?.onProgress;
  const batchSize = options?.batchSize ?? 100;
  const skipEmbed = options?.skipEmbeddings || !embedder;

  const progress: IndexProgress = { fetched: 0, stored: 0, embedded: 0, skipped: 0 };
  const alreadyEmbedded = embedder ? await store.embeddedIds(embedder.modelId) : new Set<string>();

  let buffer: Message[] = [];

  const flush = async (): Promise<void> => {
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    await store.upsertMessages(batch);
    progress.stored += batch.length;

    if (!skipEmbed && embedder) {
      const toEmbed = batch.filter((m) => !alreadyEmbedded.has(m.id));
      if (toEmbed.length > 0) {
        const inputs = toEmbed.map(messageToEmbeddingText);
        const vectors = await embedder.embed(inputs);
        const rows = toEmbed.map((m, i) => ({
          id: m.id,
          modelId: embedder.modelId,
          vector: vectors[i] ?? new Float32Array(embedder.dimension),
        }));
        await store.upsertEmbeddings(rows);
        for (const m of toEmbed) alreadyEmbedded.add(m.id);
        progress.embedded += toEmbed.length;
      }
      progress.skipped += batch.length - toEmbed.length;
    }
    onProgress?.(progress);
  };

  for await (const msg of connector.fetch({
    since: options?.since,
    signal: options?.signal,
  })) {
    if (options?.signal?.aborted) break;
    progress.fetched++;
    progress.lastSubject = msg.subject;
    buffer.push(msg);
    if (buffer.length >= batchSize) await flush();
    if (progress.fetched % 25 === 0) onProgress?.(progress);
  }
  await flush();
  return progress;
}

/**
 * Compose the text passed to the embedder. Subject is prepended so it
 * dominates short messages; participants help disambiguate ("the Q3 reply
 * from Ana") even when the body is generic.
 */
function messageToEmbeddingText(m: Message): string {
  const parts: string[] = [];
  if (m.subject) parts.push(m.subject);
  parts.push(`From: ${m.from.name ?? m.from.email ?? m.from.id}`);
  if (m.to.length > 0) {
    parts.push(`To: ${m.to.map((p) => p.name ?? p.email ?? p.id).join(", ")}`);
  }
  parts.push(m.body);
  return parts.join("\n");
}
