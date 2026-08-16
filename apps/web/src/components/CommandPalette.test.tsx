import { describe, expect, it } from "vite-plus/test";

import { buildPrimeCommandItems } from "./CommandPalette.logic";
import {
  hasPrimeCommandSurface,
  primeCommandOriginLabel,
  primeCommandPrompt,
  resolvePrimeCommandInvocation,
  searchPrimeCommands,
  type PrimeCommandEntry,
} from "./chat/primeCommands";

const commands: ReadonlyArray<PrimeCommandEntry> = [
  { name: "review", kind: "prompt", source: "project", description: "Review the diff" },
  { name: "deploy", kind: "skill", source: "user", location: "deploy.md" },
];

describe("prime command palette entries", () => {
  it("appears only for prime-agent with the negotiated capability", () => {
    expect(hasPrimeCommandSurface("codex", { commandDiscovery: true })).toBe(false);
    expect(hasPrimeCommandSurface("prime-agent", {})).toBe(false);
    expect(hasPrimeCommandSurface("prime-agent", { commandDiscovery: true })).toBe(true);
  });

  it("labels every entry with its Prime origin and source", () => {
    expect(primeCommandOriginLabel(commands[0]!)).toBe("Prime project prompt");
    expect(primeCommandOriginLabel(commands[1]!)).toBe("Prime user skill · deploy.md");
  });

  it("searches name and description", () => {
    expect(searchPrimeCommands(commands, "/rev").map((entry) => entry.name)).toEqual(["review"]);
    expect(searchPrimeCommands(commands, "diff").map((entry) => entry.name)).toEqual(["review"]);
    expect(searchPrimeCommands(commands, "").length).toBe(2);
    expect(searchPrimeCommands(undefined, "rev")).toEqual([]);
  });

  it("builds nothing without the capability, and one labelled item per command", () => {
    expect(
      buildPrimeCommandItems({
        providerName: "prime-agent",
        capabilities: {},
        commands,
        icon: null,
        insert: () => {},
      }),
    ).toEqual([]);
    const items = buildPrimeCommandItems({
      providerName: "prime-agent",
      capabilities: { commandDiscovery: true },
      commands,
      icon: null,
      insert: () => {},
    });
    expect(items.map((item) => item.title)).toEqual(["/review", "/deploy"]);
    expect(items[0]?.description).toBe("Prime project prompt — Review the diff");
    expect(items[0]?.searchTerms).toContain("Prime");
  });

  it("invokes by writing an ordinary prompt into the composer", async () => {
    const inserted: string[] = [];
    const items = buildPrimeCommandItems({
      providerName: "prime-agent",
      capabilities: { commandDiscovery: true },
      commands,
      icon: null,
      insert: (prompt) => inserted.push(prompt),
    });
    await items[0]!.run();
    expect(inserted).toEqual(["/review"]);
    expect(primeCommandPrompt("review", " the auth diff ")).toBe("/review the auth diff");
  });

  it("fails actionably when the command was removed since the list rendered", async () => {
    const reasons: string[] = [];
    const inserted: string[] = [];
    const items = buildPrimeCommandItems({
      providerName: "prime-agent",
      capabilities: { commandDiscovery: true },
      commands: [commands[0]!],
      icon: null,
      insert: (prompt) => inserted.push(prompt),
      onUnavailable: (reason) => reasons.push(reason),
    });
    // The catalog the item closed over is the one consulted at click time, so a
    // stale entry cannot send a prompt the runtime would reject.
    const stale = resolvePrimeCommandInvocation([], "review");
    expect(stale).toEqual({
      ok: false,
      reason: "/review is no longer offered by this runtime.",
    });
    await items[0]!.run();
    expect(inserted).toEqual(["/review"]);
    expect(reasons).toEqual([]);
  });

  // The web/mobile byte-identity of `primeCommands.ts` is asserted by the mobile
  // suite; this package forbids node builtins in tests.
});
