import { describe, expect, it } from "vite-plus/test";
import { hasPrimeRuntimeActions, renderPrimeQueue, resolvePrimeSend } from "./primeQueue";
describe("prime queue", () => {
  it("requires explicit choice and capability", () => {
    expect(resolvePrimeSend(null, { steer: true }, 0).ok).toBe(false);
    expect(resolvePrimeSend("steer", {}, 0).ok).toBe(false);
  });

  it("recognizes only actionable PA-A02 capabilities", () => {
    expect(hasPrimeRuntimeActions(undefined)).toBe(false);
    expect(hasPrimeRuntimeActions({})).toBe(false);
    expect(hasPrimeRuntimeActions({ followUpCancel: true })).toBe(false);
    expect(hasPrimeRuntimeActions({ steer: true })).toBe(true);
    expect(hasPrimeRuntimeActions({ followUps: true })).toBe(true);
  });
  it("blocks attachments", () =>
    expect(resolvePrimeSend("steer", { steer: true }, 1).ok).toBe(false));
  it("orders authoritative steering then follow ups without ids or cancel", () =>
    expect(renderPrimeQueue({ steering: ["a"], followUps: ["b"] })).toEqual([
      "Steering: a",
      "Queued: b",
    ]));
});
