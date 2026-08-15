import { describe, expect, it } from "vite-plus/test";
import {
  canUseRuntimeExtension,
  projectRuntimeExtensionState,
} from "./providerRuntimeCapabilities.ts";
describe("provider runtime capability guard", () => {
  it("treats missing capability declarations as unsupported", () =>
    expect(canUseRuntimeExtension(undefined, "goals")).toBe(false));
  it("projects no invented state", () =>
    expect(projectRuntimeExtensionState(undefined)).toEqual({ capabilities: {} }));
  it("only enables an explicit independent flag", () => {
    expect(canUseRuntimeExtension({ goals: true }, "goals")).toBe(true);
    expect(canUseRuntimeExtension({ goals: true }, "tasks")).toBe(false);
  });
});
