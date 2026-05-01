import { Command } from "commander";
import pc from "picocolors";
import { ask } from "../../ask.js";
import { loadConfig } from "../../config.js";
import { LocalEmbedder } from "../../embed/local.js";
import { llmFromEnv } from "../../llm/openai.js";
import { SqliteStore } from "../../store/sqlite.js";

export function askCommand(): Command {
  return new Command("ask")
    .description("Ask a question. Mneme retrieves relevant messages and answers with citations.")
    .argument("<question...>", "The question to ask")
    .option("-k, --limit <n>", "Number of messages to use as context", (v) => Number.parseInt(v, 10), 8)
    .option("--source <source>", "Restrict to a single source (imap, mbox, slack, ...)")
    .option("--no-embed", "Lexical search only (skip embedding the question)")
    .option("--show-context", "Also print the messages used as context", false)
    .action(
      async (
        questionParts: string[],
        opts: {
          limit: number;
          source?: string;
          embed: boolean;
          showContext: boolean;
        },
      ) => {
        const question = questionParts.join(" ").trim();
        if (!question) {
          process.stderr.write("mneme: please provide a question\n");
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
          const llm = llmFromEnv();

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
