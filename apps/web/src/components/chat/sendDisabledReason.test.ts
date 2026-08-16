// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { PRIME_RESUME_COMPOSER_BLOCKED_REASON } from "@t3tools/client-runtime/prime-resume";

import { resolveSendDisabledReason } from "./sendDisabledReason";

const source = (path: string) => NodeFS.readFileSync(path, "utf8");

/**
 * PA-B04 repair regression. The first round rendered the sentence "sending is
 * paused" and enforced nothing, so a refused resume could still become a fresh
 * conversation. These pin the enforcement, not the sentence.
 */
describe("composer send gate", () => {
  it("refuses to send while a Prime Agent resume is unresolved", () => {
    expect(
      resolveSendDisabledReason({
        primeResumeBlocked: true,
        threadDetailLoading: false,
        modelSelectionReason: null,
      }),
    ).toBe(PRIME_RESUME_COMPOSER_BLOCKED_REASON);
  });

  it("outranks every other reason, so the resume is what the user is told to fix", () => {
    expect(
      resolveSendDisabledReason({
        primeResumeBlocked: true,
        threadDetailLoading: true,
        modelSelectionReason: "model gone",
      }),
    ).toBe(PRIME_RESUME_COMPOSER_BLOCKED_REASON);
  });

  it("changes nothing when no resume is pending", () => {
    expect(
      resolveSendDisabledReason({
        primeResumeBlocked: false,
        threadDetailLoading: true,
        modelSelectionReason: "model gone",
      }),
    ).toBe("Messages loading");
    expect(
      resolveSendDisabledReason({
        primeResumeBlocked: false,
        threadDetailLoading: false,
        modelSelectionReason: "model gone",
      }),
    ).toBe("model gone");
    expect(
      resolveSendDisabledReason({
        primeResumeBlocked: false,
        threadDetailLoading: false,
        modelSelectionReason: null,
      }),
    ).toBeNull();
  });

  // The gate is only real if the shipped chat view is the thing that uses it,
  // and if the banner explaining the gate is actually mounted next to the
  // composer. Both were the round-one blocker.
  it("is the reason the shipped chat view passes to the composer", () => {
    const chatView = source("apps/web/src/components/ChatView.tsx");
    expect(chatView).toContain("sendDisabledReason={resolveSendDisabledReason({");
    expect(chatView).toContain("primeResumeBlocked: primeResumeComposerBlocked");
    expect(chatView).toContain("<PrimeResumeBanner");
    expect(chatView).toContain("onRecover={onPrimeResumeRecover}");
    expect(chatView).toContain("state: activeThread?.session?.resumeState");
  });
});
