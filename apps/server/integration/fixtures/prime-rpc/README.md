# Prime RPC fixtures

These small, LF-terminated JSONL fixtures define T3's append-only Prime Agent **0.7.2** protocol corpus. Add a new version directory or new fixture; do not rewrite historical protocol evidence.

## Provenance and redaction

Field names and shapes were confirmed read-only from the installed Prime Agent 0.7.2 RPC declarations and implementation (`dist/modes/rpc/rpc-types.*`). Values are synthetic: `fixture-*`, `model-1`, `fixture-provider`, and `example.invalid`. Fixtures contain no credentials, user prompts, transcripts, real model identifiers, session identifiers, filesystem paths, or hostnames.

## Cases

- `normal.jsonl`: model discovery command, correlated success, and core event.
- `additive-field.jsonl`: future additive fields which must remain decodable.
- `malformed.jsonl`: missing/wrong required fields, classified locally as compatibility failures.
- `unknown-event.jsonl`: forward-compatible event classification without a crash.
- `review-prime-rpc-fixtures.mjs`: source-free Node decoder/classifier review artifact.

## Standalone review proof

From any checkout with Node (no `vp`, `node_modules`, or repository source required), run:

```sh
node review-prime-rpc-fixtures.mjs
```

It reads this directory's JSONL corpus and prints only each fixture name, decoded envelope class, and `pass`/`fail`. Its checks visibly cover additive-field acceptance, missing-required-field compatibility failures, and unknown-event classification. It is intentionally a small independently portable review artifact, synchronized with the corpus rather than a production decoder.

## Deterministic fake executable

`fake-prime-agent.mjs` is a process-level fake whose contract is `prime-agent --mode rpc`: it accepts LF JSON command records on stdin and writes LF JSON responses/events on stdout. It ignores process flags other than accepting `--mode rpc`, has no network/auth/filesystem dependency, and only returns synthetic data. PA-M03 may spawn it with `node <path>/fake-prime-agent.mjs --mode rpc` to exercise real stdin/stdout chunking.
