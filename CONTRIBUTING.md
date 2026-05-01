# Contributing to mneme

Thanks for considering a contribution. The two highest-leverage things you can do are:

1. **Add a connector.** Implement the `Connector` interface in
   [`src/types.ts`](src/types.ts). See
   [`src/connectors/mbox.ts`](src/connectors/mbox.ts) for a ~150-line reference.
2. **Improve retrieval quality.** The hybrid search in
   [`src/store/sqlite.ts`](src/store/sqlite.ts) uses a 0.4/0.6 BM25/cosine
   blend after min-max normalization. If you can show better recall on a
   real corpus, we want it.

## Development

```bash
git clone https://github.com/flowdesktech/mneme && cd mneme
npm install
npm run dev            # tsup watch mode
npm test               # vitest
npm run typecheck
npm run lint
```

Run the demo locally:

```bash
npm run build
node dist/cli/bin.js index examples/sample.mbox
node dist/cli/bin.js ask "what did the team decide about pricing?"
```

## Style

- Strict TypeScript. `noUncheckedIndexedAccess` is on; bracket access returns `T | undefined`.
- Biome handles formatting (`npm run format`) and linting.
- Comments explain *why*, never *what*. Code that needs comments to be readable should be rewritten.
- One file per concept. We split early and often — `src/store/sqlite.ts`, not `src/store.ts`.

## Adding a connector

A connector is a class that implements:

```ts
interface Connector {
  readonly name: string;
  readonly source: Source;
  fetch(opts?: { since?: number; signal?: AbortSignal }): AsyncIterable<Message>;
}
```

It must:

1. Yield messages with **stable ids** (typically `${source}:${stableSourceId}`)
   so re-indexing is idempotent.
2. Respect `since` as a best-effort filter (skipping ahead is fine,
   yielding extras is fine — the store dedupes by id).
3. Honor `signal.aborted`.
4. Never crash on malformed input. Skip bad rows; log nothing in the
   default path.

Send a PR adding the connector to `src/connectors/`, wire it into
`src/cli/commands/index.ts`, and add a test against a fixture under
`examples/`. We'll review within 48 hours.

## Releasing

Maintainers only:

```bash
npm version patch       # or minor / major
npm publish
git push --follow-tags
```

CI on `main` runs `npm publish --provenance` automatically when a tag is pushed.
