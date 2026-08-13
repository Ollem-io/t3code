# PA-M06 ownership review artifact

`verify-prime-ownership.ts` imports the production `PrimeResourceLayout` and
`PrimeOwnership` exports (it does not reimplement them). It creates temporary
T3 homes, writes two exact ownership records, and proves scoped cleanup stops
and removes only the selected handle while a separate home and unrelated
sentinel remain intact.

Run from repository root after dependencies are installed:

```sh
vp tsx apps/server/src/provider/prime/verify-prime-ownership.ts
```

It uses only `mkdtemp` directories and can be run repeatedly.
