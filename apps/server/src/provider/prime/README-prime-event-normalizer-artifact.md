# PA-M09 event normalizer artifact

```sh
./generate-prime-event-normalizer-artifact.sh
cp prime-event-normalizer-artifact.mjs /tmp/ && cd /tmp
node prime-event-normalizer-artifact.mjs
```

The detached artifact produces a golden canonical transcript and verifies exactly-once completion, assistant/reasoning/tool mapping, bounded unknown warnings, and linear transfer for 1,000 accumulated tool snapshots.
