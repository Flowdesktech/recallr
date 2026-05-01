#!/usr/bin/env node
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { indexCommand } from "./commands/index.js";
import { askCommand } from "./commands/ask.js";
import { mcpCommand } from "./commands/mcp.js";
import { serveCommand } from "./commands/serve.js";
import { statusCommand } from "./commands/status.js";

const program = new Command();

program
  .name("mneme")
  .description(
    "Local-first memory for every message you've ever sent.\n\n" +
      "Index your inboxes once, then ask questions across all of them — from\n" +
      "your CLI, from a local web UI, or from any AI assistant via MCP.",
  )
  .version("0.1.0");

program.addCommand(initCommand());
program.addCommand(indexCommand());
program.addCommand(askCommand());
program.addCommand(serveCommand());
program.addCommand(mcpCommand());
program.addCommand(statusCommand());

program
  .parseAsync(process.argv)
  .catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`mneme: ${msg}\n`);
    process.exit(1);
  });
