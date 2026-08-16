// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  PRIME_DIALOG_CANCELLED_NOTE,
  PRIME_EDITOR_TEXT_IS_A_SUGGESTION,
  PRIME_NOTICES_ARE_TRANSIENT,
  hasLivePrimeSession,
  hasPrimeExtensionUi,
  primeNoticeFingerprint,
  renderPrimeDialogStatus,
  renderPrimeNotice,
  renderPrimeNotices,
  visiblePrimeNotices,
  type PrimeNotice,
} from "./primeExtensionUi";
import { PrimeExtensionStatus } from "./PrimeExtensionStatus";
import { derivePendingUserInputs, deriveWorkLogEntries } from "../../session-logic";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

const status: PrimeNotice = {
  key: "status:index",
  kind: "status",
  severity: "info",
  text: "Indexing 40%",
};
const error: PrimeNotice = {
  key: "notification:error",
  kind: "notification",
  severity: "error",
  text: "Indexing failed",
};
const widget: PrimeNotice = {
  key: "widget:tips",
  kind: "widget",
  severity: "info",
  text: "one",
  lines: ["one", "two"],
};
const editorText: PrimeNotice = {
  key: "editor-text",
  kind: "editor-text",
  severity: "info",
  text: "npm test",
};
const live = { status: "running" };

describe("prime extension UI status", () => {
  it("is unavailable without prime-agent or the negotiated capability", () => {
    expect(hasPrimeExtensionUi("codex", { interactions: true })).toBe(false);
    expect(hasPrimeExtensionUi("prime-agent", {})).toBe(false);
    expect(hasPrimeExtensionUi("prime-agent", { interactions: true })).toBe(true);
  });

  // Crash-restart regression: a stopped session can keep its last snapshot, and
  // showing a dead extension's status would be a claim nothing can retract.
  it("shows nothing for a session that is not live", () => {
    expect(hasLivePrimeSession({ status: "running" })).toBe(true);
    expect(hasLivePrimeSession({ status: "ready" })).toBe(true);
    expect(hasLivePrimeSession({ status: "stopped" })).toBe(false);
    expect(hasLivePrimeSession(undefined)).toBe(false);
    expect(renderPrimeNotices({ notices: [status] }, { status: "stopped" })).toEqual([]);
    expect(renderPrimeNotices(undefined, live)).toEqual([]);
  });

  it("renders each kind with its own label and no transcript rows", () => {
    expect(renderPrimeNotice(status)).toBe("Status: Indexing 40%");
    expect(renderPrimeNotice(error)).toBe("Error: Indexing failed");
    expect(renderPrimeNotice(widget)).toBe("Widget: one · two");
    expect(renderPrimeNotice({ ...status, severity: "warning" })).toBe("Warning: Indexing 40%");
    expect(renderPrimeNotice({ key: "title", kind: "title", severity: "info", text: "Pass" })).toBe(
      "Agent title: Pass",
    );
    expect(renderPrimeNotice(editorText)).toBe("Suggested composer text: npm test");
  });

  // Dismissal hides one exact message. A replacement is a new message, so the
  // next status line is not silently swallowed by an earlier dismissal.
  it("dismisses one exact message and lets a replacement through", () => {
    const dismissed = new Set([primeNoticeFingerprint(status)]);
    expect(visiblePrimeNotices({ notices: [status] }, live, dismissed)).toEqual([]);
    const replaced = { ...status, text: "Indexing 90%" };
    expect(visiblePrimeNotices({ notices: [replaced] }, live, dismissed)).toEqual([replaced]);
  });

  it("states pending dialog counts and what cancellation means", () => {
    expect(renderPrimeDialogStatus(0)).toBeUndefined();
    expect(renderPrimeDialogStatus(1)).toContain("1 agent request.");
    expect(renderPrimeDialogStatus(3)).toContain("3 agent requests.");
    expect(PRIME_DIALOG_CANCELLED_NOTE).toContain("without an answer");
  });
});

