import { describe, expect, it } from "vite-plus/test";

import {
  PRIME_RESUME_ARCHIVE_NOTE,
  PRIME_RESUME_FRESH_CONFIRM,
  PRIME_RESUME_STOP_NOTE,
  initialPrimeResumeModel,
  primeResumeAwaitingChoice,
  primeResumeBlocksComposer,
  primeResumeFailureSurface,
  primeResumeIntentFor,
  primeResumeReduce,
  primeResumeSurface,
  renderPrimeResume,
  type PrimeResumeModel,
} from "./primeResume.ts";
import { PRIME_RESUME_FAILURE_REASONS } from "@t3tools/contracts";

const model = (over: Partial<PrimeResumeModel> = {}): PrimeResumeModel => ({
  ...initialPrimeResumeModel,
  ...over,
});

describe("prime resume client model", () => {
  it("shows nothing for another provider or before the host published anything", () => {
    expect(primeResumeSurface("codex", model({ state: { status: "reconnecting" } })).kind).toBe(
      "hidden",
    );
    expect(primeResumeSurface("prime-agent", model()).kind).toBe("hidden");
    expect(renderPrimeResume("prime-agent", model())).toEqual([]);
  });

  it("blocks the composer while the outcome is unknown and releases it once resumed", () => {
    expect(
      primeResumeBlocksComposer("prime-agent", model({ state: { status: "reconnecting" } })),
    ).toBe(true);
    for (const mode of ["adopted", "relaunched"] as const) {
      const surface = primeResumeSurface(
        "prime-agent",
        model({ state: { status: "resumed", mode } }),
      );
      expect(surface.kind).toBe("resumed");
      expect(surface.composerBlocked).toBe(false);
      expect(surface.choices).toEqual([]);
    }
  });

  // The acceptance criterion of the whole milestone: no failed resume may leave
  // the user typing into what would silently become a new conversation.
  it("blocks the composer for every failure reason except 'nothing to resume'", () => {
    for (const reason of PRIME_RESUME_FAILURE_REASONS) {
      const surface = primeResumeFailureSurface(reason);
      expect(surface.reason).toBe(reason);
      if (reason === "missing") {
        expect(surface.kind).toBe("missing");
        expect(surface.composerBlocked).toBe(false);
        expect(surface.choices).toEqual([]);
      } else {
        expect(surface.composerBlocked).toBe(true);
        expect(surface.choices.length).toBeGreaterThan(0);
      }
    }
  });

  // PA-B02 accepted non-blocker: a capability mismatch used to brick a thread
  // because only `missing` may start fresh. Recovery now discards the cursor.
  it("offers a cursor-discarding fresh start for every non-conflict refusal", () => {
    for (const reason of PRIME_RESUME_FAILURE_REASONS) {
      const surface = primeResumeFailureSurface(reason);
      if (reason === "missing" || reason === "conflict" || reason === "unauthorized") {
        expect(primeResumeIntentFor(surface, "fresh")).toBeUndefined();
        continue;
      }
      expect(primeResumeIntentFor(surface, "fresh")).toEqual({
        kind: "fresh",
        discardCursor: true,
      });
      expect(surface.choices.find((choice) => choice.kind === "fresh")?.confirm).toBe(
        PRIME_RESUME_FRESH_CONFIRM,
      );
    }
    expect(primeResumeFailureSurface("capabilityMismatch").kind).toBe("forkRequired");
    expect(primeResumeIntentFor(primeResumeFailureSurface("capabilityMismatch"), "fork")).toEqual({
      kind: "fork",
    });
  });

  it("identifies a two-device conflict without leaking who holds it", () => {
    for (const reason of ["conflict", "unauthorized"] as const) {
      const surface = primeResumeFailureSurface(reason);
      expect(surface.kind).toBe("conflict");
      // Retry, plus fork as the escape hatch for a writer that never finishes.
      // A fresh start is still refused: fighting the authoritative writer for
      // the session is precisely the two-writer outcome PA-B03 exists to
      // prevent, and forking takes nothing away from whoever holds it.
      expect(surface.choices.map((choice) => choice.kind)).toEqual(["retry", "fork"]);
      expect(primeResumeIntentFor(surface, "fresh")).toBeUndefined();
      const text = `${surface.title} ${surface.detail}`;
      for (const leak of ["device", "/", "session id", "pid", "user", "host"])
        expect(text.toLowerCase().includes(leak)).toBe(false);
    }
  });

  it("never claims recovery copy is destructive for stop or archive", () => {
    expect(PRIME_RESUME_STOP_NOTE).toContain("kept");
    expect(PRIME_RESUME_ARCHIVE_NOTE).toContain("Nothing is deleted");
    expect(PRIME_RESUME_FRESH_CONFIRM).toContain("nothing on disk is deleted");
  });

  it("settles a reconnect that never got its terminal follow-up", () => {
    let current = primeResumeReduce(model(), { type: "state", state: { status: "reconnecting" } });
    // A non-terminal status is not an answer, so the spinner stays honest.
    current = primeResumeReduce(current, { type: "sessionStatus", status: "starting" });
    expect(primeResumeSurface("prime-agent", current).kind).toBe("reconnecting");
    current = primeResumeReduce(current, { type: "sessionStatus", status: "error" });
    const stalled = primeResumeSurface("prime-agent", current);
    expect(stalled.kind).toBe("stalled");
    expect(stalled.composerBlocked).toBe(true);
    expect(stalled.choices.map((choice) => choice.kind)).toEqual(["retry", "fork", "fresh"]);
    // The button says the earlier session is left behind, so it discards the
    // cursor for real; a "fresh start" that quietly retried would be a lie and
    // would stall again on exactly the cursor that stalled the first time.
    expect(primeResumeIntentFor(stalled, "fresh")).toEqual({ kind: "fresh", discardCursor: true });
  });

  // PA-B04 regression: resume state is per-thread. A refusal on thread A must
  // not survive a switch to thread B — a false banner there would block a
  // composer with nothing to recover.
  it("resets when the viewer switches threads", () => {
    const refused = primeResumeReduce(model(), {
      type: "state",
      state: { status: "unavailable", reason: "corrupt" },
    });
    expect(primeResumeSurface("prime-agent", refused).composerBlocked).toBe(true);
    const switched = primeResumeReduce(refused, { type: "thread" });
    expect(switched).toEqual(initialPrimeResumeModel);
    expect(primeResumeSurface("prime-agent", switched).kind).toBe("hidden");
    expect(primeResumeBlocksComposer("prime-agent", switched)).toBe(false);
  });

  // PA-B04 regression: a launch that fails after validation publishes a
  // terminal refusal instead of leaving `reconnecting` as the last word, and
  // the launchFailed reason surfaces the full recovery set.
  it("offers full recovery when the relaunch itself failed", () => {
    const announced = primeResumeReduce(model(), {
      type: "state",
      state: { status: "reconnecting" },
    });
    const failed = primeResumeReduce(announced, {
      type: "state",
      state: { status: "unavailable", reason: "launchFailed" },
    });
    const surface = primeResumeSurface("prime-agent", failed);
    expect(surface.kind).toBe("unavailable");
    expect(surface.composerBlocked).toBe(true);
    expect(surface.choices.map((choice) => choice.kind)).toEqual(["retry", "fork", "fresh"]);
  });

  // PA-B04 regression: one fork click must never become two forked threads.
  // The fork is pending while its command runs, and the caller clears it with
  // `settled` when the command resolves — its answer is a new thread, not a
  // resume state for this one.
  it("guards a fork in flight and re-arms the buttons once it settles", () => {
    const refused = primeResumeReduce(model(), {
      type: "state",
      state: { status: "unavailable", reason: "conflict" },
    });
    const forking = primeResumeReduce(refused, { type: "choice", intent: { kind: "fork" } });
    expect(primeResumeAwaitingChoice(forking)).toBe(true);
    const settled = primeResumeReduce(forking, { type: "settled" });
    expect(primeResumeAwaitingChoice(settled)).toBe(false);
    // The refusal (and its choices) survives the round trip untouched.
    expect(primeResumeSurface("prime-agent", settled).kind).toBe("conflict");
  });

  // PA-B04 regression: the retry that answers with the *same* refusal.
  // The host publishes `reconnecting` before it revalidates, so a refusal that
  // repeats itself still arrives as a transition; without it the client sat on
  // its locally-entered reconnecting state forever, composer shut and every
  // recovery button disabled by `pending`.
  it("re-offers recovery when a retry lands on the identical refusal", () => {
    const refused = primeResumeReduce(model(), {
      type: "state",
      state: { status: "unavailable", reason: "corrupt" },
    });
    const retrying = primeResumeReduce(refused, { type: "choice", intent: { kind: "retry" } });
    expect(primeResumeAwaitingChoice(retrying)).toBe(true);
    const announced = primeResumeReduce(retrying, {
      type: "state",
      state: { status: "reconnecting" },
    });
    const answered = primeResumeReduce(announced, {
      type: "state",
      state: { status: "unavailable", reason: "corrupt" },
    });
    expect(primeResumeAwaitingChoice(answered)).toBe(false);
    const surface = primeResumeSurface("prime-agent", answered);
    expect(surface.kind).toBe("unavailable");
    expect(surface.choices.map((choice) => choice.kind)).toEqual(["retry", "fork", "fresh"]);
  });

  // PA-B04 regression: a confirmed fresh start that the host honoured has to
  // end the block. The terminal state is `missing` — there is genuinely no
  // durable session left — and `missing` must not block the composer.
  it("reopens the composer once a confirmed fresh start reports no session left", () => {
    const refused = primeResumeReduce(model(), {
      type: "state",
      state: { status: "unavailable", reason: "capabilityMismatch" },
    });
    expect(primeResumeBlocksComposer("prime-agent", refused)).toBe(true);
    const chosen = primeResumeReduce(refused, {
      type: "choice",
      intent: { kind: "fresh", discardCursor: true },
    });
    const announced = primeResumeReduce(chosen, {
      type: "state",
      state: { status: "reconnecting" },
    });
    const settled = primeResumeReduce(announced, {
      type: "state",
      state: { status: "unavailable", reason: "missing" },
    });
    expect(primeResumeAwaitingChoice(settled)).toBe(false);
    expect(primeResumeSurface("prime-agent", settled).kind).toBe("missing");
    expect(primeResumeBlocksComposer("prime-agent", settled)).toBe(false);
  });

  // A fork publishes no resume state for *this* thread, so the caller settles
  // the pending marker when the fork command resolves; the marker still exists
  // while the command runs so one click cannot fork twice.
  it("waits on the fork command, not on a resume state that never comes", () => {
    const refused = primeResumeReduce(model(), {
      type: "state",
      state: { status: "unavailable", reason: "conflict" },
    });
    const forked = primeResumeReduce(refused, { type: "choice", intent: { kind: "fork" } });
    expect(primeResumeAwaitingChoice(forked)).toBe(true);
    const settled = primeResumeReduce(forked, { type: "settled" });
    expect(primeResumeAwaitingChoice(settled)).toBe(false);
    expect(primeResumeSurface("prime-agent", settled).kind).toBe("conflict");
  });

  it("keeps the composer shut between a retry and the host's answer", () => {
    const refused = primeResumeReduce(model(), {
      type: "state",
      state: { status: "unavailable", reason: "corrupt" },
    });
    const retrying = primeResumeReduce(refused, { type: "choice", intent: { kind: "retry" } });
    expect(retrying.pending).toEqual({ kind: "retry" });
    expect(primeResumeSurface("prime-agent", retrying).kind).toBe("reconnecting");
    const answered = primeResumeReduce(retrying, {
      type: "state",
      state: { status: "resumed", mode: "relaunched" },
    });
    expect(answered.pending).toBeUndefined();
    expect(primeResumeBlocksComposer("prime-agent", answered)).toBe(false);
  });

  it("stops claiming a session is resumed once this client loses the connection", () => {
    const resumed = primeResumeReduce(model(), {
      type: "state",
      state: { status: "resumed", mode: "adopted" },
    });
    const dropped = primeResumeReduce(resumed, { type: "disconnected" });
    expect(primeResumeSurface("prime-agent", dropped).kind).toBe("reconnecting");
    // A refusal is a fact about durable state and survives a dropped socket.
    const refused = primeResumeReduce(model(), {
      type: "state",
      state: { status: "unavailable", reason: "storageMismatch" },
    });
    expect(primeResumeReduce(refused, { type: "disconnected" })).toEqual(refused);
  });

  it("projects the same lines on every attached client", () => {
    expect(
      renderPrimeResume(
        "prime-agent",
        model({ state: { status: "unavailable", reason: "conflict" } }),
      ),
    ).toEqual([
      "Another writer has this session",
      "Another client is currently the writer for this Prime Agent session. This thread's history is intact and stays read-only until that writer finishes. Nothing here was lost.",
      "Try reconnecting again",
      "Fork into a new thread",
    ]);
  });
});
