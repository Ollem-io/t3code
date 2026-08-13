# PA-M04 contract artifact

The review artifact is `verify-prime-agent-contracts.bundle.mjs`. It is generated from
`verify-prime-agent-contracts.ts`, which imports and executes the production exports
`ServerSettings`, `ServerSettingsPatch`, `ProviderInstanceConfig`, `ModelSelection`,
`ServerProvider`, and `bootstrapPrimeAgentServerSettings`. The bundle includes Effect.
It does not load repository source or `node_modules` at runtime.

Review it from any directory containing only the bundle and fixture:

```sh
node verify-prime-agent-contracts.bundle.mjs --fixture prime-agent-contract-round-trip.json
```

The fixture argument is deliberately restricted to an adjacent JSON file. A failed
assertion, malformed fixture, or contract decode failure exits nonzero.

Regenerate from the repository root with Vite Plus:

```sh
/root/.vite-plus/bin/vp pack packages/contracts/fixtures/verify-prime-agent-contracts.ts --out-dir packages/contracts/fixtures/.bundle-tmp --no-clean --no-sourcemap --platform node --format esm --target node24 --minify --no-report
cp packages/contracts/fixtures/.bundle-tmp/verify-prime-agent-contracts.mjs packages/contracts/fixtures/verify-prime-agent-contracts.bundle.mjs
rm -rf packages/contracts/fixtures/.bundle-tmp
```

No source map, build timestamp, or absolute repository path is emitted. Repeating the
command must produce a byte-identical bundle. The older
`verify-prime-agent-contract-round-trip.mjs` remains only as a supplemental portable
behavior description; it is not the source-derived review artifact. Secret redaction
is server behavior outside the contracts package and remains covered by the exact
native `apps/server/src/serverSettings.test.ts` test rather than being falsely
reimplemented in this artifact.
