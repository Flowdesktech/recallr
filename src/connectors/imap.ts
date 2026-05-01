import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import type { Connector, Message } from "../types.js";
import { mailToMessage } from "./mbox.js";

export interface ImapConfig {
  host: string;
  port?: number;
  secure?: boolean;
  user: string;
  pass: string;
  /** Mailboxes to fetch from. Default: ["INBOX", "Sent"]. */
  mailboxes?: string[];
  /** Optional human-readable label, e.g. "fastmail". */
  name?: string;
}

/**
 * Generic IMAP connector. Works with Fastmail, iCloud, Proton Bridge,
 * Yahoo, custom servers, and Gmail (via app password + IMAP enabled).
 *
 * For Gmail's full-fidelity export-style ingestion, the dedicated `gmail`
 * connector (planned for v0.2) uses the Gmail API to get labels, threads,
 * and history-based incremental sync. IMAP works today, has fewer features,
 * and zero OAuth setup.
 */
export class ImapConnector implements Connector {
  readonly source = "imap" as const;
  readonly name: string;
  private readonly config: Required<Omit<ImapConfig, "name">> & { name?: string };

  constructor(config: ImapConfig) {
    this.name = config.name ?? `imap:${config.user}@${config.host}`;
    this.config = {
      host: config.host,
      port: config.port ?? 993,
      secure: config.secure ?? true,
      user: config.user,
      pass: config.pass,
      mailboxes: config.mailboxes ?? ["INBOX", "Sent"],
      name: config.name,
    };
  }

  async *fetch(opts?: { since?: number; signal?: AbortSignal }): AsyncIterable<Message> {
    const client = new ImapFlow({
      host: this.config.host,
      port: this.config.port,
      secure: this.config.secure,
      auth: { user: this.config.user, pass: this.config.pass },
      logger: false,
    });

    await client.connect();
    try {
      for (const box of this.config.mailboxes) {
        if (opts?.signal?.aborted) return;
        let lock: Awaited<ReturnType<typeof client.getMailboxLock>> | null = null;
        try {
          lock = await client.getMailboxLock(box);
        } catch {
          // Mailbox doesn't exist on this server — skip silently.
          continue;
        }
        try {
          const sinceDate = opts?.since ? new Date(opts.since) : undefined;
          // SEARCH first to bound the FETCH set; full FETCH against a 50k+
          // mailbox is very slow.
          const uids = sinceDate
            ? await client.search({ since: sinceDate }, { uid: true })
            : await client.search({ all: true }, { uid: true });
          if (!uids || uids.length === 0) continue;

          for await (const msg of client.fetch(
            uids,
            { source: true, envelope: true, uid: true, internalDate: true },
            { uid: true },
          )) {
            if (opts?.signal?.aborted) return;
            if (!msg.source) continue;
            try {
              const parsed = await simpleParser(msg.source, { skipImageLinks: true });
              const normalized = mailToMessage(parsed, `imap://${this.config.host}/${box}`);
              // Override identity with IMAP-specific stable ids so re-syncs are idempotent.
              const sourceId = `${this.config.user}@${this.config.host}/${box}/${msg.uid}`;
              yield {
                ...normalized,
                id: `imap:${sourceId}`,
                source: "imap",
                sourceId,
                channel: box,
                provenance: {
                  ...(normalized.provenance ?? {}),
                  account: this.config.user,
                  host: this.config.host,
                  mailbox: box,
                  uid: String(msg.uid),
                },
              };
            } catch {
              // Skip messages we fail to parse rather than aborting the whole sync.
            }
          }
        } finally {
          lock?.release();
        }
      }
    } finally {
      await client.logout().catch(() => {
        // Already disconnected — fine.
      });
    }
  }
}
