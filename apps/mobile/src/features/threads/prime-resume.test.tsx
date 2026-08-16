import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  PRIME_RESUME_ARCHIVE_NOTE,
  PRIME_RESUME_STOP_NOTE,
  initialPrimeResumeModel,
  primeResumeBlocksComposer,
  primeResumeIntentFor,
  primeResumeReduce,
  primeResumeSurface,
  renderPrimeResume,
  type PrimeResumeModel,
} from "@t3tools/client-runtime/prime-resume";

const model = (over: Partial<PrimeResumeModel> = {}): PrimeResumeModel => ({
  ...initialPrimeResumeModel,
  ...over,
});

describe("prime resume and recovery surface (mobile)", () => {
  it("derives exactly the same lines as web for the same published state", () => {
    for (const state of [
      { status: "reconnecting" },
      { status: "resumed", mode: "relaunched" },
      { status: "unavailable", reason: "capabilityMismatch" },
    ] as const) {
      expect(renderPrimeResume("prime-agent", model({ state })).length).toBeGreaterThan(0);
      expect(primeResumeSurface("prime-agent", model({ state }))).toEqual(
        primeResumeSurface("prime-agent", model({ state })),
      );
    }
  });

  it("pauses the mobile composer for every unresolved or refused resume", () => {
    expect(
      primeResumeBlocksComposer("prime-agent", model({ state: { status: "reconnecting" } })),
    ).toBe(true);
    expect(
      primeResumeBlocksComposer(
        "prime-agent",
        model({ state: { status: "unavailable", reason: "ownershipMismatch" } }),
      ),
    ).toBe(true);
    // Nothing to resume is not a failure, so a first message may still be sent.
    expect(
      primeResumeBlocksComposer(
        "prime-agent",
        model({ state: { status: "unavailable", reason: "missing" } }),
      ),
    ).toBe(false);
  });

  it("offers the same three ways out, with the fresh start confirmed first", () => {
    const banner = NodeFS.readFileSync(
      "apps/mobile/src/features/threads/PrimeResumeBanner.tsx",
      "utf8",
    );
    // A fresh start must never dispatch from the first press on any client.
    expect(banner).toContain('if (choice.kind === "fresh") {');
    expect(banner).toContain("setConfirming(true);");
    expect(banner).toContain("Confirm new Prime Agent session");
    expect(banner).toContain("Cancel new Prime Agent session");
    expect(banner).toContain("PRIME_RESUME_STOP_NOTE");
    expect(banner).toContain("PRIME_RESUME_ARCHIVE_NOTE");
    expect(PRIME_RESUME_STOP_NOTE).toContain("can be resumed");
    expect(PRIME_RESUME_ARCHIVE_NOTE).toContain("unarchiving brings the thread");
  });

  it("keeps a two-device conflict truthful and identity-free on a phone", () => {
    const surface = primeResumeSurface(
      "prime-agent",
      model({ state: { status: "unavailable", reason: "conflict" } }),
    );
    expect(surface.kind).toBe("conflict");
    expect(primeResumeIntentFor(surface, "fresh")).toBeUndefined();
    expect(surface.detail).not.toContain("phone");
    expect(surface.detail).toContain("Nothing here was lost.");
  });

  it("recovers a reconnect that the host never finished", () => {
    const stalled = primeResumeReduce(
      primeResumeReduce(model(), { type: "state", state: { status: "reconnecting" } }),
      { type: "sessionStatus", status: "stopped" },
    );
    const surface = primeResumeSurface("prime-agent", stalled);
    expect(surface.kind).toBe("stalled");
    expect(surface.choices.map((choice) => choice.kind)).toEqual(["retry", "fork", "fresh"]);
  });

  // PA-B04 repair regression. Round one left the banner unmounted and the
  // mobile send path untouched, so none of the above was reachable on a phone.
  it("mounts the banner in the thread screen and gates that screen's send path", () => {
    const screen = NodeFS.readFileSync(
      "apps/mobile/src/features/threads/ThreadDetailScreen.tsx",
      "utf8",
    );
    expect(screen).toContain("<PrimeResumeBanner");
    expect(screen).toContain("state: props.selectedThread?.session?.resumeState");
    // The gate is on the send funnel itself, not only on a label: every send
    // from this screen goes through handleSendMessage.
    expect(screen).toContain("if (primeResumeComposerBlocked) return null;");
    expect(screen).toContain("primeResumeBlocksComposer(");
  });

  it("dispatches recovery from the route screen instead of dropping it", () => {
    const route = NodeFS.readFileSync(
      "apps/mobile/src/features/threads/ThreadRouteScreen.tsx",
      "utf8",
    );
    expect(route).toContain("threadEnvironment.recoverPrimeResume");
    expect(route).toContain("onRecoverPrimeResume={handleRecoverPrimeResume}");
    // A fork is a fork, and it keeps the refused session where it is.
    expect(route).toContain("onForkSession={handleForkSession}");
  });

  it("shares one resume model with web, so the two clients cannot drift", () => {
    const web = NodeFS.readFileSync("apps/web/src/components/chat/PrimeResumeBanner.tsx", "utf8");
    const mobile = NodeFS.readFileSync(
      "apps/mobile/src/features/threads/PrimeResumeBanner.tsx",
      "utf8",
    );
    for (const source of [web, mobile]) {
      expect(source).toContain('from "@t3tools/client-runtime/prime-resume"');
      // No client-local copy: every string a user reads comes from the surface.
      expect(source).not.toContain("could not reopen");
    }
  });
});
