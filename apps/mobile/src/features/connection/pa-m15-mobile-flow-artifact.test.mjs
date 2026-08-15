import { describe, expect, it } from "vite-plus/test";
import { existsSync } from "node:fs";
import { mobileFlowArtifact } from "./pa-m15-mobile-flow-artifact.mjs";
describe("PA-M15 review artifact", () => {
  it("mirrors actual production entry, components, presentation, and proof", () => {
    for (const path of [
      mobileFlowArtifact.entry,
      ...mobileFlowArtifact.components,
      ...mobileFlowArtifact.presentation,
      ...mobileFlowArtifact.proof,
    ])
      expect(existsSync(path)).toBe(true);
  });
});
