# recallr

**Local-first memory for every message you've ever sent.**

Index your email and Slack — once. Recall it from your CLI, a local web UI, or any AI assistant via [MCP](https://modelcontextprotocol.io). 100% on-device storage. BYO model: works with Ollama, OpenAI, Claude, Gemini, LM Studio, OpenRouter, Groq, Together, or anything OpenAI-compatible. Discord, WhatsApp, and iMessage on the way.

[![npm](https://img.shields.io/npm/v/recallr.svg)](https://www.npmjs.com/package/recallr)
[![license](https://img.shields.io/github/license/flowdesktech/recallr)](LICENSE)
[![CI](https://github.com/flowdesktech/recallr/actions/workflows/ci.yml/badge.svg)](https://github.com/flowdesktech/recallr/actions)
[![stars](https://img.shields.io/github/stars/flowdesktech/recallr?style=social)](https://github.com/flowdesktech/recallr)

`recallr` is a tiny TypeScript engine that gives any AI assistant total
recall over every message you've ever sent — without uploading a single
byte. Maintained by [Flowdesk](https://flowdesk.tech).

---

> **What if your AI could remember every conversation you've ever had?**

Today, when you ask Cursor or Claude *"what did Ana decide about pricing in March?"*, they have nothing to go on. Your inbox lives in twelve different silos, none of which speak to your AI. Recallr fixes that — locally, with one command.

```bash
npx recallr index ~/Downloads/gmail-takeout.mbox
npx recallr index ~/Downloads/slack-export/
npx recallr ask "what did Ana decide about pricing?"
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

## Why recallr

- **Local-first.** Your messages never leave your machine. Embeddings run on-device via [transformers.js](https://huggingface.co/docs/transformers.js). The LLM is whatever you point it at — Ollama, LM Studio, OpenAI, OpenRouter.
- **One file, zero daemons.** SQLite + FTS5 + dense vectors stored as `BLOB` columns. Backup is `cp recallr.db elsewhere`.
- **Hybrid search.** BM25 for precision, embeddings for recall, fused with min-max normalization. Works well *immediately* — no tuning required.
- **MCP-native.** A single `recallr mcp` command exposes your memory to any MCP client (Cursor, Claude Desktop, Goose, Zed). No plugins, no configuration ceremony.
- **Hackable.** ~3k lines of strict TypeScript across a handful of focused files. Add a new connector in an afternoon.

---

## Quickstart

### 1. Install

```bash
npm i -g recallr        # global CLI
# or
npx recallr --help      # zero-install
```

Requires Node 20.10+. The default model (~33MB) downloads on first index.

### 2. Index something

```bash
# A local mbox export from Gmail, Apple Mail, Thunderbird, mutt, etc.
recallr index ~/mail.mbox

# A Slack workspace export (extract the .zip first)
unzip slack-export.zip -d slack-export/
recallr index ./slack-export/
```

Or run `recallr init`, edit `~/.recallr/config.json`, and add real sources:

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
recallr index            # syncs every configured source
recallr status           # see what's in the database
```

### 3. Connect an LLM

Recallr talks to **any OpenAI-compatible chat endpoint** — pick whichever
one you want. Resolution order, most-specific wins:

1. CLI flags (`--llm-base-url`, `--llm-model`, `--llm-api-key`) — one-off per call
2. Env vars (`RECALLR_LLM_BASE_URL`, `RECALLR_LLM_MODEL`, `RECALLR_LLM_API_KEY`) — per shell
3. `llm` block in `~/.recallr/config.json` — your persistent setup
4. **Cloud-provider shortcut env vars** — set one of these and you're done:
   - `OPENAI_API_KEY` → OpenAI (`gpt-5.5-mini`)
   - `ANTHROPIC_API_KEY` → Anthropic Claude (`claude-haiku-4-7-latest`)
   - `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) → Google Gemini (`gemini-3.0-flash`)
5. Default → Ollama at `http://localhost:11434/v1` (`llama3.2`)

The recommended place for "this is my setup" is the config file:

```json
{
  "llm": {
    "baseUrl": "https://openrouter.ai/api/v1",
    "model": "anthropic/claude-opus-4.7",
    "apiKey": "sk-or-..."
  },
  "sources": [ /* ... */ ]
}
```

Env vars are still useful for "different model on this run" without
editing the file; CLI flags for a single call.

#### Ollama (local, free, recommended)

```bash
# 1. Install Ollama: https://ollama.com
ollama serve              # leave running in another terminal
ollama pull llama3.2      # ~2GB, one-time

# 2. That's it — recallr finds it automatically.
recallr ask "what did Ana decide about pricing?"
```

Want a different local model? Either `ollama pull qwen2.5:7b` and:

```bash
export RECALLR_LLM_MODEL=qwen2.5:7b      # bash / zsh
$env:RECALLR_LLM_MODEL = "qwen2.5:7b"    # PowerShell
```

Or pass it per-call: `recallr ask --llm-model qwen2.5:7b "..."`.

#### OpenAI

```bash
export OPENAI_API_KEY=sk-...                # bash / zsh
$env:OPENAI_API_KEY = "sk-..."              # PowerShell
setx OPENAI_API_KEY "sk-..."                # PowerShell, persistent

recallr ask "..."                           # uses gpt-5.5-mini
recallr ask --llm-model gpt-5.5 "..."       # any OpenAI model
```

#### Anthropic Claude

Recallr uses Anthropic's [official OpenAI-compat layer](https://docs.anthropic.com/en/api/openai-sdk) — no extra config beyond an API key:

```bash
export ANTHROPIC_API_KEY=sk-ant-...         # bash / zsh
$env:ANTHROPIC_API_KEY = "sk-ant-..."       # PowerShell

recallr ask "..."                           # uses claude-haiku-4-7-latest
recallr ask --llm-model claude-sonnet-4-7-latest "..."
recallr ask --llm-model claude-opus-4-7-latest "..."
```

#### Google Gemini

Recallr uses Gemini's [OpenAI-compat layer](https://ai.google.dev/gemini-api/docs/openai). Get a free key at [aistudio.google.com](https://aistudio.google.com/app/apikey):

```bash
export GEMINI_API_KEY=AIza...               # bash / zsh
$env:GEMINI_API_KEY = "AIza..."             # PowerShell

recallr ask "..."                           # uses gemini-3.0-flash (fast + free tier)
recallr ask --llm-model gemini-3.1-pro "..."
```

`GOOGLE_API_KEY` is accepted as an alias for `GEMINI_API_KEY` for compatibility with Google's other SDKs.

#### LM Studio

Start LM Studio's local server, then:

```bash
recallr ask --llm-base-url http://localhost:1234/v1 \
            --llm-model my-local-model "..."
```

Or set it permanently:

```bash
export RECALLR_LLM_BASE_URL=http://localhost:1234/v1
export RECALLR_LLM_MODEL=my-local-model
```

#### OpenRouter / Groq / Together / DeepSeek / any OpenAI-compatible API

```bash
# Example: OpenRouter (gives you Claude, GPT-4, Llama, Gemini, ... behind one URL)
export RECALLR_LLM_BASE_URL=https://openrouter.ai/api/v1
export RECALLR_LLM_MODEL=anthropic/claude-opus-4.7
export RECALLR_LLM_API_KEY=sk-or-...

# Example: Groq (extremely fast)
export RECALLR_LLM_BASE_URL=https://api.groq.com/openai/v1
export RECALLR_LLM_MODEL=llama-3.3-70b-versatile
export RECALLR_LLM_API_KEY=gsk_...

# Example: Together
export RECALLR_LLM_BASE_URL=https://api.together.xyz/v1
export RECALLR_LLM_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
export RECALLR_LLM_API_KEY=...

recallr ask "..."
```

Run `recallr ask --help` to see all the per-call overrides.

### 4. Ask

```bash
recallr ask "what did the team decide about pricing?"
recallr ask "summarize what Ana said this quarter" --source mbox
recallr ask "find the figma link for the onboarding redesign" --show-context
recallr ask -k 16 "what's the latest from Marc?"      # pull more context
```

### 5. Open the web UI

```bash
recallr serve
# → http://127.0.0.1:7474  (auto-opens in your browser)
```

A clean local chat UI: ask anything, see citations as cards, click any
citation to expand the full thread inline. Bound to `127.0.0.1` only —
your messages never touch a network.

```bash
recallr serve --port 9000        # different port
recallr serve --host 0.0.0.0     # expose on LAN (use carefully)
recallr serve --no-open          # don't auto-open the browser
recallr serve --no-embed         # lexical-only (skip loading the embedder)
```

### 6. Plug into your AI assistant via MCP

**Claude Desktop** — add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "recallr": {
      "command": "npx",
      "args": ["-y", "recallr", "mcp"]
    }
  }
}
```

**Cursor** — Settings → MCP → add server:

```json
{
  "name": "recallr",
  "command": "npx",
  "args": ["-y", "recallr", "mcp"]
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

Recallr reads (in priority order) explicit overrides → environment variables →
`~/.recallr/config.json` → built-in defaults.

| Variable               | Default                          | Purpose                                                |
| ---------------------- | -------------------------------- | ------------------------------------------------------ |
| `RECALLR_HOME`           | `~/.recallr`                       | Where the database, model cache, and config live       |
| `RECALLR_DB`             | `$RECALLR_HOME/recallr.db`           | Path to the SQLite database file                       |
| `RECALLR_EMBED_MODEL`    | `Xenova/bge-small-en-v1.5`       | Hugging Face id of the embedding model                 |
| `RECALLR_EMBED_DIM`      | `384`                            | Vector dimension produced by the embedder              |
| `RECALLR_LLM_BASE_URL`   | (auto)                           | OpenAI-compatible base URL                             |
| `RECALLR_LLM_MODEL`      | (auto)                           | Model id passed to the LLM                             |
| `RECALLR_LLM_API_KEY`    | (none)                           | Bearer token for the LLM endpoint                      |
| `OPENAI_API_KEY`         | (none)                           | Shortcut: enables OpenAI       (`gpt-5.5-mini`)        |
| `ANTHROPIC_API_KEY`      | (none)                           | Shortcut: enables Anthropic    (`claude-haiku-4-7-latest`) |
| `GEMINI_API_KEY`         | (none)                           | Shortcut: enables Google Gemini (`gemini-3.0-flash`)   |
| `GOOGLE_API_KEY`         | (none)                           | Alias for `GEMINI_API_KEY`                             |

The same fields are settable in `~/.recallr/config.json`:

```json
{
  "embedModel": "Xenova/bge-small-en-v1.5",
  "embedDimension": 384,
  "llm": {
    "baseUrl": "https://api.openai.com/v1",
    "model": "gpt-5.5-mini",
    "apiKey": "sk-..."
  },
  "sources": [ /* ... see Quickstart ... */ ]
}
```

> Heads up: API keys committed to a config file are still secrets. If you
> share `config.json` (e.g. in dotfiles) prefer leaving `apiKey` out and
> exporting `RECALLR_LLM_API_KEY` from your shell instead.

---

## Troubleshooting

**`recallr ask` says "failed to reach LLM at http://localhost:11434/v1"**
You don't have Ollama running and no provider env var is set. Either:
- start Ollama (`ollama serve` + `ollama pull llama3.2`), or
- set one of `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY`, or
- point at any OpenAI-compatible endpoint via `RECALLR_LLM_BASE_URL` +
  `RECALLR_LLM_MODEL`.

See [Connect an LLM](#3-connect-an-llm) for full instructions.

**`recallr ask` says "LLM returned 401"**
The `RECALLR_LLM_API_KEY` (or `OPENAI_API_KEY`) is missing or wrong for
the base URL you're using. Double-check that the key matches the provider
of `RECALLR_LLM_BASE_URL`.

**`recallr ask` says "LLM returned 404 / model not found"**
The model id in `RECALLR_LLM_MODEL` doesn't exist on that endpoint. List
available models from the provider's docs and set `RECALLR_LLM_MODEL`
(or pass `--llm-model` per call).

**`recallr index` is slow on first run**
The embedding model (~33MB, `Xenova/bge-small-en-v1.5`) downloads once
into `~/.recallr/`. After that indexing is fast. Pass `--no-embed` for a
~10× faster lexical-only index if you want a quick smoke test.

**`recallr status` shows 0 messages**
Run `recallr init`, edit `~/.recallr/config.json` to add real sources,
then `recallr index`. Or just `recallr index <path-to-mbox-or-slack-export>`.

**MCP tools don't show up in Cursor/Claude Desktop**
Confirm the absolute path to `npx` resolves on the host (some configs need
`"command": "/usr/local/bin/npx"` or the full Windows path). On first call
the model is downloaded — give it 10-20s.

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
                        │ recallr ask    │           │ recallr mcp      │  │ recallr     │
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

Each connector normalizes its source into a single `Message` shape. The indexer is idempotent: re-running `recallr index` only fetches what's new and only embeds what hasn't been embedded. Search is hybrid — FTS5 BM25 pulls candidates, embedding cosine reranks them, results are fused by min-max-normalized score.

For corpora under ~250k messages everything fits comfortably on a laptop. Past that, swap in `sqlite-vec` (planned for v0.3).

---

## Use as a library

Everything the CLI does is also a public TypeScript API. Embed recallr inside
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
} from "recallr";

const store = await SqliteStore.open("./alice.recallr.db");
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

The full type surface is exported from `recallr` and `recallr/mcp`.

---

## Roadmap

`recallr` is brand new. The shape of v0.1 is intentionally tight; the roadmap is community-driven.

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
- `recallr watch` daemon: continuously sync configured live sources

**v0.4 — UI v2**

- Streaming answers with live citation expansion
- Faceted search: filter by source, date range, participant
- Thread browser sidebar
- Light-mode polish (dark mode is default today)

**v1.0 — polish**

- Encrypted-at-rest mode (libsodium-wrapped db)
- Per-source redaction rules
- Connector plugin system (`recallr-connector-*` packages)

---

## Contributing

Adding a connector is the highest-leverage way to help. Implement the
[`Connector` interface](src/types.ts) and emit normalized `Message` objects
from `fetch()`. See [`src/connectors/mbox.ts`](src/connectors/mbox.ts) and
[`src/connectors/slack.ts`](src/connectors/slack.ts) as references.

```bash
git clone https://github.com/flowdesktech/recallr && cd recallr
npm install
npm run test
npm run build
node dist/cli/bin.js index examples/sample.mbox
node dist/cli/bin.js ask "what did the team decide about pricing?"
```

---

## License

[MIT](LICENSE) © Flowdesk

Recallr is part of [Flowdesk's open source initiative](https://github.com/flowdesktech).