import type { ChatMessage, ChatOptions, LlmClient } from "../types.js";

/**
 * OpenAI-compatible chat client. Works with any provider that speaks
 * the `/v1/chat/completions` API:
 *
 *   - OpenAI:        baseUrl=https://api.openai.com/v1
 *   - Ollama:        baseUrl=http://localhost:11434/v1   (apiKey can be "ollama")
 *   - LM Studio:     baseUrl=http://localhost:1234/v1
 *   - OpenRouter:    baseUrl=https://openrouter.ai/api/v1
 *   - Together:      baseUrl=https://api.together.xyz/v1
 *   - Groq:          baseUrl=https://api.groq.com/openai/v1
 *
 * We deliberately do not pull in `openai` as a dependency. The chat
 * completions surface is small and stable enough that a 60-line `fetch`
 * client gives us full control over timeouts, error messages, and
 * abort signals.
 */
export class OpenAiCompatClient implements LlmClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModel: string;
  private readonly defaultTemperature: number;
  private readonly defaultMaxTokens: number | undefined;

  constructor(opts: {
    baseUrl: string;
    apiKey?: string;
    defaultModel: string;
    defaultTemperature?: number;
    defaultMaxTokens?: number;
  }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? "";
    this.defaultModel = opts.defaultModel;
    this.defaultTemperature = opts.defaultTemperature ?? 0.2;
    this.defaultMaxTokens = opts.defaultMaxTokens;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    const model = opts.model ?? this.defaultModel;
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.temperature ?? this.defaultTemperature,
      stream: false,
    };
    const maxTokens = opts.maxTokens ?? this.defaultMaxTokens;
    if (maxTokens !== undefined) body.max_tokens = maxTokens;

    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const url = `${this.baseUrl}/chat/completions`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `mneme: failed to reach LLM at ${url} (${cause}). ` +
          `If you're using Ollama, run \`ollama serve\` and pull a model (\`ollama pull llama3.2\`).`,
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `mneme: LLM returned ${res.status} ${res.statusText} from ${url}\n${text.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`mneme: LLM response had no message content: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return content;
  }
}

/**
 * Construct an LLM client from environment variables.
 *
 * Resolution order:
 *   1. Explicit `MNEME_LLM_BASE_URL` + `MNEME_LLM_MODEL`
 *   2. `OPENAI_API_KEY` -> OpenAI cloud
 *   3. Default -> Ollama at localhost:11434 with `llama3.2`
 *
 * The default-to-Ollama fallback matches the project's local-first ethos:
 * no env vars needed if you have Ollama running.
 */
export function llmFromEnv(): OpenAiCompatClient {
  const baseUrl = process.env.MNEME_LLM_BASE_URL;
  const model = process.env.MNEME_LLM_MODEL;
  const apiKey = process.env.MNEME_LLM_API_KEY ?? process.env.OPENAI_API_KEY;

  if (baseUrl && model) {
    return new OpenAiCompatClient({ baseUrl, apiKey, defaultModel: model });
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAiCompatClient({
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      defaultModel: model ?? "gpt-4o-mini",
    });
  }
  return new OpenAiCompatClient({
    baseUrl: "http://localhost:11434/v1",
    apiKey: "ollama",
    defaultModel: model ?? "llama3.2",
  });
}
