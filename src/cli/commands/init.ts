import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig } from "../../config.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Create the local mneme home directory and a starter config.")
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
        $schema: "https://github.com/flowdesktech/mneme/raw/main/schema/config.schema.json",
        embedModel: cfg.embedModel,
        embedDimension: cfg.embedDimension,
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
        `${pc.green("✓")} Initialized mneme home at ${pc.cyan(cfg.home)}\n` +
          `  • Database will live at ${pc.cyan(cfg.dbPath)}\n` +
          `  • Edit ${pc.cyan(configPath)} to add real sources\n` +
          `  • Run ${pc.cyan("mneme index")} to start indexing\n`,
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
