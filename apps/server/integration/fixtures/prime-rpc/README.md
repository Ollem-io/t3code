# Prime RPC fixtures

These small, LF-terminated JSONL fixtures define T3's append-only Prime Agent **0.7.2** protocol corpus. Add a new version directory or new fixture; do not rewrite historical protocol evidence.

## Provenance and redaction

Field names and shapes were confirmed read-only from the installed Prime Agent 0.7.2 declarations and implementation. Command `ThinkingLevel` comes from `@earendil-works/pi-agent-core` via `dist/modes/rpc/rpc-types.d.ts`, while model `ThinkingLevelMap` comes from `@earendil-works/pi-ai` and is a partial map over `off | minimal | low | medium | high | xhigh | max` with `string | null` values. The production decoder, portable classifier, and fake peer preserve that distinction. Values are synthetic: `fixture-*`, `model-1`, `fixture-provider`, and `example.invalid`. Fixtures contain no credentials, user prompts, transcripts, real model identifiers, session identifiers, filesystem paths, or hostnames.

## Cases

- `normal.jsonl`: model discovery with a declaration-shaped `thinkingLevelMap`, image input, the installed command-level `off` thinking level, declaration-shaped message start/update/end events, core tool envelopes, and extension UI envelopes.
- `additive-field.jsonl`: future additive fields which must remain decodable.
- `malformed.jsonl`: missing/wrong command, image, model (including wrong-value, unknown-key, and non-object `thinkingLevelMap` cases), message/event/tool, and extension UI fields, classified locally as compatibility failures.
- `unknown-event.jsonl`: forward-compatible event classification without a crash.
- `review-prime-rpc-fixtures.mjs`: source-free Node decoder/classifier review artifact.

## Standalone review proof

From any checkout with Node (no `vp`, `node_modules`, or repository source required), run:

```sh
node review-prime-rpc-fixtures.mjs
```

It reads this directory's JSONL corpus and prints only each fixture name, decoded envelope class, and `pass`/`fail`. Its dependency-free validators mirror every supported command, model, image, core event/tool, and extension UI envelope in the production boundary. They visibly cover additive-field acceptance, missing-required-field compatibility failures, and unknown-event classification. The integration test locks its expected classifications to the same corpus.

## PA-M03 source-derived client/process review artifact

The three PA-M03 review files are `review-prime-rpc-client.bundle.mjs`,
`fake-prime-agent.mjs`, and this README. The bundle is generated from
`review-prime-rpc-client.ts`, which imports the production `PrimeRpcClient`,
`PrimeRpcProcessTransport`, protocol decoder, and framing implementation before
bundling all runtime dependencies. The fake remains a deterministic process peer
only; it contains no production executable-discovery or launch policy.

Copy only the bundle and fake into a fresh directory with Node, then run:

```sh
node review-prime-rpc-client.bundle.mjs
```

The runner copies the adjacent fake into its own temporary source-free directory,
spawns that exact child through Node, and proves real stdin/stdout/stderr lifecycle:
interleaved correlation; unread bounded events; duplicate, mismatch, abort-late,
timeout, EOF, and nonzero-exit exact-once fanout; bounded redacted stderr; terminal
write failure; and event drain/close. A missing/corrupt fake or failed assertion
exits nonzero. Cleanup closes only transports/child processes created by the run.

Regenerate from repository root (the committed source is reviewable, but is not
needed at artifact runtime):

```sh
rm -rf apps/server/integration/fixtures/prime-rpc/.bundle-tmp
./node_modules/.bin/vp pack apps/server/integration/fixtures/prime-rpc/review-prime-rpc-client.ts --out-dir apps/server/integration/fixtures/prime-rpc/.bundle-tmp --no-clean --no-sourcemap --platform node --format esm --target node24 --minify --no-report
cp apps/server/integration/fixtures/prime-rpc/.bundle-tmp/review-prime-rpc-client.mjs apps/server/integration/fixtures/prime-rpc/review-prime-rpc-client.bundle.mjs
rm -rf apps/server/integration/fixtures/prime-rpc/.bundle-tmp
./node_modules/.bin/vp fmt apps/server/integration/fixtures/prime-rpc/review-prime-rpc-client.bundle.mjs
sha256sum apps/server/integration/fixtures/prime-rpc/review-prime-rpc-client.bundle.mjs
```

No source map, timestamp, or absolute repository path is emitted. Two consecutive
regenerations must be byte-identical. The expected SHA-256 is
`b80c823d4d25523b7a1852fff7763fa80f5c99992130612e0a83f4458479d4bd`.

## PA-M02 portable framing conformance

`PrimeRpcFraming.ts` is the production source of truth. Its focused unit test
and `prime-rpc-jsonl-conformance.mjs` lock the same frozen PA-M02 cases. The
portable script is a deliberately dependency-free copy of that small framing
algorithm: changing production framing requires updating its case list and
running both checks, so it cannot silently drift.

The artifact has no fixture or repository dependency. To prove this from a
fresh directory with only Node installed:

```sh
mkdir /tmp/prime-rpc-proof && cd /tmp/prime-rpc-proof
cp /path/to/prime-rpc-jsonl-conformance.mjs .
node prime-rpc-jsonl-conformance.mjs
```

It prints one `case pass` or `case fail` line for every frozen PA-M02 framing
case and exits nonzero on any failure. The parser API is `push(chunk, emit)`:
each complete value is synchronously emitted before decoding continues, so a
later malformed record cannot hide a prior valid record. Parser failures and
consumer callback throws are terminal, clear retained bytes, and never attach
raw or decoded payloads to an error.

The proof covers LF-only framing (including terminal invalid-JSON empty lines),
one-CR CRLF handling, Unicode separators as payload, arbitrary three-way chunk
partitions across UTF-8 data, valid-then-invalid JSON/UTF-8/oversize calls,
many-fragment exact/one-byte-over total-buffer caps, EOF and idempotent finish,
redacted errors, and writer payload caps. The writer's cap measures encoded UTF-8 JSON
payload bytes excluding its required LF. As with all JSON.stringify-based
writers, serializing a huge input allocates the complete JSON string before the
cap can reject it; the implementation avoids additionally constructing an
unbounded string with the LF suffix.
