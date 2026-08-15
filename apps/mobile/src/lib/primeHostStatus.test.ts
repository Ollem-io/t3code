import { describe, expect, it } from "vite-plus/test";
import { presentPrimeHostStatus, primeHostPresentationForSelection } from "./primeHostStatus";

describe("Prime host status", () => {
  it("always directs setup to the remote host", () => {
    for (const status of ["auth", "compatibility", "crash"] as const) {
      const presentation = presentPrimeHostStatus(status);
      expect(presentation.detail.toLowerCase()).toContain("host");
      expect(presentation.detail.toLowerCase()).not.toMatch(/phone|api key|local path/);
    }
  });
  it("only presents Prime Agent providers and maps authentication", () => {
    const provider = {
      instanceId: "prime",
      driver: "prime-agent",
      enabled: true,
      installed: true,
      status: "ready",
      availability: "available",
      version: "1",
      auth: { status: "unauthenticated" },
      checkedAt: "2026-01-01T00:00:00Z",
      models: [],
      slashCommands: [],
      skills: [],
    } as const;
    expect(
      primeHostPresentationForSelection({ providers: [provider] } as never, "prime")?.title,
    ).toContain("authentication");
    expect(
      primeHostPresentationForSelection(
        { providers: [{ ...provider, driver: "codex" }] } as never,
        "prime",
      ),
    ).toBeNull();
  });
});
