import { describe, expect, it } from "vite-plus/test";
import {
  hasPrimeRuntimeActions,
  primeCancellationCopy,
  renderPrimeQueue,
  resolvePrimeSend,
} from "./primeQueue";
describe("prime queue", () => {
  it("requires explicit choice and capability", () => {
    expect(resolvePrimeSend("prime-agent", null, { steer: true }, 0).ok).toBe(false);
    expect(resolvePrimeSend("prime-agent", "steer", {}, 0).ok).toBe(false);
  });

  it("recognizes only actionable PA-A02 capabilities", () => {
    expect(hasPrimeRuntimeActions(undefined, undefined)).toBe(false);
    expect(hasPrimeRuntimeActions("prime-agent", {})).toBe(false);
    expect(hasPrimeRuntimeActions("prime-agent", { followUpCancel: true })).toBe(false);
    expect(hasPrimeRuntimeActions("prime-agent", { steer: true })).toBe(true);
    expect(hasPrimeRuntimeActions("prime-agent", { followUps: true })).toBe(true);
  });
  it("blocks attachments", () =>
    expect(resolvePrimeSend("prime-agent", "steer", { steer: true }, 1).ok).toBe(false));
  it("orders authoritative steering then follow ups without ids or cancel", () =>
    expect(renderPrimeQueue({ steering: ["a"], followUps: ["b"] })).toEqual([
      "Steering: a",
      "Queued: b",
    ]));
  it("renders the runtime-reported active action ahead of the queue", () => {
    expect(
      renderPrimeQueue({ steering: ["a"], followUps: ["b"], active: { label: "running now" } }),
    ).toEqual(["Active: running now", "Steering: a", "Queued: b"]);
    // An active entry without a label carries nothing truthful to display.
    expect(renderPrimeQueue({ steering: [], followUps: [], active: {} })).toEqual([]);
  });
  it("derives cancellation copy from the negotiated capability", () => {
    expect(primeCancellationCopy({ followUps: true })).toContain("cannot be cancelled");
    expect(primeCancellationCopy(undefined)).toContain("cannot be cancelled");
    expect(primeCancellationCopy({ followUps: true, followUpCancel: true })).toContain(
      "can be cancelled individually",
    );
  });
});
