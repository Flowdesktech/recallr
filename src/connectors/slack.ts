import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Connector, Message, Participant } from "../types.js";

/**
 * Slack workspace export connector.
 *
 * Slack admins can request a `.zip` export from the workspace settings.
 * Standard exports contain:
 *
 *     users.json
 *     channels.json   (public channels)
 *     groups.json     (private channels — Plus/Enterprise plans)
 *     mpims.json      (multi-party DMs)
 *     dms.json        (1:1 DMs — corporate exports only)
 *     <channel-name>/<YYYY-MM-DD>.json   (one file per day, array of messages)
 *
 * We deliberately only accept extracted *directories*, not zip files.
 * Slack exports are routinely 5+ GB; loading that through a JS unzip
 * library is fragile and bloats the dep tree. The error message tells
 * users to extract first.
 *
 * What we do:
 *   - Build a `userId -> SlackUser` map for mention rendering.
 *   - Walk every channel folder we recognize from the metadata files.
 *   - For each daily file, normalize messages to recallr `Message`s.
 *   - Skip system/noise subtypes (channel_join, message_changed, etc.).
 *   - Render Slack markup: `<@U123>` -> `@Display Name`,
 *     `<#C123|general>` -> `#general`, `<https://x|label>` -> `label (https://x)`.
 *   - Use `thread_ts` to group thread replies under a stable threadId.
 *
 * What we don't do (yet):
 *   - Reactions, edits, pinned items, message search across attachments.
 *   - Corporate "discovery" exports with a different nested structure —
 *     those are rare and need their own pass.
 */
export class SlackExportConnector implements Connector {
  readonly source = "slack" as const;
  readonly name: string;
  private readonly path: string;

  constructor(opts: { path: string; name?: string }) {
    this.path = opts.path;
    this.name = opts.name ?? `slack:${basename(opts.path)}`;
  }

  async *fetch(opts?: { since?: number; signal?: AbortSignal }): AsyncIterable<Message> {
    const st = await stat(this.path).catch(() => null);
    if (!st || !st.isDirectory()) {
      throw new Error(
        `recallr: ${this.path} is not a directory.\n` +
          `Slack exports must be unzipped first. On macOS/Linux:\n` +
          `  unzip slack-export.zip -d slack-export/\n` +
          `On Windows:\n` +
          `  Expand-Archive slack-export.zip slack-export/`,
      );
    }
    if (!existsSync(join(this.path, "users.json"))) {
      throw new Error(
        `recallr: ${this.path} does not look like a Slack export ` +
          `(no users.json at the root).`,
      );
    }

    const users = await loadUsers(this.path);
    const channels = await loadChannels(this.path);
    const channelById = new Map(channels.map((c) => [c.id, c] as const));

    for (const channel of channels) {
      if (opts?.signal?.aborted) return;
      // Channel folders are named after `channel.name`. DMs in dms.json
      // typically don't have a folder named after them; skip silently.
      const channelDir = join(this.path, channel.name);
      if (!existsSync(channelDir)) continue;

      let files: string[];
      try {
        files = (await readdir(channelDir))
          .filter((f) => f.endsWith(".json"))
          .sort();
      } catch {
        continue;
      }

      for (const file of files) {
        if (opts?.signal?.aborted) return;
        let raw: unknown;
        try {
          raw = JSON.parse(await readFile(join(channelDir, file), "utf8"));
        } catch {
          continue;
        }
        if (!Array.isArray(raw)) continue;

        for (const item of raw as RawSlackMessage[]) {
          const msg = normalize(item, channel, users, channelById);
          if (!msg) continue;
          if (opts?.since && msg.timestamp < opts.since) continue;
          yield msg;
        }
      }
    }
  }
}

/* ----------------------------- raw slack types ---------------------------- */

interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  is_bot?: boolean;
  deleted?: boolean;
  profile?: {
    real_name?: string;
    display_name?: string;
    email?: string;
  };
}

interface SlackChannel {
  id: string;
  name: string;
  is_archived?: boolean;
  is_general?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  members?: string[];
  topic?: { value?: string };
  purpose?: { value?: string };
}

interface RawSlackMessage {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  team?: string;
  client_msg_id?: string;
  files?: { id?: string; name?: string; title?: string; mimetype?: string; size?: number }[];
}

/* --------------------------------- loaders -------------------------------- */

async function loadUsers(root: string): Promise<Map<string, SlackUser>> {
  const data = await readJsonArray<SlackUser>(join(root, "users.json"));
  const map = new Map<string, SlackUser>();
  for (const u of data) {
    if (u && typeof u.id === "string") map.set(u.id, u);
  }
  return map;
}

async function loadChannels(root: string): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  for (const file of ["channels.json", "groups.json", "mpims.json", "dms.json"]) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const data = await readJsonArray<SlackChannel>(path);
    for (const c of data) {
      if (c && typeof c.id === "string" && typeof c.name === "string") out.push(c);
    }
  }
  return out;
}

