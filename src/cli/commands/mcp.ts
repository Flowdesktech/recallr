import { Command } from "commander";
import { runMcpServer } from "../../mcp/server.js";

export function mcpCommand(): Command {
  return new Command("mcp")
    .description(
      "Run an MCP server over stdio so AI assistants (Cursor, Claude Desktop,\n" +
        "Goose, etc.) can search and read your messages on your behalf.",
    )
    .option("--no-embed", "Disable embedder for retrieval (lexical only)")
    .action(async (opts: { embed: boolean }) => {
      await runMcpServer({ useEmbedder: opts.embed });
    });
}
