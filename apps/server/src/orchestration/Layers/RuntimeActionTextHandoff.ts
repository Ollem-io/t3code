import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RuntimeActionTextHandoff } from "../Services/RuntimeActionTextHandoff.ts";

const CAPACITY = 256;
const TTL_MS = 60_000;
/** Bounded, process-local only; values are removed by take/discard or expiry. */
export const RuntimeActionTextHandoffLive = Layer.effect(RuntimeActionTextHandoff, Effect.sync(() => {
  const entries = new Map<string, { readonly text: string; readonly expiresAt: number }>();
  const reap = () => { const now = Date.now(); for (const [key, value] of entries) if (value.expiresAt <= now) entries.delete(key); };
  return {
    put: ({ commandId, text }) => Effect.sync(() => { reap(); if (entries.has(commandId) || entries.size >= CAPACITY) return false; entries.set(commandId, { text, expiresAt: Date.now() + TTL_MS }); return true; }),
    take: (commandId) => Effect.sync(() => { reap(); const entry = entries.get(commandId); entries.delete(commandId); return entry?.text; }),
    discard: (commandId) => Effect.sync(() => { entries.delete(commandId); }),
  };
}));
