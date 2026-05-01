import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolved configuration for an recallr run.
 *
 * Sources, in priority order:
 *   1. Explicit overrides passed in code.
 *   2. `RECALLR_*` environment variables.
 *   3. `~/.recallr/config.json` (or `$RECALLR_HOME/config.json`).
 *   4. Built-in defaults.
 */
export interface RecallrConfig {
  /** Directory holding the database, model cache, and connector configs. */
  home: string;
  /** Absolute path to the SQLite database. */
  dbPath: string;
  /** Default embedder model id (HF hub identifier). */
  embedModel: string;
  /** Vector dimension for the embedder model. */
  embedDimension: number;
  /** Sources configured in `~/.recallr/config.json`, if any. */
  sources: SourceConfig[];
}

export type SourceConfig =
  | { type: "mbox"; name?: string; path: string }
  | { type: "slack"; name?: string; path: string }
  | {
      type: "imap";
      name?: string;
      host: string;
      port?: number;
      secure?: boolean;
      user: string;
      pass: string;
      mailboxes?: string[];
    };

export async function loadConfig(overrides?: Partial<RecallrConfig>): Promise<RecallrConfig> {
  const home = overrides?.home ?? process.env.RECALLR_HOME ?? join(homedir(), ".recallr");

  let onDisk: Partial<RecallrConfig> = {};
  try {
    const raw = await readFile(join(home, "config.json"), "utf8");
    onDisk = JSON.parse(raw) as Partial<RecallrConfig>;
  } catch {
    // No file -> defaults are fine.
  }

  const dbPath = resolve(
    overrides?.dbPath ??
      process.env.RECALLR_DB ??
      onDisk.dbPath ??
      join(home, "recallr.db"),
  );

  return {
    home,
    dbPath,
    embedModel:
      overrides?.embedModel ??
      process.env.RECALLR_EMBED_MODEL ??
      onDisk.embedModel ??
      "Xenova/bge-small-en-v1.5",
    embedDimension:
      overrides?.embedDimension ??
      (process.env.RECALLR_EMBED_DIM ? Number(process.env.RECALLR_EMBED_DIM) : undefined) ??
      onDisk.embedDimension ??
      384,
    sources: overrides?.sources ?? onDisk.sources ?? [],
  };
}
