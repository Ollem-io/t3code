import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  PRIME_COMMAND_ORIGIN,
  appendPrimeCommandToDraft,
  hasPrimeCommandSurface,
  primeCommandOriginLabel,
  primeCommandPrompt,
  resolvePrimeCommandInvocation,
  searchPrimeCommands,
  type PrimeCommandEntry,
} from "./primeCommands";

const commands: ReadonlyArray<PrimeCommandEntry> = [
  { name: "review", kind: "prompt", source: "project", description: "Review the diff" },
  { name: "deploy", kind: "skill", source: "user", location: "deploy.md" },
];

describe("prime command sheet", () => {
  it("is hidden unless prime-agent advertises discovery", () => {
    expect(hasPrimeCommandSurface(null, { commandDiscovery: true })).toBe(false);
    expect(hasPrimeCommandSurface("prime-agent", undefined)).toBe(false);
    expect(hasPrimeCommandSurface("prime-agent", { commandDiscovery: true })).toBe(true);
  });

  it("states the Prime origin on every entry", () => {
    expect(primeCommandOriginLabel(commands[0]!)).toContain(PRIME_COMMAND_ORIGIN);
    expect(primeCommandOriginLabel(commands[1]!)).toBe("Prime user skill · deploy.md");
  });

  it("filters the in-memory catalog instead of asking the host", () => {
    expect(searchPrimeCommands(commands, "dep").map((entry) => entry.name)).toEqual(["deploy"]);
    expect(searchPrimeCommands([], "dep")).toEqual([]);
  });

  it("resolves an invocation to an ordinary prompt", () => {
    expect(resolvePrimeCommandInvocation(commands, "deploy")).toEqual({
      ok: true,
      prompt: "/deploy",
    });
    expect(resolvePrimeCommandInvocation(commands, "deploy", "staging")).toEqual({
      ok: true,
      prompt: "/deploy staging",
    });
    expect(primeCommandPrompt("deploy", "   ")).toBe("/deploy");
  });

  it("fails actionably for a command the runtime no longer offers", () => {
    expect(resolvePrimeCommandInvocation(commands, "gone")).toEqual({
      ok: false,
      reason: "/gone is no longer offered by this runtime.",
    });
    expect(resolvePrimeCommandInvocation(undefined, "gone").ok).toBe(false);
  });

  // PA-A04 round-3 blocker regression: the sheet used to resolve against the
  // array its rows were rendered from, which can never miss. It now reads the
  // live catalog ref, so a command dropped by a refresh fails with a reason.
  it("resolves against the newest catalog rather than the rendered rows", () => {
    const rendered = commands;
    const live = { current: [commands[1]!] as ReadonlyArray<PrimeCommandEntry> };
    expect(rendered.map((entry) => entry.name)).toContain("review");
    expect(resolvePrimeCommandInvocation(live.current, "review")).toEqual({
      ok: false,
      reason: "/review is no longer offered by this runtime.",
    });
    expect(resolvePrimeCommandInvocation(live.current, "deploy").ok).toBe(true);
  });

  // PA-A04 round-3: picking a command used to replace the whole draft.
  it("appends the invocation to the draft the user already typed", () => {
    expect(appendPrimeCommandToDraft("please be careful with", "/review")).toBe(
      "please be careful with /review",
    );
    expect(appendPrimeCommandToDraft("", "/review")).toBe("/review");
    expect(appendPrimeCommandToDraft("draft   ", "/review")).toBe("draft /review");
  });

  it("never carries a host path, because the catalog cannot express one", () => {
    // Locations are bare file names by contract; the sheet renders them as-is,
    // so this asserts the surface has no path-shaped copy of its own.
    expect(JSON.stringify(commands.map(primeCommandOriginLabel))).not.toContain("/Users/");
  });

  it("keeps the web and mobile copies byte-identical", () => {
    const readSource = (relative: string) =>
      readFileSync(new URL(relative, import.meta.url), "utf8");
    expect(readSource("../../../../web/src/components/chat/primeCommands.ts")).toBe(
      readSource("../../../../mobile/src/features/threads/primeCommands.ts"),
    );
  });
});
