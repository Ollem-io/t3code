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
import { derivePendingUserInputs } from "../../lib/threadActivity";

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

  // Blocker regression: a cancelled dialog closes on mobile too, and the row
  // the server sends for it states the cancellation instead of an answer.
  it("drops the pending dialog when the runtime cancels it", () => {
    const activities = [
      {
        id: "evt-requested",
        kind: "user-input.requested",
        summary: "User input requested",
        tone: "info",
        createdAt: "2026-01-01T00:00:00.000Z",
        turnId: null,
        payload: {
          requestId: "req-1",
          questions: [{ id: "q", header: "Q", question: "Which?", options: [{ label: "one" }] }],
        },
      },
      {
        id: "evt-cancelled",
        kind: "user-input.resolved",
        summary: "User input cancelled",
        tone: "info",
        createdAt: "2026-01-01T00:00:01.000Z",
        turnId: null,
        payload: { requestId: "req-1", answers: {}, cancelled: true },
      },
    ] as unknown as Parameters<typeof derivePendingUserInputs>[0];
    expect(derivePendingUserInputs(activities)).toEqual([]);
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

  // Product review: the dialog copy is about a dialog. With none pending it was
  // permanent composer clutter on mobile while web gated it on the count, so
  // mobile now states the same count and gates on it the same way.
  it("states the pending dialog count and shows the copy only with one pending", () => {
    expect(composer).toContain("renderPrimeDialogStatus(props.pendingDialogCount ?? 0)");
    expect(composer).toContain("{primeDialogStatus ? (");
    const detail = readFileSync(new URL("./ThreadDetailScreen.tsx", import.meta.url), "utf8");
    expect(detail).toContain("pendingDialogCount={props.activePendingUserInput ? 1 : 0}");
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
