import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_PRIME_SESSION_NAME_CHARS,
  PRIME_FORK_NOT_RESUME_NOTE,
  PRIME_FORK_TRUNCATED_NOTE,
  PRIME_NAMING_UNAVAILABLE,
  hasLivePrimeSession,
  hasPrimeNaming,
  primeForkDraftDecision,
  primeIdentityView,
  primeRenameDraftDecision,
  renderPrimeIdentityCard,
  type PrimeSessionIdentityCard,
} from "./primeFork";

const card: PrimeSessionIdentityCard = {
  name: "Migration work",
  forkPoints: [
    { forkPointId: "msg-1", label: "Start the adapter", role: "user", index: 0 },
    { forkPointId: "msg-2", label: "Adapter drafted", role: "assistant", index: 1 },
  ],
};
const live = { status: "running" };
const capabilities = { namingAndForking: true };

describe("prime session naming and forking surface (mobile)", () => {
  it("is capability-gated to prime-agent", () => {
    expect(hasPrimeNaming("prime-agent", capabilities)).toBe(true);
    expect(hasPrimeNaming("prime-agent", {})).toBe(false);
    expect(hasPrimeNaming("codex", capabilities)).toBe(false);
    expect(hasLivePrimeSession({ status: "stopped" })).toBe(false);
  });

  it("shows the same card and the same choices as web for the same snapshot", () => {
    expect(primeIdentityView("prime-agent", capabilities, card, live)).toEqual({
      kind: "identity",
      name: card.name,
      forkPoints: card.forkPoints,
      truncated: false,
    });
    expect(renderPrimeIdentityCard(card, live)).toEqual([
      "Session name: Migration work",
      "You: Start the adapter",
      "Prime Agent: Adapter drafted",
    ]);
    expect(renderPrimeIdentityCard({ ...card, truncated: true }, live).at(-1)).toBe(
      PRIME_FORK_TRUNCATED_NOTE,
    );
  });

  it("discloses that a fork is not resume and refuses what the host would refuse", () => {
    expect(primeForkDraftDecision(card, live, capabilities, "msg-2")).toEqual({
      canFork: true,
      disclosure: PRIME_FORK_NOT_RESUME_NOTE,
    });
    expect(primeForkDraftDecision(card, live, capabilities, "msg-gone").canFork).toBe(false);
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

  it("renders the rename control, the fork points, and the confirmation on the composer", () => {
    const composer = readFileSync("apps/mobile/src/features/threads/ThreadComposer.tsx", "utf8");
    expect(composer).toContain('primeIdentitySurface.kind === "unavailable"');
    expect(composer).toContain("{primeIdentitySurface.reason}");
    expect(composer).toContain("primeRenameDraft.canRename");
    expect(composer).toContain("renderPrimeForkPoint(point)");
    // The disclosure is a second, explicit step rather than fine print next to
    // an immediate action, and cancelling it dispatches nothing at all.
    expect(composer).toContain("primeForkDraft.canFork && forkConfirming");
    expect(composer).toContain("{primeForkDraft.disclosure}");
    expect(composer).toContain('accessibilityLabel="Cancel fork"');
  });

  // Regression: ancestry was persisted and contract-exposed but rendered
  // nowhere, so a forked thread had no origin and no way back. It renders on
  // the composer outside the Prime Agent gate, because a thread record has to
  // outlive the session and the provider.
  it("renders thread ancestry and the way back, ungated by Prime Agent", () => {
    const composer = readFileSync("apps/mobile/src/features/threads/ThreadComposer.tsx", "utf8");
    expect(composer).toContain("renderPrimeForkOrigin(props.forkOrigin)");
    expect(composer).toContain("accessibilityLabel={PRIME_FORK_OPEN_SOURCE_LABEL}");
    expect(composer).toContain("props.onOpenSourceThread?.(forkOriginThreadId)");
    // Ancestry is read from the thread, never from the session's identity card.
    expect(composer).toContain("props.forkOrigin?.threadId ?? null");

    const route = readFileSync("apps/mobile/src/features/threads/ThreadRouteScreen.tsx", "utf8");
    expect(route).toContain("forkOrigin={selectedThread.forkedFrom ?? null}");
    expect(route).toContain("onOpenSourceThread={handleOpenSourceThread}");
    expect(route).toContain('navigation.navigate("Thread", {');
  });

  // Two forks in the same millisecond must not collide onto one thread id.
  it("mints forked thread ids from a uuid, never from the clock", () => {
    const route = readFileSync("apps/mobile/src/features/threads/ThreadRouteScreen.tsx", "utf8");
    expect(route).toContain("forkThreadId: ThreadId.make(`fork-${uuidv4()}`)");
    expect(route).not.toContain("fork-${globalThis.crypto?.randomUUID?.() ?? Date.now()}");
  });

  it("keeps an older runtime explained rather than hidden", () => {
    expect(primeIdentityView("prime-agent", {}, card, live)).toEqual({
      kind: "unavailable",
      reason: PRIME_NAMING_UNAVAILABLE,
    });
    expect(primeIdentityView("prime-agent", capabilities, card, { status: "stopped" })).toEqual({
      kind: "hidden",
    });
  });

  it("shares one projection module with web, so the two cannot drift", () => {
    expect(readFileSync("apps/mobile/src/features/threads/primeFork.ts", "utf8")).toBe(
      readFileSync("apps/web/src/components/chat/primeFork.ts", "utf8"),
    );
  });
});