/**
 * Blocker regression: a dialog the runtime closed without an answer used to
 * reach the timeline as "User input submitted". The cancellation is carried on
 * the activity itself, so the surface that renders it says cancelled and shows
 * the runtime's reason — while the pending dialog still disappears.
 */
describe("cancelled dialogs on the timeline", () => {
  const activity = (
    id: string,
    kind: string,
    summary: string,
    payload: Record<string, unknown>,
  ): OrchestrationThreadActivity =>
    ({
      id,
      kind,
      summary,
      tone: "info",
      payload,
      createdAt: "2026-01-01T00:00:00.000Z",
      turnId: null,
    }) as unknown as OrchestrationThreadActivity;

  const activities = [
    activity("evt-requested", "user-input.requested", "User input requested", {
      requestId: "req-1",
      questions: [{ id: "q", header: "Q", question: "Which?", options: [{ label: "one" }] }],
    }),
    activity("evt-cancelled", "user-input.resolved", "User input cancelled", {
      requestId: "req-1",
      answers: {},
      cancelled: true,
      detail: "Prime Agent interactive request timed out after 1000ms.",
    }),
  ];

  it("renders the row as cancelled with its reason and clears the pending dialog", () => {
    expect(derivePendingUserInputs(activities)).toEqual([]);
    const entry = deriveWorkLogEntries(activities).find(
      (candidate) => candidate.sourceActivityKind === "user-input.resolved",
    );
    expect(entry?.label).toBe("User input cancelled");
    expect(entry?.detail).toBe("Prime Agent interactive request timed out after 1000ms.");
  });
});

/**
 * Blocker regression: the helpers above must be reachable from a real rendered
 * surface. A dead module cannot satisfy "fire-and-forget status is bounded and
 * dismissible/replaced".
 */
describe("PrimeExtensionStatus", () => {
  it("renders the live board with a dismiss control per entry", () => {
    const markup = renderToStaticMarkup(
      <PrimeExtensionStatus
        providerName="prime-agent"
        capabilities={{ interactions: true }}
        board={{ notices: [status, error, widget, editorText] }}
        session={live}
        pendingDialogCount={2}
      />,
    );

    expect(markup).toContain('data-testid="prime-extension-status"');
    expect(markup).toContain("Status: Indexing 40%");
    expect(markup).toContain("Error: Indexing failed");
    expect(markup).toContain("Widget: one · two");
    expect(markup).toContain(PRIME_EDITOR_TEXT_IS_A_SUGGESTION);
    // The apostrophe is HTML-escaped in static markup, so match the tail.
    expect(PRIME_NOTICES_ARE_TRANSIENT).toContain("not part of the transcript");
    expect(markup).toContain("not part of the transcript and clears when the session ends.");
    expect(markup).toContain("Waiting for your answer to 2 agent requests.");
    expect(markup.match(/>Dismiss</g)?.length).toBe(4);
  });

  it("renders nothing for a dead session or an incapable runtime", () => {
    expect(
      renderToStaticMarkup(
        <PrimeExtensionStatus
          providerName="prime-agent"
          capabilities={{ interactions: true }}
          board={{ notices: [status] }}
          session={{ status: "stopped" }}
          pendingDialogCount={0}
        />,
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        <PrimeExtensionStatus
          providerName="codex"
          capabilities={undefined}
          board={{ notices: [status] }}
          session={live}
          pendingDialogCount={1}
        />,
      ),
    ).toBe("");
  });

  it("is mounted by the chat surface with the authoritative session snapshot", () => {
    const chatView = readFileSync(new URL("../ChatView.tsx", import.meta.url), "utf8");
    expect(chatView).toContain("<PrimeExtensionStatus");
    expect(chatView).toContain("board={activeThread?.session?.noticeBoard}");
    expect(chatView).toContain("pendingDialogCount={pendingUserInputs.length}");
  });
});
