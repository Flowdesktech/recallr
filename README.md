# mneme

**Local-first memory for every message you've ever sent.**

Index your email and Slack — once. Recall it from your CLI, a local web UI, or any AI assistant via [MCP](https://modelcontextprotocol.io). 100% on-device. BYO model. Discord, WhatsApp, and iMessage on the way.

[![npm](https://img.shields.io/npm/v/mneme.svg)](https://www.npmjs.com/package/mneme)
[![license](https://img.shields.io/github/license/flowdesktech/mneme)](LICENSE)
[![CI](https://github.com/flowdesktech/mneme/actions/workflows/ci.yml/badge.svg)](https://github.com/flowdesktech/mneme/actions)
[![stars](https://img.shields.io/github/stars/flowdesktech/mneme?style=social)](https://github.com/flowdesktech/mneme)

`mneme` (μνήμη — Greek for *memory*) is a tiny TypeScript engine that turns
your communications into a queryable knowledge graph. Maintained by
[Flowdesk](https://flowdesk.tech).

---

> **What if your AI could remember every conversation you've ever had?**

Today, when you ask Cursor or Claude *"what did Ana decide about pricing in March?"*, they have nothing to go on. Your inbox lives in twelve different silos, none of which speak to your AI. Mneme fixes that — locally, with one command.

```bash
npx mneme index ~/Downloads/gmail-takeout.mbox
npx mneme index ~/Downloads/slack-export/
npx mneme ask "what did Ana decide about pricing?"
```

```
After the customer interviews, Ana locked Q3 pricing on March 7 [#1].
She'd flagged it in the team Slack two days earlier [#4] and worked
through the open questions with Marc in email [#2][#3]:

- Pro tier at $19/month with a 20% annual prepay discount
- Education/Nonprofit Pro at $9.50/month, domain-verified
- Team tier discontinued; existing subs grandfathered through Dec 31

Sources:
  [#1] 2026-03-07 · Ana Diaz   · email   · Re: Q3 pricing decision — LOCKED
  [#2] 2026-03-04 · Ana Diaz   · email   · Re: Q3 pricing decision
  [#3] 2026-03-03 · Marc Liu   · email   · Re: Q3 pricing decision
  [#4] 2026-03-03 · Ana        · slack   · #general
```

---

## Why mneme

- **Local-first.** Your messages never leave your machine. Embeddings run on-device via [transformers.js](https://huggingface.co/docs/transformers.js). The LLM is whatever you point it at — Ollama, LM Studio, OpenAI, OpenRouter.
- **One file, zero daemons.** SQLite + FTS5 + dense vectors stored as `BLOB` columns. Backup is `cp mneme.db elsewhere`.
- **Hybrid search.** BM25 for precision, embeddings for recall, fused with min-max normalization. Works well *immediately* — no tuning required.
- **MCP-native.** A single `mneme mcp` command exposes your memory to any MCP client (Cursor, Claude Desktop, Goose, Zed). No plugins, no configuration ceremony.
- **Hackable.** ~3k lines of strict TypeScript across a handful of focused files. Add a new connector in an afternoon.

---

## Quickstart

### 1. Install

```bash
npm i -g mneme        # global CLI
# or
npx mneme --help      # zero-install
```

Requires Node 20.10+. The default model (~33MB) downloads on first index.

### 2. Index something

```bash
# A local mbox export from Gmail, Apple Mail, Thunderbird, mutt, etc.
mneme index ~/mail.mbox

# A Slack workspace export (extract the .zip first)
unzip slack-export.zip -d slack-export/
mneme index ./slack-export/
```

Or run `mneme init`, edit `~/.mneme/config.json`, and add real sources:

```json
{
  "sources": [
    { "type": "mbox", "name": "takeout", "path": "~/Downloads/All mail Including Spam and Trash.mbox" },
    { "type": "slack", "name": "work", "path": "~/Downloads/slack-export/" },
    {
      "type": "imap",
      "name": "fastmail",
      "host": "imap.fastmail.com",
      "user": "you@example.com",
      "pass": "app-password-here",
      "mailboxes": ["INBOX", "Sent", "Archive"]
    }
  ]
}
```

Then:

```bash
mneme index            # syncs every configured source
mneme status           # see what's in the database
```

### 3. Ask

```bash
mneme ask "what did the team decide about pricing?"
mneme ask "summarize what Ana said this quarter" --source mbox
mneme ask "find the figma link for the onboarding redesign" --show-context
```

`mneme ask` uses your configured LLM:


| If you have...                           | mneme uses                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `ollama serve` running (default)         | `llama3.2` via `http://localhost:11434/v1`                                |
| `OPENAI_API_KEY` set                     | OpenAI (`gpt-4o-mini` by default)                                         |
| `MNEME_LLM_BASE_URL` + `MNEME_LLM_MODEL` | Any OpenAI-compatible endpoint (LM Studio, OpenRouter, Together, Groq, …) |


### 4. Open the web UI

```bash
mneme serve
# → http://127.0.0.1:7474  (auto-opens in your browser)
```

A clean local chat UI: ask anything, see citations as cards, click any
citation to expand the full thread inline. Bound to `127.0.0.1` only —
your messages never touch a network.

```bash
mneme serve --port 9000        # different port
mneme serve --host 0.0.0.0     # expose on LAN (use carefully)
mneme serve --no-open          # don't auto-open the browser
mneme serve --no-embed         # lexical-only (skip loading the embedder)
```

### 5. Plug into your AI assistant via MCP

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mneme": {
      "command": "npx",
      "args": ["-y", "mneme", "mcp"]
    }
  }
}
```

**Cursor** — Settings → MCP → add server:

```json
{
  "name": "mneme",
  "command": "npx",
  "args": ["-y", "mneme", "mcp"]
}
```

Now ask Cursor/Claude things like *"summarize every conversation I had with Ana about pricing this year"* and it will call `search_messages` against your local index, with citations.

The MCP server exposes four tools:


| Tool              | Purpose                                                         |
| ----------------- | --------------------------------------------------------------- |
| `search_messages` | Hybrid BM25 + embedding search, with source/date/people filters |
| `get_message`     | Fetch a single message by id                                    |
| `get_thread`      | Fetch the full conversation containing a message                |
| `status`          | Report database stats by source                                 |

---

## Configuration

Mneme reads (in priority order) explicit overrides → environment variables →
`~/.mneme/config.json` → built-in defaults.

| Variable               | Default                          | Purpose                                                |
| ---------------------- | -------------------------------- | ------------------------------------------------------ |
| `MNEME_HOME`           | `~/.mneme`                       | Where the database, model cache, and config live       |
| `MNEME_DB`             | `$MNEME_HOME/mneme.db`           | Path to the SQLite database file                       |
| `MNEME_EMBED_MODEL`    | `Xenova/bge-small-en-v1.5`       | Hugging Face id of the embedding model                 |
| `MNEME_EMBED_DIM`      | `384`                            | Vector dimension produced by the embedder              |
| `MNEME_LLM_BASE_URL`   | (auto)                           | OpenAI-compatible base URL                             |
| `MNEME_LLM_MODEL`      | (auto)                           | Model id passed to the LLM                             |
| `MNEME_LLM_API_KEY`    | `$OPENAI_API_KEY` if set         | Bearer token for the LLM endpoint                      |

The same fields are settable in `~/.mneme/config.json`:

```json
{
  "embedModel": "Xenova/bge-small-en-v1.5",
  "embedDimension": 384,
  "sources": [ /* ... see Quickstart ... */ ]
}
```

---

## How it works

```
┌─────────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│   Connectors        │    │   Indexer        │    │   Store          │
│ ─────────────────── │    │ ──────────────── │    │ ──────────────── │
│  IMAP    mbox       │ ─▶ │  fetch → embed   │ ─▶ │  SQLite + FTS5   │
│  Slack              │    │  → upsert        │    │  + dense vectors │
│  Gmail / Discord    │    │  (idempotent)    │    │  (Float32 BLOBs) │
│  (v0.2)             │    │                  │    │                  │
└─────────────────────┘    └──────────────────┘    └──────────────────┘
                                                            │
                                ┌───────────────────────────┼────────────────┐
                                ▼                           ▼                ▼
                        ┌──────────────┐           ┌────────────────┐  ┌───────────┐
                        │ mneme ask    │           │ mneme mcp      │  │ mneme     │
                        │ (RAG, CLI)   │           │ (Cursor/Claude)│  │ serve (UI)│
                        └──────────────┘           └────────────────┘  └───────────┘
```

### Supported sources

| Source                                | Live or one-shot? | Status      |
| ------------------------------------- | ----------------- | ----------- |
| IMAP (Fastmail, iCloud, Proton, …)    | **Live**          | shipped     |
| mbox (Gmail Takeout, Apple Mail, …)   | One-shot file     | shipped     |
| Slack workspace `export.zip`          | One-shot folder   | shipped     |
| Gmail API                             | Live              | v0.2        |
| Slack live API                        | Live              | v0.2        |
| Discord export, WhatsApp, iMessage    | One-shot folder   | v0.2        |

Each connector normalizes its source into a single `Message` shape. The indexer is idempotent: re-running `mneme index` only fetches what's new and only embeds what hasn't been embedded. Search is hybrid — FTS5 BM25 pulls candidates, embedding cosine reranks them, results are fused by min-max-normalized score.

For corpora under ~250k messages everything fits comfortably on a laptop. Past that, swap in `sqlite-vec` (planned for v0.3).

---

## Use as a library

Everything the CLI does is also a public TypeScript API. Embed mneme inside
your own Node service to give each of your users a queryable knowledge graph
over their own messages.

```ts
import {
  SqliteStore,
  LocalEmbedder,
  MboxConnector,
  SlackExportConnector,
  indexConnector,
  ask,
  llmFromEnv,
} from "mneme";

const store = await SqliteStore.open("./alice.mneme.db");
const embedder = await LocalEmbedder.load();

await indexConnector({
  connector: new MboxConnector("./alice.mbox"),
  store,
  embedder,
});
await indexConnector({
  connector: new SlackExportConnector({ path: "./alice-slack-export/" }),
  store,
  embedder,
});

const result = await ask({
  question: "what did Ana decide about pricing?",
  store,
  llm: llmFromEnv(),
  embedder,
});

console.log(result.answer);
console.log(result.citations.map((c) => c.message.subject));
```

The full type surface is exported from `mneme` and `mneme/mcp`.

---

## Roadmap

`mneme` is brand new. The shape of v0.1 is intentionally tight; the roadmap is community-driven.

**v0.2 — more sources**

- Gmail API connector (live + Takeout)
- Slack live API connector (export.zip works today)
- Discord export connector
- WhatsApp chat exports
- iMessage (macOS `chat.db` reader)
- Slack zip-file ingestion (today: extract first, then point at the directory)

**v0.3 — performance & scale**

- `sqlite-vec` backend for >100k message corpora
- Int8 / binary vector quantization (4–32× smaller index)
- Incremental re-embed on model upgrades
- `mneme watch` daemon: continuously sync configured live sources

**v0.4 — UI v2**

- Streaming answers with live citation expansion
- Faceted search: filter by source, date range, participant
- Thread browser sidebar
- Light-mode polish (dark mode is default today)

**v1.0 — polish**

- Encrypted-at-rest mode (libsodium-wrapped db)
- Per-source redaction rules
- Connector plugin system (`mneme-connector-*` packages)

---

## Contributing

Adding a connector is the highest-leverage way to help. Implement the
[`Connector` interface](src/types.ts) and emit normalized `Message` objects
from `fetch()`. See [`src/connectors/mbox.ts`](src/connectors/mbox.ts) and
[`src/connectors/slack.ts`](src/connectors/slack.ts) as references.

```bash
git clone https://github.com/flowdesktech/mneme && cd mneme
npm install
npm run test
npm run build
node dist/cli/bin.js index examples/sample.mbox
node dist/cli/bin.js ask "what did the team decide about pricing?"
```

---

## License

[MIT](LICENSE) © Flowdesk

Mneme is part of [Flowdesk's open source initiative](https://github.com/flowdesktech).