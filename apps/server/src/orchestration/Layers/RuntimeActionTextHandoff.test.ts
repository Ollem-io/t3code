import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { RuntimeActionTextHandoff } from "../Services/RuntimeActionTextHandoff.ts";
import { RuntimeActionTextHandoffLive } from "./RuntimeActionTextHandoff.ts";

const testLayer = Layer.merge(RuntimeActionTextHandoffLive, TestClock.layer());
const withHandoff = <A, E>(effect: Effect.Effect<A, E, RuntimeActionTextHandoff>) =>
  effect.pipe(Effect.provide(testLayer));

it.effect("RuntimeActionTextHandoff consumes text exactly once", () =>
  Effect.gen(function* () {
    const handoff = yield* RuntimeActionTextHandoff;
    expect(yield* handoff.put({ commandId: "one", text: "provider-only" })).toBe(true);
    expect(yield* handoff.take("one")).toBe("provider-only");
    expect(yield* handoff.take("one")).toBeUndefined();
  }).pipe(withHandoff),
);

it.effect("RuntimeActionTextHandoff rejects duplicate keys and discard removes text", () =>
  Effect.gen(function* () {
    const handoff = yield* RuntimeActionTextHandoff;
    expect(yield* handoff.put({ commandId: "duplicate", text: "first" })).toBe(true);
    expect(yield* handoff.put({ commandId: "duplicate", text: "second" })).toBe(false);
    yield* handoff.discard("duplicate");
    expect(yield* handoff.take("duplicate")).toBeUndefined();
  }).pipe(withHandoff),
);

it.effect("RuntimeActionTextHandoff is bounded to 256 entries", () =>
  Effect.gen(function* () {
    const handoff = yield* RuntimeActionTextHandoff;
    for (let index = 0; index < 256; index += 1) {
      expect(yield* handoff.put({ commandId: `key-${index}`, text: `${index}` })).toBe(true);
    }
    expect(yield* handoff.put({ commandId: "overflow", text: "nope" })).toBe(false);
  }).pipe(withHandoff),
);

it.effect("RuntimeActionTextHandoff expires text using the Effect clock", () =>
  Effect.gen(function* () {
    const handoff = yield* RuntimeActionTextHandoff;
    expect(yield* handoff.put({ commandId: "expires", text: "short-lived" })).toBe(true);
    yield* TestClock.adjust("60 seconds");
    expect(yield* handoff.take("expires")).toBeUndefined();
  }).pipe(withHandoff),
);
