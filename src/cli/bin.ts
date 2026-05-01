#!/usr/bin/env node
import { Command } from "commander";
import { askCommand } from "./commands/ask.js";
import { indexCommand } from "./commands/index.js";
import { initCommand } from "./commands/init.js";
import { mcpCommand } from "./commands/mcp.js";
import { serveCommand } from "./commands/serve.js";
import { statusCommand } from "./commands/status.js";

const program = new Command();

program
  .name("recallr")
  .description(
    "Local-first memory for every message you've ever sent.\n\n" +
      "Typical first run:\n" +
      "  recallr init                                         # create ~/.recallr/\n" +
      "  recallr index ~/Downloads/gmail-takeout.mbox         # ingest some data\n" +
      '  recallr ask  "what did Ana decide about pricing?"    # query it\n' +
      "  recallr serve                                        # or open the web UI\n" +
      "  recallr mcp                                          # or wire it into Cursor / Claude\n\n" +
      "Connecting an LLM (one env var is enough for the cloud providers):\n" +
      "  • OPENAI_API_KEY=sk-...        → OpenAI         (gpt-5.5-mini)\n" +
      "  • ANTHROPIC_API_KEY=sk-ant-... → Anthropic      (claude-haiku-4-7-latest)\n" +
      "  • GEMINI_API_KEY=AIza...       → Google Gemini  (gemini-3.0-flash)\n" +
      "  • nothing set                  → Ollama at http://localhost:11434/v1\n" +
      "  • LM Studio / OpenRouter / Groq / Together / etc. — point at any\n" +
      "    OpenAI-compatible endpoint via RECALLR_LLM_BASE_URL + RECALLR_LLM_MODEL.\n" +
      "  See `recallr ask --help` for the full matrix and per-call --llm-* flags.",
  )
  .version("0.2.0");

program.addCommand(initCommand());
program.addCommand(indexCommand());
program.addCommand(askCommand());
program.addCommand(serveCommand());
program.addCommand(mcpCommand());
program.addCommand(statusCommand());

program.parseAsync(process.argv).catch((err) => {
  let msg = err instanceof Error ? err.message : String(err);
  if (!msg.startsWith("recallr:")) msg = `recallr: ${msg}`;
  process.stderr.write(`${msg}\n`);
  process.exit(1);
});
