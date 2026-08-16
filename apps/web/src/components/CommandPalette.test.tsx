import { describe, expect, it } from "vite-plus/test";

import { buildPrimeCommandItems, filterCommandPaletteGroups } from "./CommandPalette.logic";
import {
  appendPrimeCommandToDraft,
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

  // PA-A04 round-3 blocker regression: resolving against the array the item was
  // rendered from could never fail, so a command deleted on the host was
  // inserted as prose. Click time consults the live catalog instead.
  it("fails actionably when the command was removed since the list rendered", async () => {
    const reasons: string[] = [];
    const inserted: string[] = [];
    let live: ReadonlyArray<PrimeCommandEntry> = commands;
    const items = buildPrimeCommandItems({
      providerName: "prime-agent",
      capabilities: { commandDiscovery: true },
      commands,
      getCommands: () => live,
      icon: null,
      insert: (prompt) => inserted.push(prompt),
      onUnavailable: (reason) => reasons.push(reason),
    });
    expect(resolvePrimeCommandInvocation([], "review")).toEqual({
      ok: false,
      reason: "/review is no longer offered by this runtime.",
    });
    // A refresh lands between render and click and drops `review`.
    live = [commands[1]!];
    await items[0]!.run();
    expect(inserted).toEqual([]);
    expect(reasons).toEqual(["/review is no longer offered by this runtime."]);
    // The entry that survived the refresh still invokes normally.
    await items[1]!.run();
    expect(inserted).toEqual(["/deploy"]);
  });

  it("keeps Prime commands visible under the '>' actions filter", () => {
    const primeGroup = {
      value: "prime-commands",
      label: "Prime commands",
      items: buildPrimeCommandItems({
        providerName: "prime-agent",
        capabilities: { commandDiscovery: true },
        commands,
        icon: null,
        insert: () => {},
      }),
    };
    const filtered = filterCommandPaletteGroups({
      activeGroups: [
        { value: "actions", label: "Actions", items: [] },
        { value: "recent-threads", label: "Recent", items: [] },
        primeGroup,
      ],
      query: ">",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });
    expect(filtered.map((group) => group.value)).toEqual(["actions", "prime-commands"]);
  });

  it("appends an invocation to the draft instead of replacing the user's text", () => {
    expect(appendPrimeCommandToDraft("please be careful with", "/review")).toBe(
      "please be careful with /review",
    );
    expect(appendPrimeCommandToDraft("", "/review")).toBe("/review");
    expect(appendPrimeCommandToDraft("draft   ", "/review")).toBe("draft /review");
  });

  // The web/mobile byte-identity of `primeCommands.ts` is asserted by the mobile
  // suite; this package forbids node builtins in tests.
});
