import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RuntimeActionTextHandoff } from "../Services/RuntimeActionTextHandoff.ts";

const CAPACITY = 256;
const TTL_MS = 60_000;
/** Bounded, process-local only; values are removed by take/discard or expiry. */
export const RuntimeActionTextHandoffLive = Layer.effect(RuntimeActionTextHandoff, Effect.sync(() => {
  const entries = new Map<string, { readonly text: string; readonly expiresAt: number }>();
  const reap = (now: number) => {
    for (const [key, value] of entries) {
      if (value.expiresAt <= now) entries.delete(key);
    }
  };
  return {
    put: ({ commandId, text }) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      reap(now);
      if (entries.has(commandId) || entries.size >= CAPACITY) return false;
      entries.set(commandId, { text, expiresAt: now + TTL_MS });
      return true;
    }),
    take: (commandId) => Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      reap(now);
      const entry = entries.get(commandId);
      entries.delete(commandId);
      return entry?.text;
    }),
    discard: (commandId) => Effect.sync(() => { entries.delete(commandId); }),
  };
}));
