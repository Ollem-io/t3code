# PA-M06 ownership review artifact

`prime-ownership-artifact.mjs` is a committed standalone Node ESM bundle derived from
`PrimeOwnership.ts` and `PrimeResourceLayout.ts`; it imports only Node built-ins, not
`tsx`, `vp`, or repository dependencies. Its SHA-256 is `ad16f3bae222780080d1390fc6b7e3ff5e5d7f4c4daf9444200dbd81116d94ad`.

Run repeatedly from this directory or repository root:

```sh
node apps/server/src/provider/prime/verify-prime-ownership.mjs
sha256sum apps/server/src/provider/prime/prime-ownership-artifact.mjs
```

The verifier creates two `mkdtemp` homes and removes them in `finally`, including on
failure. It proves an exact matching process is stopped while the other home and an
unrelated sentinel are retained.
