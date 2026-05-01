import type { ChatMessage, Embedder, LlmClient, SearchHit, SearchOptions, Store } from "./types.js";

export interface AskOptions extends SearchOptions {
  /** Override the system prompt (rarely needed). */
  systemPrompt?: string;
  /** Cancel an in-flight ask. */
  signal?: AbortSignal;
}

export interface AskResult {
  /** The model's answer text. */
  answer: string;
  /** The hits used as context for the answer, in the order shown to the model. */
  citations: SearchHit[];
}

/**
 * Retrieval-augmented question-answering over a Store.
 *
 * The pipeline:
 *   1. Embed the user's question (if an embedder is supplied).
 *   2. Hybrid search: BM25 candidates -> cosine rerank -> top-K.
 *   3. Stuff the top-K into a structured prompt with explicit citation tags.
 *   4. Ask the LLM for an answer that cites those tags.
 *
 * The prompt forces the model to cite via `[#1]`, `[#2]` markers tied to
 * the message ids it was shown — this matches what we render back to the
 * user, so they can drill into any cited message.
 */
export async function ask(args: {
  question: string;
  store: Store;
  llm: LlmClient;
  embedder?: Embedder;
  options?: AskOptions;
}): Promise<AskResult> {
  const { question, store, llm, embedder, options } = args;
  const limit = options?.limit ?? 8;

  let queryVector: Float32Array | null = null;
  if (embedder) {
    const [v] = await embedder.embed([question]);
    queryVector = v ?? null;
  }

  const hits = await store.search(question, queryVector, { ...options, limit });

  const systemPrompt =
    options?.systemPrompt ??
    [
      "You are a precise assistant that answers questions using ONLY the provided messages.",
      "Cite every fact with the bracketed id of the source message, e.g. [#3].",
      "If the answer is not in the messages, say you don't know — never invent.",
      "Quote a short verbatim phrase from the source when it strengthens the answer.",
      "When summarizing across many messages, group by sender or thread.",
    ].join(" ");

  const context = hits
    .map((h, i) => formatHitForPrompt(h, i + 1))
    .join("\n\n---\n\n");

  const userPrompt = [
    `Question: ${question}`,
    "",
    "Messages (context, ordered most-relevant first):",
    "",
    context || "(no matching messages found)",
    "",
    "Answer the question using ONLY the messages above. Cite sources as [#1], [#2], etc.",
  ].join("\n");

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const answer = await llm.chat(messages, { signal: options?.signal });
  return { answer, citations: hits };
}

function formatHitForPrompt(hit: SearchHit, ordinal: number): string {
  const m = hit.message;
  const date = new Date(m.timestamp).toISOString().slice(0, 16).replace("T", " ");
  const who =
    m.from.name && m.from.email
      ? `${m.from.name} <${m.from.email}>`
      : (m.from.name ?? m.from.email ?? m.from.id);
  const where =
    m.source === "imap" || m.source === "mbox" || m.source === "gmail"
      ? `${m.source}${m.channel ? `/${m.channel}` : ""}`
      : `${m.source}${m.channel ? ` #${m.channel}` : ""}`;

  // Cap per-message body to keep total context comfortably under 8k tokens
  // even with 8 hits. Most retrievals are well-served by ~1k chars per hit.
  const body = m.body.length > 1200 ? `${m.body.slice(0, 1200)}...` : m.body;

  return [
    `[#${ordinal}] (${where} · ${date} · from ${who})`,
    m.subject ? `Subject: ${m.subject}` : null,
    "",
    body,
  ]
    .filter((x) => x !== null)
    .join("\n");
}
