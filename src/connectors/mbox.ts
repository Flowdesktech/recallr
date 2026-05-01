import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { simpleParser, type AddressObject, type ParsedMail } from "mailparser";
import type { Connector, Message, Participant } from "../types.js";

/**
 * Local mbox file connector.
 *
 * Mbox is the lowest-common-denominator email export — Apple Mail, Gmail
 * Takeout, Thunderbird, mutt, postfix, and basically everything else can
 * produce one. Supporting it gives users an instant on-ramp without
 * needing OAuth or app passwords.
 *
 * The format is "From "-line delimited messages. We parse incrementally
 * so 5GB takeouts don't blow up RAM.
 */
export class MboxConnector implements Connector {
  readonly name: string;
  readonly source = "mbox" as const;
  private readonly path: string;

  constructor(path: string, name?: string) {
    this.path = path;
    this.name = name ?? `mbox:${path}`;
  }

  async *fetch(opts?: { since?: number; signal?: AbortSignal }): AsyncIterable<Message> {
    const stats = await stat(this.path);
    if (!stats.isFile()) {
      throw new Error(`mneme: ${this.path} is not a file`);
    }

    const stream = createReadStream(this.path, { encoding: "utf8" });
    let buffer = "";
    let messageBuffer: string[] = [];
    const FROM_LINE = /^From .+\d{4}\s*$/;

    const flush = async (): Promise<Message | null> => {
      if (messageBuffer.length === 0) return null;
      // Drop the leading "From " envelope line; mailparser expects raw RFC822.
      const raw = messageBuffer.slice(1).join("\n");
      messageBuffer = [];
      try {
        const parsed = await simpleParser(raw, { skipImageLinks: true });
        const msg = mailToMessage(parsed, this.path);
        if (opts?.since && msg.timestamp < opts.since) return null;
        return msg;
      } catch {
        // Skip malformed entries silently. mbox in the wild is messy.
        return null;
      }
    };

    for await (const chunk of stream) {
      if (opts?.signal?.aborted) return;
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (FROM_LINE.test(line) && messageBuffer.length > 0) {
          const msg = await flush();
          if (msg) yield msg;
        }
        messageBuffer.push(line);
        nl = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) messageBuffer.push(buffer);
    const last = await flush();
    if (last) yield last;
  }
}

/* ----------------------------- shared parsing ---------------------------- */

/**
 * Convert a `mailparser` ParsedMail to our normalized Message.
 *
 * Exported because `imap.ts` reuses this — both connectors parse the
 * same RFC822 wire format, only the transport differs.
 */
export function mailToMessage(parsed: ParsedMail, provenancePath: string): Message {
  const from = addressToParticipant(parsed.from) ?? {
    id: "unknown",
    name: "Unknown sender",
  };
  const to = addressesToParticipants(parsed.to);
  const cc = parsed.cc ? addressesToParticipants(parsed.cc) : undefined;
  const bcc = parsed.bcc ? addressesToParticipants(parsed.bcc) : undefined;

  const messageId = parsed.messageId?.replace(/^<|>$/g, "");
  const inReplyTo =
    typeof parsed.inReplyTo === "string"
      ? parsed.inReplyTo.replace(/^<|>$/g, "")
      : undefined;
  const references = Array.isArray(parsed.references)
    ? parsed.references
    : typeof parsed.references === "string"
      ? [parsed.references]
      : [];
  // Thread id heuristic: use the first/root message id from References,
  // falling back to In-Reply-To, falling back to our own message id (so
  // single-message threads still group correctly).
  const threadId =
    references[0]?.replace(/^<|>$/g, "") ??
    inReplyTo ??
    messageId ??
    crypto.randomUUID();

  const sourceId = messageId ?? `${parsed.subject ?? ""}|${parsed.date?.toISOString() ?? ""}|${from.id}`;

  return {
    id: `mbox:${sourceId}`,
    source: "mbox",
    sourceId,
    threadId,
    subject: parsed.subject,
    body: parsed.text ?? stripHtml(parsed.html || "") ?? "",
    from,
    to,
    cc,
    bcc,
    timestamp: parsed.date ? parsed.date.getTime() : Date.now(),
    attachments: parsed.attachments?.map((a) => ({
      filename: a.filename,
      contentType: a.contentType,
      size: a.size,
    })),
    provenance: { path: provenancePath },
  };
}

function addressToParticipant(
  addr: AddressObject | AddressObject[] | undefined,
): Participant | null {
  if (!addr) return null;
  const single = Array.isArray(addr) ? addr[0] : addr;
  if (!single?.value?.[0]) return null;
  const v = single.value[0];
  const email = v.address?.toLowerCase();
  return {
    id: email ?? v.name ?? "unknown",
    name: v.name && v.name.trim() ? v.name : undefined,
    email: email,
  };
}

function addressesToParticipants(
  addr: AddressObject | AddressObject[] | undefined,
): Participant[] {
  if (!addr) return [];
  const arr = Array.isArray(addr) ? addr : [addr];
  const out: Participant[] = [];
  for (const a of arr) {
    for (const v of a.value ?? []) {
      const email = v.address?.toLowerCase();
      if (!email && !v.name) continue;
      out.push({
        id: email ?? v.name ?? "unknown",
        name: v.name && v.name.trim() ? v.name : undefined,
        email,
      });
    }
  }
  return out;
}

function stripHtml(html: string | false | undefined): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
