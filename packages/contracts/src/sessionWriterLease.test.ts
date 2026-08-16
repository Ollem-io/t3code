import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  SESSION_WRITER_RETRYABLE_REASONS,
  SessionWriterConflictReceipt,
  findSessionWriterReceiptViolation,
  isRetryableSessionWriterConflictReason,
  sessionWriterConflictReceiptFromUnknown,
} from "./sessionWriterLease.ts";

const receipt = (overrides: Record<string, unknown> = {}) => ({
  kind: "sessionWriterConflict",
  provider: "prime-agent",
  operation: "send",
  scopeDigest: "0123456789ab",
  reason: "heldByAnotherWriter",
  retryable: true,
  occurredAt: "2026-08-16T00:00:00.000Z",
  ...overrides,
});

describe("sessionWriterLease", () => {
  it("decodes a well-formed receipt and rejects anything else without throwing", () => {
    assert.deepStrictEqual(sessionWriterConflictReceiptFromUnknown(receipt()), receipt());
    for (const bad of [
      undefined,
      null,
      42,
      "conflict",
      receipt({ reason: "becauseISaidSo" }),
      receipt({ kind: "somethingElse" }),
      receipt({ scopeDigest: "" }),
    ]) {
      assert.equal(sessionWriterConflictReceiptFromUnknown(bad), undefined);
    }
  });

  it("marks every reason except unauthorized as retryable", () => {
    assert.equal(isRetryableSessionWriterConflictReason("unauthorized"), false);
    for (const reason of SESSION_WRITER_RETRYABLE_REASONS) {
      assert.equal(isRetryableSessionWriterConflictReason(reason), true);
    }
  });

  it("refuses owner identity, content and host paths inside a receipt", () => {
    assert.equal(findSessionWriterReceiptViolation(receipt()), undefined);
    for (const [key, value] of [
      ["holderToken", "pw-abc"],
      ["owner", "session-a"],
      ["generation", 3],
      ["prompt", "hello"],
      ["sessionId", "s-1"],
    ] as const) {
      assert.equal(findSessionWriterReceiptViolation({ ...receipt(), [key]: value }), key);
    }
    assert.equal(
      findSessionWriterReceiptViolation({ ...receipt(), operation: "/Users/dev/project" }),
      "operation.<host-path>",
    );
  });

  it("keeps the wire schema strict about the closed reason set", () => {
    const decode = Schema.decodeUnknownSync(SessionWriterConflictReceipt);
    assert.equal(decode(receipt()).retryable, true);
    assert.throws(() => decode(receipt({ reason: "banned" })));
  });
});
