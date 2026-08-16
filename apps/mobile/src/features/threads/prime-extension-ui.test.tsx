import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  PRIME_DIALOG_CANCELLED_NOTE,
  PRIME_EDITOR_TEXT_IS_A_SUGGESTION,
  PRIME_NOTICES_ARE_TRANSIENT,
  hasLivePrimeSession,
  hasPrimeExtensionUi,
  primeNoticeFingerprint,
  renderPrimeNotice,
  renderPrimeNotices,
  visiblePrimeNotices,
  type PrimeNotice,
} from "./primeExtensionUi";

const status: PrimeNotice = {
  key: "status:index",
  kind: "status",
  severity: "info",
  text: "Indexing 40%",
};
const widget: PrimeNotice = {
  key: "widget:tips",
  kind: "widget",
  severity: "info",
  text: "one",
  lines: ["one", "two"],
};
const live = { status: "running" };

describe("prime extension UI status (mobile)", () => {
  it("is capability-gated to prime-agent", () => {
    expect(hasPrimeExtensionUi("prime-agent", { interactions: true })).toBe(true);
    expect(hasPrimeExtensionUi("prime-agent", {})).toBe(false);
    expect(hasPrimeExtensionUi("codex", { interactions: true })).toBe(false);
  });

  it("hides everything once the session is no longer live", () => {
    expect(hasLivePrimeSession({ status: "error" })).toBe(false);
    expect(renderPrimeNotices({ notices: [status] }, { status: "stopped" })).toEqual([]);
    expect(renderPrimeNotices({ notices: [status, widget] }, live)).toEqual([
      "Status: Indexing 40%",
      "Widget: one · two",
    ]);
  });

  it("dismisses one exact message, not a key forever", () => {
    const dismissed = new Set([primeNoticeFingerprint(status)]);
    expect(visiblePrimeNotices({ notices: [status] }, live, dismissed)).toEqual([]);
    expect(
      visiblePrimeNotices({ notices: [{ ...status, text: "Indexing 90%" }] }, live, dismissed),
    ).toHaveLength(1);
    expect(renderPrimeNotice({ ...status, severity: "error" })).toBe("Error: Indexing 40%");
  });

  // The two client copies of this module must stay byte-identical; the comment
  // in the source claims exactly that.
  it("keeps the web and mobile copies byte-identical", () => {
    const readSource = (relative: string) =>
      readFileSync(new URL(relative, import.meta.url), "utf8");
    expect(readSource("../../../../web/src/components/chat/primeExtensionUi.ts")).toBe(
      readSource("../../../../mobile/src/features/threads/primeExtensionUi.ts"),
    );
  });
});

/**
 * React Native has no render harness in this suite, so reachability is asserted
 * against the composer source — a dead module is exactly the defect this guards.
 */
describe("prime extension UI wiring", () => {
  const composer = readFileSync(new URL("./ThreadComposer.tsx", import.meta.url), "utf8");

  it("renders the bounded board and its dismiss control from the composer", () => {
    expect(composer).toContain("hasPrimeExtensionUi(");
    expect(composer).toContain("session?.noticeBoard");
    expect(composer).toContain("visiblePrimeNotices(");
    expect(composer).toContain("renderPrimeNotice(notice)");
    expect(composer).toContain("setDismissedPrimeNotices");
    expect(composer).toContain("Dismiss status");
  });

  it("says what the status is and what cancellation means", () => {
    expect(composer).toContain("PRIME_NOTICES_ARE_TRANSIENT");
    expect(composer).toContain("PRIME_EDITOR_TEXT_IS_A_SUGGESTION");
    expect(composer).toContain("PRIME_DIALOG_CANCELLED_NOTE");
    expect(PRIME_NOTICES_ARE_TRANSIENT).toContain("clears when the session ends");
    expect(PRIME_EDITOR_TEXT_IS_A_SUGGESTION).toContain("instead of overwriting");
    expect(PRIME_DIALOG_CANCELLED_NOTE).toContain("without an answer");
  });
});
