import { describe, expect, it } from "vite-plus/test";
import {
  PRIME_GET_COMMANDS_COMMAND,
  PrimeCommandCache,
  normalizePrimeCommands,
  sanitizePrimeCommandLocation,
} from "./PrimeCommands.ts";

describe("prime command discovery", () => {
  it("uses the exact no-argument native command", () => {
    expect(PRIME_GET_COMMANDS_COMMAND).toEqual({ type: "get_commands" });
  });

  it("maps name, kind, description, source, and location", () => {
    expect(
      normalizePrimeCommands({
        commands: [
          {
            name: "/review",
            kind: "prompt",
            description: "Review the diff",
            source: "project",
            location: ".prime/prompts/review.md",
          },
        ],
      }),
    ).toEqual({
      commands: [
        {
          name: "review",
          kind: "prompt",
          description: "Review the diff",
          source: "project",
          location: "review.md",
        },
      ],
    });
  });

  it("never publishes an absolute or traversing host path", () => {
    expect(
      sanitizePrimeCommandLocation("/Users/someone/.prime/commands/deploy.md"),
    ).toBeUndefined();
    expect(sanitizePrimeCommandLocation("~/.prime/commands/deploy.md")).toBeUndefined();
    expect(sanitizePrimeCommandLocation("../../etc/passwd")).toBeUndefined();
    expect(sanitizePrimeCommandLocation("C:\\Users\\someone\\deploy.md")).toBeUndefined();
    expect(sanitizePrimeCommandLocation("commands/deploy.md")).toBe("deploy.md");
    const catalog = normalizePrimeCommands({
      commands: [{ name: "deploy", location: "/Users/someone/.prime/commands/deploy.md" }],
    });
    expect(catalog.commands[0]).toEqual({ name: "deploy", kind: "command", source: "builtin" });
    expect(JSON.stringify(catalog)).not.toContain("/Users/");
  });

  it("drops TUI-only entries so they can never be offered", () => {
    const catalog = normalizePrimeCommands({
      commands: [
        { name: "theme", tuiOnly: true },
        { name: "picker", surface: "tui" },
        { name: "widget", surfaces: ["tui"] },
        { name: "secret", hidden: true },
        { name: "usable" },
      ],
    });
    expect(catalog.commands.map((entry) => entry.name)).toEqual(["usable"]);
  });

  it("drops session/auth mutating and malformed entries", () => {
    const catalog = normalizePrimeCommands({
      commands: [
        { name: "login" },
        { name: "logout" },
        { name: "exit" },
        { name: "new_session" },
        { name: "has space" },
        { name: "../escape" },
        { name: "" },
        { name: 42 },
        "not-an-object",
        { name: "plan" },
      ],
    });
    expect(catalog.commands.map((entry) => entry.name)).toEqual(["plan"]);
  });

  it("fails closed on an unrecognized body instead of guessing", () => {
    expect(normalizePrimeCommands(undefined)).toEqual({ commands: [] });
    expect(normalizePrimeCommands({ items: [{ name: "plan" }] })).toEqual({ commands: [] });
  });

  it("bounds the catalog and de-duplicates by name, first definition winning", () => {
    const catalog = normalizePrimeCommands({
      commands: [
        { name: "dup", description: "first" },
        { name: "dup", description: "second" },
        ...Array.from({ length: 400 }, (_, index) => ({ name: `cmd-${index}` })),
      ],
    });
    expect(catalog.commands.length).toBe(128);
    expect(catalog.commands.find((entry) => entry.name === "dup")?.description).toBe("first");
  });

  it("publishes once per change and drops byte-identical repeats", () => {
    const cache = new PrimeCommandCache();
    expect(cache.isDiscovered).toBe(false);
    const body = { commands: [{ name: "plan" }] };
    expect(cache.apply(body)?.commands.length).toBe(1);
    expect(cache.isDiscovered).toBe(true);
    expect(cache.apply({ commands: [{ name: "plan" }] })).toBeUndefined();
    expect(cache.apply({ commands: [{ name: "plan" }, { name: "review" }] })?.commands.length).toBe(
      2,
    );
    cache.invalidate();
    expect(cache.isDiscovered).toBe(false);
    // After explicit invalidation the same catalog is published again, so a
    // client that requested a refresh sees an answer.
    expect(cache.apply(body)?.commands.length).toBe(1);
  });
});
