import { describe, expect, it } from "vite-plus/test";
import { DRIVER_OPTION_BY_VALUE } from "./providerDriverMeta";
describe("Prime Agent provider metadata", () => { it("offers a strict binary-path-only settings form", () => { const prime = DRIVER_OPTION_BY_VALUE["prime-agent"]; expect(prime?.label).toBe("Prime Agent"); expect(Object.keys(prime?.settingsSchema.fields ?? {})).toEqual(["binaryPath"]); expect(Object.keys(prime?.settingsSchema.fields ?? {})).not.toContain("apiKey"); expect(Object.keys(prime?.settingsSchema.fields ?? {})).not.toContain("launchArgs"); }); });
