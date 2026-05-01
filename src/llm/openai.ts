import type { ChatMessage, ChatOptions, LlmClient } from "../types.js";

/**
 * Provider presets. Every supported endpoint speaks the OpenAI
 * `/v1/chat/completions` shape — Anthropic and Google publish official
 * compatibility layers, Ollama / LM Studio / OpenRouter / Groq / Together
 * all expose it natively.
 *
 *   https://docs.anthropic.com/en/api/openai-sdk
 *   https://ai.google.dev/gemini-api/docs/openai
 */
export const PROVIDERS = {
  openai: { baseUrl: "https://api.openai.com/v1", defaultModel: "gpt-5.5-mini" },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-haiku-4-7-latest",
  },
  gemini: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.0-flash",
  },
  ollama: { baseUrl: "http://localhost:11434/v1", defaultModel: "llama3.2" },
} as const;

/**
 * OpenAI-compatible chat client. Works with any provider that speaks
 * the `/v1/chat/completions` API.
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
        `recallr: failed to reach LLM at ${url} (${cause}).\n` +
          "Pick one and try again:\n" +
          "  • Local (free):  install https://ollama.com, then `ollama serve` + `ollama pull llama3.2`\n" +
          "  • OpenAI:       export OPENAI_API_KEY=sk-...\n" +
          "  • Anthropic:    export ANTHROPIC_API_KEY=sk-ant-...\n" +
          "  • Google Gemini: export GEMINI_API_KEY=AIza...\n" +
          "  • Anything else (LM Studio, OpenRouter, Groq, Together, …):\n" +
          "      export RECALLR_LLM_BASE_URL=https://openrouter.ai/api/v1\n" +
          "      export RECALLR_LLM_MODEL=anthropic/claude-opus-4.7\n" +
          "      export RECALLR_LLM_API_KEY=sk-or-...\n" +
          "Run `recallr ask --help` for a full provider matrix.",
      );
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `recallr: LLM returned ${res.status} ${res.statusText} from ${url}\n${text.slice(0, 500)}`,
      );
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`recallr: LLM response had no message content: ${JSON.stringify(json).slice(0, 300)}`);
    }
    return content;
  }
}

/**
 * Resolution order (most-specific wins):
 *   1. Explicit overrides passed in (e.g. CLI flags).
 *   2. `RECALLR_LLM_BASE_URL` / `RECALLR_LLM_MODEL` / `RECALLR_LLM_API_KEY` env vars.
 *   3. `llm` block from `~/.recallr/config.json` (passed in via `fromConfig`).
 *   4. Provider shortcut env vars (first one set wins, in declaration order):
 *        - `OPENAI_API_KEY`        -> OpenAI cloud
 *        - `ANTHROPIC_API_KEY`     -> Anthropic via OpenAI compat layer
 *        - `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) -> Gemini via OpenAI compat layer
 *   5. Default -> Ollama at `http://localhost:11434/v1` with `llama3.2`.
 *
 * The Ollama fallback matches the project's local-first ethos:
 * no env vars or accounts needed if you have Ollama running.
 */
export interface LlmOverrides {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface LlmFromConfig {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export function llmFromEnv(
  overrides: LlmOverrides = {},
  fromConfig: LlmFromConfig = {},
): OpenAiCompatClient {
  const baseUrl =
    overrides.baseUrl ?? process.env.RECALLR_LLM_BASE_URL ?? fromConfig.baseUrl;
  const model = overrides.model ?? process.env.RECALLR_LLM_MODEL ?? fromConfig.model;

  // Explicit baseUrl path: caller picked the endpoint, just plumb through.
  if (baseUrl) {
    const apiKey =
      overrides.apiKey ??
      process.env.RECALLR_LLM_API_KEY ??
      process.env.OPENAI_API_KEY ??
      fromConfig.apiKey;
    return new OpenAiCompatClient({
      baseUrl,
      apiKey,
      defaultModel: model ?? PROVIDERS.openai.defaultModel,
    });
  }

  // Provider shortcut: detect well-known cloud-provider env vars.
  // OpenAI wins over the others when multiple are set, preserving the
  // historical default. Users with multiple keys should pin one via
  // RECALLR_LLM_BASE_URL or config.json.
  const shortcut = detectProviderShortcut(overrides.apiKey ?? fromConfig.apiKey);
  if (shortcut) {
    return new OpenAiCompatClient({
      baseUrl: shortcut.baseUrl,
      apiKey: shortcut.apiKey,
      defaultModel: model ?? shortcut.defaultModel,
    });
  }

  // Last-resort fallback: local Ollama. No env vars or accounts needed
  // beyond `ollama serve` running on the default port.
  return new OpenAiCompatClient({
    baseUrl: PROVIDERS.ollama.baseUrl,
    apiKey: "ollama",
    defaultModel: model ?? PROVIDERS.ollama.defaultModel,
  });
}

interface ProviderShortcut {
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
}

function detectProviderShortcut(
  fallbackApiKey: string | undefined,
): ProviderShortcut | null {
  if (process.env.OPENAI_API_KEY) {
    return {
      baseUrl: PROVIDERS.openai.baseUrl,
      apiKey: process.env.OPENAI_API_KEY,
      defaultModel: PROVIDERS.openai.defaultModel,
    };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      baseUrl: PROVIDERS.anthropic.baseUrl,
      apiKey: process.env.ANTHROPIC_API_KEY,
      defaultModel: PROVIDERS.anthropic.defaultModel,
    };
  }
  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (geminiKey) {
    return {
      baseUrl: PROVIDERS.gemini.baseUrl,
      apiKey: geminiKey,
      defaultModel: PROVIDERS.gemini.defaultModel,
    };
  }
  // No env shortcut, but a config-file or CLI apiKey was passed without
  // a baseUrl — assume OpenAI cloud, matching pre-shortcut behaviour.
  if (fallbackApiKey) {
    return {
      baseUrl: PROVIDERS.openai.baseUrl,
      apiKey: fallbackApiKey,
      defaultModel: PROVIDERS.openai.defaultModel,
    };
  }
  return null;
}
