import type { Embedder } from "../types.js";

/**
 * Local embeddings via @huggingface/transformers (ONNX Runtime).
 *
 * The default model is bge-small-en-v1.5 — 384 dims, ~33MB, strong on
 * MTEB retrieval benchmarks, and runs fine on a CPU. The model is
 * downloaded to the user's HF cache on first use, then cached forever.
 *
 * Heavy dependency, so we lazy-import it inside `init()`. That keeps
 * `recallr --help` and `recallr status` instant for users who never run
 * the indexer (e.g. they only use the MCP server against a pre-built db).
 */
export class LocalEmbedder implements Embedder {
  readonly modelId: string;
  readonly dimension: number;
  private pipe:
    | ((
        input: string | string[],
        opts: { pooling: "mean"; normalize: boolean },
      ) => Promise<{ data: Float32Array; dims: number[] }>)
    | null = null;
  private readonly hfModel: string;

  private constructor(hfModel: string, dimension: number) {
    this.hfModel = hfModel;
    this.modelId = `hf:${hfModel}`;
    this.dimension = dimension;
  }

  /**
   * Construct and warm up an embedder. The model is downloaded on first use
   * and cached, so subsequent calls are instant.
   *
   * Defaults match `Xenova/bge-small-en-v1.5` (384 dims). Override `model`
   * with any sentence-transformers ONNX model on the HF hub.
   */
  static async load(opts?: {
    model?: string;
    dimension?: number;
  }): Promise<LocalEmbedder> {
    const model = opts?.model ?? "Xenova/bge-small-en-v1.5";
    const dimension = opts?.dimension ?? 384;
    const e = new LocalEmbedder(model, dimension);
    await e.init();
    return e;
  }

  private async init(): Promise<void> {
    if (this.pipe) return;
    const tx = await import("@huggingface/transformers");
    // Quiet down the loader noise.
    tx.env.allowLocalModels = false;
    const pipeline = await tx.pipeline("feature-extraction", this.hfModel, {
      // dtype: "q8" gives ~2x speed at small quality cost. We default to fp32
      // for v0.1 to keep results aligned with the published MTEB scores.
      dtype: "fp32",
    });
    this.pipe = pipeline as unknown as typeof this.pipe;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!this.pipe) await this.init();
    const pipe = this.pipe;
    if (!pipe) throw new Error("embedder failed to initialize");

    // Process in batches of 16 — keeps memory bounded and is faster than
    // many tiny single-text calls (transformers.js batches under the hood).
    const out: Float32Array[] = [];
    const batchSize = 16;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map(prepareForEmbedding);
      const result = await pipe(batch, { pooling: "mean", normalize: true });
      // result.data is a flat Float32Array of [batchLen * dim].
      // Slice into per-text vectors.
      const dim = this.dimension;
      for (let j = 0; j < batch.length; j++) {
        const start = j * dim;
        const slice = result.data.slice(start, start + dim);
        // Copy so we don't hold a reference to the underlying tensor buffer.
        out.push(new Float32Array(slice));
      }
    }
    return out;
  }
}

/**
 * Trim a message body to ~512 tokens worth of content. We use a 2KB
 * char cap as a fast proxy and prepend the subject line so it
 * dominates the pooled embedding for short messages.
 */
function prepareForEmbedding(text: string): string {
  // Strip excessive whitespace and quoted reply chains so embeddings
  // capture the *new* content rather than 12 levels of "On Mon...".
  const cleaned = text
    .replace(/^>.*$/gm, "")
    .replace(/On .+ wrote:[\s\S]*$/m, "")
    .replace(/-{2,}\s*Original Message\s*-{2,}[\s\S]*$/i, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned.length > 2048 ? cleaned.slice(0, 2048) : cleaned;
}
