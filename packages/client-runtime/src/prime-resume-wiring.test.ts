import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClientOrchestrationCommand,
  OrchestrationSession,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";

import {
  PRIME_RESUME_COMPOSER_BLOCKED_REASON,
  initialPrimeResumeModel,
  primeResumeAwaitingChoice,
  primeResumeBlocksComposer,
  primeResumeRecoveryRoute,
  primeResumeReduce,
  primeResumeSurface,
  type PrimeResumeModel,
} from "./primeResume.ts";

const model = (over: Partial<PrimeResumeModel> = {}): PrimeResumeModel => ({
  ...initialPrimeResumeModel,
  ...over,
});

/**
 * PA-B04 repair regressions. Each block pins one thing the first round shipped
 * without: a wire that can carry the state, a command that can answer it, and
 * the two client-side rules those depend on.
 */
describe("prime resume wiring", () => {
  // BLOCKER: no transport carried PrimeResumeState to any client, so the
  // banner could only ever render hidden.
  it("carries a published resume state on the canonical runtime event", () => {
    const decoded = Schema.decodeUnknownSync(ProviderRuntimeEvent)({
      eventId: "prime-resume-1",
      provider: "prime-agent",
      providerInstanceId: "prime-agent",
      threadId: "thread-1",
      createdAt: "2026-08-16T00:00:00.000Z",
      type: "session.resume.updated",
      payload: { resume: { status: "unavailable", reason: "capabilityMismatch" } },
    });
    expect(decoded.type).toBe("session.resume.updated");
    expect(decoded.payload).toEqual({
      resume: { status: "unavailable", reason: "capabilityMismatch" },
    });
  });

  it("carries the resume state on the thread session every client reads", () => {
    const session = Schema.decodeUnknownSync(OrchestrationSession)({
      threadId: "thread-1",
      status: "error",
      providerName: "prime-agent",
      providerInstanceId: "prime-agent",
      runtimeMode: "auto",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-16T00:00:00.000Z",
      resumeState: { status: "resumed", mode: "adopted" },
    });
    expect(session.resumeState).toEqual({ status: "resumed", mode: "adopted" });
    // A session that never had a durable resume simply has none; the field must
    // stay optional so older servers keep decoding.
    expect(
      Schema.decodeUnknownSync(OrchestrationSession)({
        threadId: "thread-1",
        status: "idle",
        providerName: null,
        runtimeMode: "auto",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-08-16T00:00:00.000Z",
      }).resumeState,
    ).toBeUndefined();
  });

  // BLOCKER: retry/fork/fresh dispatched nowhere, so a capabilityMismatch
  // thread stayed bricked.
  it("accepts a retry and a confirmed cursor-discarding fresh start as commands", () => {
    for (const command of [
      { intent: "retry" },
      { intent: "fresh", discardCursor: true },
    ] as const) {
      const decoded = Schema.decodeUnknownSync(ClientOrchestrationCommand)({
        type: "thread.prime-resume.recover",
        commandId: "command-1",
        threadId: "thread-1",
        createdAt: "2026-08-16T00:00:00.000Z",
        ...command,
      });
      expect(decoded.type).toBe("thread.prime-resume.recover");
    }
  });

  it("routes fork back to the existing fork command and never discards on retry", () => {
    expect(primeResumeRecoveryRoute({ kind: "fork" })).toEqual({ kind: "fork" });
    expect(primeResumeRecoveryRoute({ kind: "retry" })).toEqual({
      kind: "recover",
      intent: "retry",
      discardCursor: false,
    });
    expect(primeResumeRecoveryRoute({ kind: "fresh", discardCursor: true })).toEqual({
      kind: "recover",
      intent: "fresh",
      discardCursor: true,
    });
  });

  // BLOCKER: the composer was only *told* it was paused.
  it("blocks the composer for every refusal that is not 'nothing to resume'", () => {
    expect(
      primeResumeBlocksComposer(
        "prime-agent",
        model({ state: { status: "unavailable", reason: "capabilityMismatch" } }),
      ),
    ).toBe(true);
    expect(
      primeResumeBlocksComposer("prime-agent", model({ state: { status: "reconnecting" } })),
    ).toBe(true);
    expect(
      primeResumeBlocksComposer(
        "prime-agent",
        model({ state: { status: "unavailable", reason: "missing" } }),
      ),
    ).toBe(false);
    expect(PRIME_RESUME_COMPOSER_BLOCKED_REASON.length).toBeGreaterThan(0);
  });

  // NON-BLOCKER: an in-flight choice left the buttons live.
  it("marks a dispatched choice as in flight until the host answers", () => {
    const chosen = primeResumeReduce(
      model({ state: { status: "unavailable", reason: "capabilityMismatch" } }),
      { type: "choice", intent: { kind: "fresh", discardCursor: true } },
    );
    expect(primeResumeAwaitingChoice(chosen)).toBe(true);
    expect(
      primeResumeAwaitingChoice(
        primeResumeReduce(chosen, { type: "state", state: { status: "reconnecting" } }),
      ),
    ).toBe(false);
    // A fork is pending too — one click must never become two forked threads.
    // Its answer is a new thread rather than a resume state for this one, so
    // the dispatching caller clears the wait with a `settled` event when the
    // fork command resolves.
    const forking = primeResumeReduce(
      model({ state: { status: "unavailable", reason: "capabilityMismatch" } }),
      { type: "choice", intent: { kind: "fork" } },
    );
    expect(primeResumeAwaitingChoice(forking)).toBe(true);
    expect(primeResumeAwaitingChoice(primeResumeReduce(forking, { type: "settled" }))).toBe(false);
  });

  // NON-BLOCKER: a two-device conflict was a dead end with retry only.
  it("offers a fork escape hatch on a conflict without ever offering a discard", () => {
    for (const reason of ["conflict", "unauthorized"] as const) {
      const surface = primeResumeSurface(
        "prime-agent",
        model({ state: { status: "unavailable", reason } }),
      );
      expect(surface.choices.map((choice) => choice.kind)).toEqual(["retry", "fork"]);
      // Discarding a cursor while another writer is authoritative would be a
      // fight over a session this client cannot see the state of.
      expect(surface.choices.some((choice) => choice.kind === "fresh")).toBe(false);
      // Still identity-free.
      expect(surface.detail).not.toMatch(/device|path|owner|\//i);
    }
  });
});
