// @effect-diagnostics nodeBuiltinImport:off
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  MAX_PRIME_SESSION_NAME_CHARS,
  PRIME_FORK_NOT_RESUME_NOTE,
  PRIME_FORK_TRUNCATED_NOTE,
  PRIME_FORK_OPEN_SOURCE_LABEL,
  PRIME_NAMING_UNAVAILABLE,
  hasLivePrimeSession,
  hasPrimeNaming,
  primeForkDraftDecision,
  primeIdentityView,
  primeRenameDraftDecision,
  renderPrimeForkOrigin,
  renderPrimeIdentityCard,
  type PrimeSessionIdentityCard,
} from "./primeFork";
import { PrimeForkPanel } from "./PrimeForkPanel";
import { PrimeForkOriginBanner } from "./PrimeForkOriginBanner";

const card: PrimeSessionIdentityCard = {
  name: "Migration work",
  forkPoints: [
    { forkPointId: "msg-1", label: "Start the adapter", role: "user", index: 0 },
    { forkPointId: "msg-2", label: "Adapter drafted", role: "assistant", index: 1 },
  ],
};
const live = { status: "running" };
const capabilities = { namingAndForking: true };

describe("prime session naming and forking surface", () => {
  it("is unavailable without prime-agent or the negotiated capability", () => {
    expect(hasPrimeNaming("codex", capabilities)).toBe(false);
    expect(hasPrimeNaming("prime-agent", {})).toBe(false);
    expect(hasPrimeNaming("prime-agent", capabilities)).toBe(true);
    expect(primeIdentityView("prime-agent", {}, card, live)).toEqual({
      kind: "unavailable",
      reason: PRIME_NAMING_UNAVAILABLE,
    });
  });

  // Crash-restart regression shape: a stopped session can keep its last card,
  // and forking a session inside a dead process can never succeed.
  it("shows nothing for a session that is not live", () => {
    expect(hasLivePrimeSession({ status: "stopped" })).toBe(false);
    expect(primeIdentityView("prime-agent", capabilities, card, { status: "stopped" })).toEqual({
      kind: "hidden",
    });
  });

  it("projects the same lines every client derives from one snapshot", () => {
    expect(renderPrimeIdentityCard(card, live)).toEqual([
      "Session name: Migration work",
      "You: Start the adapter",
      "Prime Agent: Adapter drafted",
    ]);
    expect(renderPrimeIdentityCard({ ...card, truncated: true }, live).at(-1)).toBe(
      PRIME_FORK_TRUNCATED_NOTE,
    );
  });

  it("refuses a rename the host would refuse, where it is typed", () => {
    expect(primeRenameDraftDecision(card, live, capabilities, "  Review pass  ")).toEqual({
      canRename: true,
      name: "Review pass",
    });
    expect(primeRenameDraftDecision(card, live, capabilities, "   ").canRename).toBe(false);
    expect(primeRenameDraftDecision(card, live, capabilities, "Migration work")).toEqual({
      canRename: false,
      reason: "This session already has that name.",
    });
    expect(
      primeRenameDraftDecision(
        card,
        live,
        capabilities,
        "x".repeat(MAX_PRIME_SESSION_NAME_CHARS + 1),
      ),
    ).toEqual({
      canRename: false,
      reason: `Keep the session name to ${MAX_PRIME_SESSION_NAME_CHARS} characters or fewer.`,
    });
  });

  it("discloses that a fork is not resume, and refuses a point this page never offered", () => {
    expect(primeForkDraftDecision(card, live, capabilities, "msg-2")).toEqual({
      canFork: true,
      disclosure: PRIME_FORK_NOT_RESUME_NOTE,
    });
    // The whole-session choice always exists, so "fork from here" is never the
    // only way out.
    expect(primeForkDraftDecision(card, live, capabilities, undefined).canFork).toBe(true);
    expect(primeForkDraftDecision(card, live, capabilities, "msg-gone")).toEqual({
      canFork: false,
      reason: "This session no longer offers that fork point.",
    });
    expect(primeForkDraftDecision(card, { status: "stopped" }, capabilities, undefined)).toEqual({
      canFork: false,
      reason: "Start a Prime Agent session before forking it.",
    });
  });

  it("states ancestry from the thread record, so a fork stays traceable without Prime", () => {
    expect(
      renderPrimeForkOrigin({
        threadId: "thread-1",
        forkPointLabel: "Adapter drafted",
        checkpointId: "checkpoint-9",
        forkedAt: "2026-08-16T09:00:00.000Z",
      }),
    ).toBe(
      'Forked from another thread at "Adapter drafted" · source thread\'s latest checkpoint checkpoint-9',
    );
    expect(renderPrimeForkOrigin(null)).toBe("");
  });

  // Regression: the ancestry renderer once shipped with no product caller, so a
  // forked thread showed no origin and offered no way back. The banner renders
  // it, and it hangs off the thread rather than the Prime Agent panel so it
  // survives a dead session and an uninstalled provider.
  it("renders ancestry and the way back on a forked thread", () => {
    const markup = renderToStaticMarkup(
      <PrimeForkOriginBanner
        origin={{
          threadId: "thread-1",
          forkPointLabel: "Adapter drafted",
          checkpointId: "checkpoint-9",
          forkedAt: "2026-08-16T09:00:00.000Z",
        }}
        onOpenSourceThread={() => {}}
      />,
    );
    expect(markup).toContain("Adapter drafted");
    expect(markup).toContain("checkpoint-9");
    expect(markup).toContain(PRIME_FORK_OPEN_SOURCE_LABEL);
    expect(
      renderToStaticMarkup(<PrimeForkOriginBanner origin={null} onOpenSourceThread={() => {}} />),
    ).toBe("");
  });

  it("mounts the ancestry banner on the thread, outside the Prime Agent panel", () => {
    const chatView = readFileSync("apps/web/src/components/ChatView.tsx", "utf8");
    expect(chatView).toContain("<PrimeForkOriginBanner");
    expect(chatView).toContain("origin={activeThread.forkedFrom ?? null}");
    // The way back is plain thread navigation, so it needs no live session.
    expect(chatView).toContain("onOpenSourceThread={(sourceThreadId) => {");
  });

  it("renders the name, the fork points, and no disclosure until a fork is requested", () => {
    const markup = renderToStaticMarkup(
      <PrimeForkPanel
        providerName="prime-agent"
        capabilities={capabilities}
        card={card}
        session={live}
        onRenameSession={() => {}}
        onForkSession={() => {}}
      />,
    );
    expect(markup).toContain("Session name: Migration work");
    expect(markup).toContain("You: Start the adapter");
    expect(markup).toContain("Rename session");
    expect(markup).toContain("Fork session");
    expect(markup).toContain("Whole session");
    // The disclosure is a deliberate second step, so it is not on screen until
    // a fork is actually requested.
    expect(markup).not.toContain(PRIME_FORK_NOT_RESUME_NOTE);
  });

  it("explains an older runtime instead of rendering nothing", () => {
    const markup = renderToStaticMarkup(
      <PrimeForkPanel
        providerName="prime-agent"
        capabilities={{}}
        card={card}
        session={live}
        onRenameSession={() => {}}
        onForkSession={() => {}}
      />,
    );
    expect(markup).toContain(PRIME_NAMING_UNAVAILABLE);
    expect(markup).not.toContain("Start the adapter");
  });

  it("renders nothing for another provider or a dead session", () => {
    for (const props of [
      { providerName: "codex", capabilities, session: live },
      { providerName: "prime-agent", capabilities, session: { status: "stopped" } },
    ]) {
      expect(
        renderToStaticMarkup(
          <PrimeForkPanel
            card={card}
            onRenameSession={() => {}}
            onForkSession={() => {}}
            {...props}
          />,
        ),
      ).toBe("");
    }
  });

  it("keeps the mobile twin byte-identical", () => {
    expect(readFileSync("apps/mobile/src/features/threads/primeFork.ts", "utf8")).toBe(
      readFileSync("apps/web/src/components/chat/primeFork.ts", "utf8"),
    );
  });
});