async function readJsonArray<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/* -------------------------------- normalize ------------------------------- */

/**
 * Subtypes we drop entirely. These are pure system noise that pollutes
 * retrieval — joins/leaves/topic-changes/edits/etc. The original message
 * for a `message_changed` event is already in the export under its own
 * timestamp, so we don't lose anything by dropping it.
 */
const DROP_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "pinned_item",
  "unpinned_item",
  "tombstone",
  "message_deleted",
  "message_changed",
  "reminder_add",
]);

function normalize(
  m: RawSlackMessage,
  channel: SlackChannel,
  users: Map<string, SlackUser>,
  channelById: Map<string, SlackChannel>,
): Message | null {
  if (m.type !== "message" && m.type !== undefined) return null;
  if (m.subtype && DROP_SUBTYPES.has(m.subtype)) return null;
  if (typeof m.ts !== "string") return null;

  const text = renderText(m.text ?? "", users, channelById);
  const fileNotes = (m.files ?? [])
    .filter((f) => f && (f.title || f.name))
    .map((f) => `[file: ${f.title ?? f.name}]`);
  const body = [text, ...fileNotes].filter(Boolean).join("\n").trim();
  if (!body) return null;

  const from = participantFrom(m, users);
  if (!from) return null;

  const timestamp = slackTsToMs(m.ts);
  const team = m.team ?? "_";
  const channelKind = channel.is_im
    ? "(DM)"
    : channel.is_mpim
      ? `(MPIM ${channel.name})`
      : channel.is_private
        ? `🔒${channel.name}`
        : channel.name;

  return {
    id: `slack:${team}:${channel.id}:${m.ts}`,
    source: "slack",
    sourceId: m.ts,
    channel: channelKind,
    threadId: `slack:${team}:${channel.id}:${m.thread_ts ?? m.ts}`,
    body,
    from,
    to: [],
    timestamp,
    provenance: {
      workspace: team,
      channel_id: channel.id,
      channel_name: channel.name,
      ...(m.client_msg_id ? { client_msg_id: m.client_msg_id } : {}),
    },
  };
}

function participantFrom(
  m: RawSlackMessage,
  users: Map<string, SlackUser>,
): Participant | null {
  if (m.user) {
    const u = users.get(m.user);
    const name =
      u?.profile?.display_name?.trim() ||
      u?.profile?.real_name?.trim() ||
      u?.real_name?.trim() ||
      u?.name?.trim();
    return {
      id: m.user,
      name: name || undefined,
      email: u?.profile?.email,
    };
  }
  if (m.bot_id) {
    return {
      id: m.bot_id,
      name: m.username || "Bot",
    };
  }
  return null;
}

/**
 * Slack timestamps are seconds-since-epoch with microsecond fractional
 * digits (e.g. "1740999900.000100"). We coerce to integer milliseconds.
 */
function slackTsToMs(ts: string): number {
  const sec = Number.parseFloat(ts);
  if (!Number.isFinite(sec)) return Date.now();
  return Math.floor(sec * 1000);
}

/**
 * Convert Slack message markup to readable plain text.
 *
 * Order matters: link replacements run before mention replacements
 * because user mentions of the form `<@U123|alice>` and link forms of
 * the form `<https://...|label>` share the same `<...|...>` shape but
 * are disambiguated by their first character.
 *
 * The replacements are intentionally lossy — we don't preserve "this
 * was a mention" structure — because retrieval is downstream and
 * `@Ana Diaz` is much friendlier to BM25 + embeddings than `<@U001>`.
 */
export function renderText(
  text: string,
  users: Map<string, SlackUser>,
  channelById: Map<string, SlackChannel>,
): string {
  return (
    text
      // <@U123> or <@U123|name>
      .replace(/<@([UWB][A-Z0-9]+)(?:\|[^>]+)?>/g, (_match, id: string) => {
        const u = users.get(id);
        const name =
          u?.profile?.display_name?.trim() ||
          u?.profile?.real_name?.trim() ||
          u?.real_name?.trim() ||
          u?.name?.trim() ||
          id;
        return `@${name}`;
      })
      // <#C123|name> or <#C123>
      .replace(/<#([CGD][A-Z0-9]+)(?:\|([^>]+))?>/g, (_match, id: string, label?: string) => {
        const resolved = label ?? channelById.get(id)?.name ?? id;
        return `#${resolved}`;
      })
      // <!channel>, <!here>, <!everyone>
      .replace(/<!(channel|here|everyone)>/g, "@$1")
      // <!subteam^S123|name>
      .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label?: string) => `@${label ?? "group"}`)
      // <https://x.com|label> or <mailto:a@b|label>
      .replace(/<((?:https?|mailto):[^|>\s]+)\|([^>]+)>/g, "$2 ($1)")
      // <https://x.com>
      .replace(/<((?:https?|mailto):[^|>\s]+)>/g, "$1")
      // HTML entities Slack escapes in `text` payloads
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
  );
}
