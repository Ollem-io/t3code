# PA-M06 ownership review artifact

`prime-ownership-artifact.mjs` is a committed standalone Node ESM bundle derived from
`PrimeOwnership.ts` and `PrimeResourceLayout.ts`; it imports only Node built-ins, not
`tsx`, `vp`, or repository dependencies. Its SHA-256 is `026b0ec605d2c82a95d889e80704dd341b6d3aa1aeca2d7bc2d90dd888c59c90`.

Run repeatedly from this directory or repository root:

```sh
node apps/server/src/provider/prime/verify-prime-ownership.mjs
sha256sum apps/server/src/provider/prime/prime-ownership-artifact.mjs
```

The verifier creates two `mkdtemp` homes and removes them in `finally`, including on
failure. It proves an exact matching process is stopped while the other home and an
unrelated sentinel are retained.
