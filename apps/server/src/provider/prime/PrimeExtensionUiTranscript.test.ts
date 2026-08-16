import { describe, expect, it } from "vite-plus/test";
// @ts-expect-error -- the review artifact is plain ESM with no type declarations.
import * as transcript from "../../../../../packages/contracts/fixtures/pa-a05-prime-extension-ui-transcript.mjs";
import { applyPrimeNotice, primeRequestTimeoutMs } from "./PrimeExtensionUi.ts";

/**
 * The PA-A05 review artifact is only evidence while it *executes* the shipped
 * mapper and the shipped client projection. These tests keep it wired to the
 * real implementations instead of a copy that could pass against a broken one.
 */
describe("pa-a05 review artifact", () => {
  it("passes end to end", () => {
    expect(() => transcript.verifyTranscript()).not.toThrow();
  });

  it("maps through the shipped mapper rather than a copy of it", () => {
    const adversarial = [
      {
        type: "extension_ui_request",
        id: "a",
        method: "setStatus",
        statusKey: "k",
        statusText: "x".repeat(400),
      },
      {
        type: "extension_ui_request",
        id: "b",
        method: "notify",
        message: "boom",
        notifyType: "error",
      },
      {
        type: "extension_ui_request",
        id: "c",
        method: "setWidget",
        widgetKey: "w",
        widgetLines: ["1", "2", "3", "4", "5"],
      },
      { type: "extension_ui_request", id: "d", method: "select", title: "Pick", options: ["one"] },
    ];
    const expected = new Map();
    for (const request of adversarial) {
      if (request.method === "select") continue;
      applyPrimeNotice(expected, request as never);
    }
    expect(transcript.mapNotices(adversarial)).toEqual([...expected.values()]);
    const board = transcript.mapNotices(adversarial);
    expect(board.find((notice: { key: string }) => notice.key === "status:k").text.length).toBe(
      256,
    );
    expect(board.find((notice: { key: string }) => notice.key === "widget:w").lines).toHaveLength(
      4,
    );
  });

  it("clamps native timeouts through the shipped helper", () => {
    expect(primeRequestTimeoutMs(1)).toBe(1_000);
    expect(primeRequestTimeoutMs(0)).toBeUndefined();
    expect(primeRequestTimeoutMs(10 ** 9)).toBe(600_000);
  });
});
