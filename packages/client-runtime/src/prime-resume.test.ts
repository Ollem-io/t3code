import { describe, expect, it } from "vite-plus/test";

import {
  PRIME_RESUME_ARCHIVE_NOTE,
  PRIME_RESUME_FRESH_CONFIRM,
  PRIME_RESUME_STOP_NOTE,
  initialPrimeResumeModel,
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
      // Retry only: fighting the authoritative writer with a fresh session is
      // precisely the two-writer outcome PA-B03 exists to prevent.
      expect(surface.choices.map((choice) => choice.kind)).toEqual(["retry"]);
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
    // No cursor was proven bad here, so the fresh start does not discard one.
    expect(primeResumeIntentFor(stalled, "fresh")).toEqual({ kind: "fresh", discardCursor: false });
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
    ]);
  });
});
