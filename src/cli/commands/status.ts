import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "../../config.js";
import { SqliteStore } from "../../store/sqlite.js";

export function statusCommand(): Command {
  return new Command("status")
    .description("Print stats about the local database.")
    .action(async () => {
      const cfg = await loadConfig();
      const store = await SqliteStore.open(cfg.dbPath);
      try {
        const stats = await store.stats();
        process.stdout.write(
          `${pc.bold("recallr")} ${pc.dim(`(${cfg.dbPath})`)}\n` +
            `  messages:   ${pc.bold(String(stats.messages))}\n` +
            `  embeddings: ${pc.bold(String(stats.embeddings))}\n` +
            `  embedder:   ${cfg.embedModel} (${cfg.embedDimension} dim)\n`,
        );
        if (Object.keys(stats.sources).length > 0) {
          process.stdout.write("  sources:\n");
          for (const [s, n] of Object.entries(stats.sources)) {
            process.stdout.write(`    ${s.padEnd(10)} ${n}\n`);
          }
        }
      } finally {
        store.close();
      }
    });
}
