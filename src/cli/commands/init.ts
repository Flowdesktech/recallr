import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "../../config.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Create the local recallr home directory and a starter config.")
    .option("--force", "Overwrite an existing config.json", false)
    .action(async (opts: { force: boolean }) => {
      const cfg = await loadConfig();
      await mkdir(cfg.home, { recursive: true });
      const configPath = join(cfg.home, "config.json");

      const exists = await fileExists(configPath);
      if (exists && !opts.force) {
        process.stdout.write(
          `${pc.yellow("•")} ${configPath} already exists. Pass --force to overwrite.\n`,
        );
        return;
      }

      const starter = {
        $schema: "https://github.com/flowdesktech/recallr/raw/main/schema/config.schema.json",
        embedModel: cfg.embedModel,
        embedDimension: cfg.embedDimension,
        // LLM endpoint. Leave commented to fall back to one of these,
        // checked in order:
        //   1. OPENAI_API_KEY    -> OpenAI       (gpt-5.5-mini)
        //   2. ANTHROPIC_API_KEY -> Claude       (claude-haiku-4-7-latest)
        //   3. GEMINI_API_KEY    -> Gemini       (gemini-3.0-flash)
        //   4. Ollama at http://localhost:11434/v1 (llama3.2)
        // Env vars (RECALLR_LLM_*) and CLI flags (--llm-*) override this.
        llm: {
          // baseUrl: "https://api.openai.com/v1",
          // model: "gpt-5.5",
          // apiKey: "sk-..."
        },
        sources: [
          {
            type: "mbox",
            name: "example",
            path: "./examples/sample.mbox",
          },
          {
            type: "imap",
            name: "fastmail",
            host: "imap.fastmail.com",
            user: "you@example.com",
            pass: "REPLACE_WITH_APP_PASSWORD",
            mailboxes: ["INBOX", "Sent"],
          },
        ],
      };

      await writeFile(configPath, `${JSON.stringify(starter, null, 2)}\n`);
      process.stdout.write(
        `${pc.green("✓")} Initialized recallr home at ${pc.cyan(cfg.home)}\n  • Database will live at ${pc.cyan(cfg.dbPath)}\n  • Edit ${pc.cyan(configPath)} to add real sources\n  • Run ${pc.cyan("recallr index")} to start indexing\n\n${pc.bold("Connect an LLM (pick one):")}\n  • ${pc.cyan("Ollama")} (local, free) — install https://ollama.com, then:\n      ${pc.dim("ollama serve && ollama pull llama3.2")}\n  • ${pc.cyan("OpenAI")}:           ${pc.dim("export OPENAI_API_KEY=sk-...")}\n  • ${pc.cyan("Anthropic Claude")}: ${pc.dim("export ANTHROPIC_API_KEY=sk-ant-...")}\n  • ${pc.cyan("Google Gemini")}:    ${pc.dim("export GEMINI_API_KEY=AIza...")}\n  • ${pc.cyan("Anything OpenAI-compatible")} (LM Studio, OpenRouter, Groq, Together):\n      ${pc.dim("export RECALLR_LLM_BASE_URL=https://openrouter.ai/api/v1")}\n      ${pc.dim("export RECALLR_LLM_MODEL=meta-llama/llama-3.3-70b-instruct")}\n      ${pc.dim("export RECALLR_LLM_API_KEY=sk-or-...")}\n  Run ${pc.cyan("recallr ask --help")} for the full matrix.\n`,
      );
    });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
