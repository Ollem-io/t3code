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

## Deterministic fake executable

`fake-prime-agent.mjs` is a process-level fake whose contract is `prime-agent --mode rpc`: it accepts LF JSON command records on stdin and writes LF JSON responses/events on stdout. It ignores process flags other than accepting `--mode rpc`, has no network/auth/filesystem dependency, and only returns synthetic data. PA-M03 may spawn it with `node <path>/fake-prime-agent.mjs --mode rpc` to exercise real stdin/stdout chunking.


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
case and exits nonzero on any failure. It covers LF-only framing, one-CR CRLF
handling, Unicode separators as payload, every UTF-8 byte boundary, malformed
UTF-8/JSON terminal failures (including no later record emission), bounded
single-record/total buffer behavior, EOF and idempotent finish, redacted
errors, and writer payload caps. The writer's cap measures encoded UTF-8 JSON
payload bytes excluding its required LF. As with all JSON.stringify-based
writers, serializing a huge input allocates the complete JSON string before the
cap can reject it; the implementation avoids additionally constructing an
unbounded string with the LF suffix.
