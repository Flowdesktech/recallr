import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import pc from "picocolors";
import { loadConfig, type SourceConfig } from "../../config.js";
import { ImapConnector } from "../../connectors/imap.js";
import { MboxConnector } from "../../connectors/mbox.js";
import { SlackExportConnector } from "../../connectors/slack.js";
import { LocalEmbedder } from "../../embed/local.js";
import { indexConnector } from "../../indexer.js";
import { SqliteStore } from "../../store/sqlite.js";
import type { Connector } from "../../types.js";

export function indexCommand(): Command {
  return new Command("index")
    .description(
      "Sync messages from one or more sources into the local database.\n\n" +
        "With no arguments, indexes every source in your config.json.\n" +
        "Pass a path to ingest a single ad-hoc source:\n" +
        "  - .mbox file              (any email export)\n" +
        "  - directory with users.json + channels.json   (Slack export)",
    )
    .argument("[source]", "Path to an .mbox file or extracted Slack export directory")
    .option("--no-embed", "Skip embedding (lexical-only, ~10x faster)")
    .option("--since <iso>", "Only index messages since this ISO date")
    .option("--name <name>", "Only index the source matching this name", undefined)
    .action(
      async (
        source: string | undefined,
        opts: { embed: boolean; since?: string; name?: string },
      ) => {
        const cfg = await loadConfig();
        const store = await SqliteStore.open(cfg.dbPath);

        const embedder = opts.embed
          ? await withSpinner("Loading embedding model", () =>
              LocalEmbedder.load({ model: cfg.embedModel, dimension: cfg.embedDimension }),
            )
          : undefined;

        let connectors: Connector[];
        if (source) {
          connectors = [connectorFromPath(source)];
        } else {
          if (cfg.sources.length === 0) {
            process.stderr.write(
              `${pc.red("✗")} No sources configured. Run ${pc.cyan("recallr init")} or pass an mbox path.\n`,
            );
            process.exit(2);
          }
          const filtered = opts.name
            ? cfg.sources.filter((s) => s.name === opts.name)
            : cfg.sources;
          connectors = filtered.map(buildConnector);
        }

        const since = opts.since ? new Date(opts.since).getTime() : undefined;

        try {
          for (const c of connectors) {
            process.stdout.write(`${pc.bold(pc.cyan(c.name))}\n`);
            const start = Date.now();
            const progress = await indexConnector({
              connector: c,
              store,
              embedder,
              options: {
                since,
                onProgress: (p) => {
                  const line =
                    `  fetched ${pc.bold(String(p.fetched))} · stored ${p.stored} · ` +
                    `embedded ${p.embedded}${p.skipped ? ` · skipped ${p.skipped}` : ""}`;
                  rewriteLine(line);
                },
              },
            });
            const elapsed = ((Date.now() - start) / 1000).toFixed(1);
            rewriteLine(
              `  ${pc.green("✓")} fetched ${progress.fetched} · stored ${progress.stored} · ` +
                `embedded ${progress.embedded}${progress.skipped ? ` · skipped ${progress.skipped}` : ""} ` +
                `(${elapsed}s)\n`,
            );
          }
          const stats = await store.stats();
          process.stdout.write(
            `\n${pc.green("✓")} Database now contains ${pc.bold(String(stats.messages))} messages ` +
              `(${stats.embeddings} embedded) at ${pc.cyan(cfg.dbPath)}\n`,
          );
        } finally {
          store.close();
        }
      },
    );
}

function buildConnector(s: SourceConfig): Connector {
  if (s.type === "mbox") return new MboxConnector(s.path, s.name);
  if (s.type === "slack") return new SlackExportConnector({ path: s.path, name: s.name });
  if (s.type === "imap")
    return new ImapConnector({
      host: s.host,
      port: s.port,
      secure: s.secure,
      user: s.user,
      pass: s.pass,
      mailboxes: s.mailboxes,
      name: s.name,
    });
  throw new Error(`Unknown source type: ${(s as { type: string }).type}`);
}

/**
 * Decide which connector to use for a positional `recallr index <path>` arg.
 *
 * Heuristics, in order:
 *   1. A directory containing `users.json` AND `channels.json` is a Slack export.
 *   2. A `.zip` file gets a friendly error pointing at the unzip step.
 *   3. Anything else is treated as an mbox file (the parser is forgiving).
 */
function connectorFromPath(path: string): Connector {
  let s: ReturnType<typeof statSync> | null = null;
  try {
    s = statSync(path);
  } catch {
    throw new Error(`recallr: ${path} does not exist`);
  }

  if (s.isDirectory()) {
    if (existsSync(join(path, "users.json")) && existsSync(join(path, "channels.json"))) {
      return new SlackExportConnector({ path });
    }
    throw new Error(
      `recallr: ${path} is a directory but doesn't look like a Slack export ` +
        "(no users.json + channels.json at the root). " +
        "If this is something else, point at the file directly.",
    );
  }

  if (path.toLowerCase().endsWith(".zip")) {
    throw new Error(
      `recallr: ${path} is a zip file. Slack exports must be unzipped first:\n` +
        `  PowerShell:  Expand-Archive ${path} ${path.replace(/\.zip$/i, "")}\n` +
        `  bash/zsh:    unzip ${path} -d ${path.replace(/\.zip$/i, "")}/\n` +
        "Then run: recallr index <extracted-dir>",
    );
  }

  return new MboxConnector(path);
}

function rewriteLine(line: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(`\r\x1b[K${line}`);
    if (line.endsWith("\n")) return;
  } else {
    process.stdout.write(`${line}\n`);
  }
}

async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    process.stdout.write(`${label}...\n`);
    return fn();
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const tick = setInterval(() => {
    process.stdout.write(`\r${pc.cyan(frames[i % frames.length] ?? "*")} ${label}...`);
    i++;
  }, 80);
  try {
    const v = await fn();
    process.stdout.write(`\r\x1b[K${pc.green("✓")} ${label}\n`);
    return v;
  } catch (err) {
    process.stdout.write(`\r\x1b[K${pc.red("✗")} ${label}\n`);
    throw err;
  } finally {
    clearInterval(tick);
  }
}
