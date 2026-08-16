import { assert, describe, it } from "@effect/vitest";
import {
  EMPTY_PRIME_SESSION_IDENTITY,
  MAX_PRIME_FORK_POINT_LABEL,
  MAX_PRIME_FORK_POINTS,
  MAX_PRIME_SESSION_NAME,
  PRIME_FORK_NOT_RESUME_DISCLOSURE,
  primeForkDecision,
  primeForkPoints,
  primeRenameDecision,
  primeSessionIdentity,
  primeSessionIdentityFingerprint,
} from "./PrimeFork.ts";
import type { PrimeRpcForkMessage } from "./PrimeRpcProtocol.ts";

const message = (
  messageId: string,
  role: "user" | "assistant" = "user",
  preview?: string,
): PrimeRpcForkMessage =>
  ({ messageId, role, ...(preview === undefined ? {} : { preview }) }) as PrimeRpcForkMessage;

describe("Prime session identity mapping", () => {
  it("drops unbrandable, oversized, and duplicate ids", () => {
    const { points } = primeForkPoints([
      message("1-leading-digit"),
      message("has.dot"),
      message("x".repeat(129)),
      message("kept", "user", "First"),
      message("kept", "assistant", "Second"),
    ]);
    assert.deepStrictEqual(points, [
      { forkPointId: "kept", label: "First", role: "user", index: 3 },
    ]);
  });

  it("keeps runtime index numbering when an earlier id is dropped", () => {
    const { points } = primeForkPoints([message("bad.id"), message("assistant-2", "assistant")]);
    assert.deepStrictEqual(points, [
      {
        forkPointId: "assistant-2",
        label: "Assistant message 2",
        role: "assistant",
        index: 1,
      },
    ]);
  });

  it("clamps preview labels", () => {
    const point = primeForkPoints([message("m", "user", "x".repeat(400))]).points[0]!;
    assert.equal(point.label.length, MAX_PRIME_FORK_POINT_LABEL);
  });

  it("uses role and position labels for missing or blank previews", () => {
    const { points } = primeForkPoints([message("u", "user"), message("a", "assistant", "  \n  ")]);
    assert.deepStrictEqual(
      points.map((point) => point.label),
      ["User message 1", "Assistant message 2"],
    );
  });

  it("keeps the most recent bounded page and marks earlier choices truncated", () => {
    const identity = primeSessionIdentity({
      messages: Array.from({ length: MAX_PRIME_FORK_POINTS + 3 }, (_unused, index) =>
        message(`m-${index}`),
      ),
    });
    assert.equal(identity.forkPoints.length, MAX_PRIME_FORK_POINTS);
    assert.equal(identity.forkPoints[0]?.forkPointId, "m-3");
    assert.equal(identity.forkPoints.at(-1)?.forkPointId, `m-${MAX_PRIME_FORK_POINTS + 2}`);
    assert.equal(identity.truncated, true);
  });

  it("omits the truncation flag when every choice fits", () => {
    const identity = primeSessionIdentity({ messages: [message("m")] });
    assert.equal("truncated" in identity, false);
  });

  it("bounds names and leaves blank names undefined", () => {
    assert.equal(
      primeSessionIdentity({ name: `  ${"x".repeat(200)}  `, messages: [] }).name?.length,
      MAX_PRIME_SESSION_NAME,
    );
    assert.equal(primeSessionIdentity({ name: " \n ", messages: [] }).name, undefined);
  });

  it("refuses a blank rename", () => {
    assert.deepStrictEqual(primeRenameDecision(" \n "), {
      allowed: false,
      reason: "name-unrepresentable",
    });
  });

  it("refuses a rename that would be clamped", () => {
    assert.deepStrictEqual(primeRenameDecision("x".repeat(MAX_PRIME_SESSION_NAME + 1)), {
      allowed: false,
      reason: "name-unrepresentable",
    });
  });

  it("accepts a rename needing only whitespace trimming", () => {
    assert.deepStrictEqual(primeRenameDecision("  Release session  "), {
      allowed: true,
      name: "Release session",
    });
  });

  it("allows a whole-session clone without a fork-point id", () => {
    assert.deepStrictEqual(primeForkDecision(EMPTY_PRIME_SESSION_IDENTITY, undefined), {
      allowed: true,
    });
  });

  it("refuses an unknown fork-point id", () => {
    const identity = primeSessionIdentity({ messages: [message("known")] });
    assert.deepStrictEqual(primeForkDecision(identity, "unknown"), {
      allowed: false,
      reason: "unknown-fork-point",
    });
  });

  it("refuses a point-specific fork when the identity card is empty", () => {
    assert.deepStrictEqual(primeForkDecision(EMPTY_PRIME_SESSION_IDENTITY, "missing"), {
      allowed: false,
      reason: "no-fork-points",
    });
  });

  it("fingerprints equal cards identically", () => {
    const build = () => primeSessionIdentity({ name: "Named", messages: [message("m")] });
    assert.equal(
      primeSessionIdentityFingerprint(build()),
      primeSessionIdentityFingerprint(build()),
    );
  });

  it("fingerprints different cards differently", () => {
    const first = primeSessionIdentity({ messages: [message("first")] });
    const second = primeSessionIdentity({ messages: [message("second")] });
    assert.notEqual(
      primeSessionIdentityFingerprint(first),
      primeSessionIdentityFingerprint(second),
    );
  });

  it("discloses that a fork is not a resume", () => {
    assert.ok(PRIME_FORK_NOT_RESUME_DISCLOSURE.includes("new Prime Agent session"));
    assert.ok(PRIME_FORK_NOT_RESUME_DISCLOSURE.includes("new T3 thread"));
    assert.ok(PRIME_FORK_NOT_RESUME_DISCLOSURE.includes("original thread is untouched"));
    assert.ok(PRIME_FORK_NOT_RESUME_DISCLOSURE.includes("not durable resume"));
  });
});
