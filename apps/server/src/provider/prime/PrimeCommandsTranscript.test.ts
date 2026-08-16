import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error -- the review artifact is plain ESM with no type declarations.
import * as transcript from "../../../../../packages/contracts/fixtures/pa-a04-prime-commands-transcript.mjs";
import { normalizePrimeCommands } from "./PrimeCommands.ts";

/**
 * The PA-A04 review artifact is only evidence while it *executes* the shipped
 * mapper. It used to mirror it, which let it pass against a leaking mapper; these
 * tests keep it wired to the real implementation.
 */
describe("pa-a04 review artifact", () => {
  it("passes end to end", () => {
    expect(() => transcript.verifyTranscript()).not.toThrow();
  });

  it("maps through the shipped normalizer rather than a copy of it", () => {
    const adversarial = {
      commands: [
        { name: "descleak", description: "Edit /Users/someone/secret/config.toml to configure" },
        { name: "abs", location: "/Users/someone/.prime/commands/deploy.md" },
        { name: "new_session" },
        { name: "theme", tuiOnly: true },
        { name: "/Review", kind: "prompt", source: "project", location: "prompts/review.md" },
      ],
    };
    expect(transcript.mapCommands(adversarial)).toEqual(normalizePrimeCommands(adversarial));
    const serialized = JSON.stringify(transcript.mapCommands(adversarial));
    expect(serialized).not.toContain("/Users/");
  });

  it("resolves invocations through the shipped client resolver", () => {
    const catalog = transcript.mapCommands({ commands: [{ name: "review" }] });
    expect(transcript.invoke(catalog, "review", "  the auth diff  ")).toEqual({
      ok: true,
      prompt: "/review the auth diff",
    });
    // The stale-command copy states only what is true: there is no client-side
    // refresh affordance, so it must not tell the user to reopen anything.
    const stale = transcript.invoke({ commands: [] }, "review");
    expect(stale).toEqual({ ok: false, reason: "/review is no longer offered by this runtime." });
  });
});
