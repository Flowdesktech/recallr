import { Command } from "commander";
import pc from "picocolors";
import { ask } from "../../ask.js";
import { loadConfig } from "../../config.js";
import { LocalEmbedder } from "../../embed/local.js";
import { llmFromEnv } from "../../llm/openai.js";
import { SqliteStore } from "../../store/sqlite.js";

export function askCommand(): Command {
  return new Command("ask")
    .description(
      "Ask a question. Recallr retrieves relevant messages and answers with citations.\n\n" +
        "Connecting an LLM (resolution order, most-specific wins):\n" +
        "  1. CLI flags:    --llm-base-url, --llm-model, --llm-api-key\n" +
        "  2. Env vars:     RECALLR_LLM_BASE_URL, RECALLR_LLM_MODEL, RECALLR_LLM_API_KEY\n" +
        "  3. Config file:  llm block in ~/.recallr/config.json\n" +
        "  4. Provider shortcut env vars (first one wins):\n" +
        "       OPENAI_API_KEY      → OpenAI         (gpt-5.5-mini)\n" +
        "       ANTHROPIC_API_KEY   → Anthropic      (claude-haiku-4-7-latest)\n" +
        "       GEMINI_API_KEY      → Google Gemini  (gemini-3.0-flash)\n" +
        "  5. Default:        Ollama at http://localhost:11434/v1 (llama3.2)\n\n" +
        "Quick provider recipes:\n" +
        "  Ollama (local, free):\n" +
        "    ollama serve && ollama pull llama3.2\n" +
        '    recallr ask "..."\n' +
        "  OpenAI:\n" +
        "    export OPENAI_API_KEY=sk-...\n" +
        '    recallr ask "..."                                    # gpt-5.5-mini\n' +
        '    recallr ask --llm-model gpt-5.5 "..."                # any OpenAI model\n' +
        "  Anthropic Claude:\n" +
        "    export ANTHROPIC_API_KEY=sk-ant-...\n" +
        '    recallr ask "..."                                    # claude-haiku-4-7-latest\n' +
        '    recallr ask --llm-model claude-opus-4-7-latest "..."\n' +
        "  Google Gemini:\n" +
        "    export GEMINI_API_KEY=AIza...\n" +
        '    recallr ask "..."                                    # gemini-3.0-flash\n' +
        '    recallr ask --llm-model gemini-3.1-pro "..."\n' +
        "  LM Studio:\n" +
        "    recallr ask --llm-base-url http://localhost:1234/v1 \\\n" +
        '                --llm-model my-local-model "..."\n' +
        "  OpenRouter / Groq / Together (anything OpenAI-compatible):\n" +
        "    export RECALLR_LLM_BASE_URL=https://openrouter.ai/api/v1\n" +
        "    export RECALLR_LLM_MODEL=meta-llama/llama-3.3-70b-instruct\n" +
        "    export RECALLR_LLM_API_KEY=sk-or-...\n" +
        '    recallr ask "..."',
    )
    .argument("<question...>", "The question to ask")
    .option(
      "-k, --limit <n>",
      "Number of messages to use as context",
      (v) => Number.parseInt(v, 10),
      8,
    )
    .option("--source <source>", "Restrict to a single source (imap, mbox, slack, ...)")
    .option("--no-embed", "Lexical search only (skip embedding the question)")
    .option("--show-context", "Also print the messages used as context", false)
    .option("--llm-base-url <url>", "OpenAI-compatible base URL (e.g. http://localhost:11434/v1)")
    .option(
      "--llm-model <model>",
      "Model id passed to the LLM (e.g. gpt-5.5, claude-opus-4-7-latest, llama3.2)",
    )
    .option(
      "--llm-api-key <key>",
      "Bearer token for the LLM endpoint (use --llm-api-key=ollama for local Ollama)",
    )
    .action(
      async (
        questionParts: string[],
        opts: {
          limit: number;
          source?: string;
          embed: boolean;
          showContext: boolean;
          llmBaseUrl?: string;
          llmModel?: string;
          llmApiKey?: string;
        },
      ) => {
        const question = questionParts.join(" ").trim();
        if (!question) {
          process.stderr.write("recallr: please provide a question\n");
          process.exit(2);
        }

        const cfg = await loadConfig();
        const store = await SqliteStore.open(cfg.dbPath);
        try {
          const embedder = opts.embed
            ? await LocalEmbedder.load({
                model: cfg.embedModel,
                dimension: cfg.embedDimension,
              })
            : undefined;
          const llm = llmFromEnv(
            {
              baseUrl: opts.llmBaseUrl,
              model: opts.llmModel,
              apiKey: opts.llmApiKey,
            },
            cfg.llm,
          );

          const result = await ask({
            question,
            store,
            llm,
            embedder,
            options: {
              limit: opts.limit,
              source: opts.source as never,
            },
          });

          process.stdout.write(`\n${pc.bold(result.answer)}\n\n`);

          if (result.citations.length > 0) {
            process.stdout.write(`${pc.dim("Sources:")}\n`);
            result.citations.forEach((h, i) => {
              const m = h.message;
              const date = new Date(m.timestamp).toISOString().slice(0, 10);
              const who = m.from.name ?? m.from.email ?? m.from.id;
              const subject = m.subject ?? "(no subject)";
              process.stdout.write(
                `  ${pc.cyan(`[#${i + 1}]`)} ${date} · ${who} · ${pc.dim(subject)}\n`,
              );
              if (opts.showContext) {
                const snippet = m.body.slice(0, 200).replace(/\s+/g, " ");
                process.stdout.write(`      ${pc.dim(snippet)}\n`);
              }
            });
            process.stdout.write("\n");
          }
        } finally {
          store.close();
        }
      },
    );
}
