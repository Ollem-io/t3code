import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  findPrimeResumeRedactionViolation,
  PRIME_RESUME_CURSOR_VERSION,
  PrimeResumeCursor,
  type PrimeResumeCursorScope,
  PrimeResumeCursorState,
  primeResumeCursorStateFromUnknown,
  primeResumeScopeKey,
  primeResumeScopeMatches,
  SUPPORTED_PRIME_RESUME_CURSOR_VERSIONS,
} from "./primeResume.ts";

const decodeCursor = Schema.decodeUnknownSync(PrimeResumeCursor);
const decodeState = Schema.decodeUnknownSync(PrimeResumeCursorState);

const asScope = (value: Record<string, string>) => value as unknown as PrimeResumeCursorScope;

const scope = asScope({
  environmentId: "env-a",
  providerInstanceId: "prime",
  projectId: "project-a",
  threadId: "thread-a",
  homeFingerprint: "aaaaaaaaaaaa",
});

const cursorV2 = {
  version: 2,
  scope,
  sessionPathToken: "id-c2Vzc2lvbg",
  ownershipGeneration: 3,
  compatibility: { agentVersion: "0.7.2", band: "compatible" },
  lifecycle: "recorded",
  recordedAt: "2026-08-16T00:00:00.000Z",
  capabilityDigest: "sha256:abc",
} as const;

const cursorV1 = {
  version: 1,
  scope,
  sessionPathToken: "id-c2Vzc2lvbg",
  ownershipGeneration: 3,
  compatibility: { agentVersion: "0.7.2", band: "compatible" },
  lifecycle: "recorded",
  recordedAt: "2026-08-16T00:00:00.000Z",
} as const;

describe("prime resume cursor", () => {
  it("decodes every supported version and reports the newest writer version", () => {
    expect(SUPPORTED_PRIME_RESUME_CURSOR_VERSIONS).toContain(PRIME_RESUME_CURSOR_VERSION);
    for (const cursor of [cursorV1, cursorV2]) {
      expect(decodeCursor(cursor).version).toBe(cursor.version);
    }
  });

  it("cannot confuse cursors across environment, instance, project, thread or home", () => {
    const key = primeResumeScopeKey(scope);
    const variants = [
      asScope({ ...scope, environmentId: "env-b" }),
      asScope({ ...scope, providerInstanceId: "prime-2" }),
      asScope({ ...scope, projectId: "project-b" }),
      asScope({ ...scope, threadId: "thread-b" }),
      asScope({ ...scope, homeFingerprint: "bbbbbbbbbbbb" }),
    ];
    for (const variant of variants) {
      expect(primeResumeScopeKey(variant)).not.toBe(key);
      expect(primeResumeScopeMatches(scope, variant)).toBe(false);
    }
    expect(primeResumeScopeMatches(scope, asScope({ ...scope }))).toBe(true);
  });

  it("cannot be spoofed by shifting separators between identifiers", () => {
    const left = primeResumeScopeKey(
      asScope({ ...scope, environmentId: "a|b", projectId: "project-a" }),
    );
    const right = primeResumeScopeKey(
      asScope({ ...scope, environmentId: "a", projectId: "b|project-a" }),
    );
    expect(left).not.toBe(right);
  });

  it("turns a future version into a readable unavailable state instead of a crash", () => {
    const state = primeResumeCursorStateFromUnknown({
      ...cursorV2,
      version: 99,
      futureOnlyField: { opaque: true },
    });
    expect(state).toEqual({
      status: "unavailable",
      reason: "unsupportedVersion",
      storedVersion: 99,
    });
    expect(decodeState(state)).toEqual(state);
  });

  it("turns corrupt and partial rows into an unavailable state", () => {
    const corrupt: ReadonlyArray<unknown> = [
      undefined,
      null,
      "not-json-object",
      {},
      { version: 2 },
      { ...cursorV2, scope: { ...scope, threadId: "" } },
      { ...cursorV2, ownershipGeneration: -1 },
      { ...cursorV2, compatibility: { agentVersion: "0.7.2", band: "unknown-band" } },
    ];
    for (const value of corrupt) {
      expect(primeResumeCursorStateFromUnknown(value)).toEqual({
        status: "unavailable",
        reason: "corrupt",
      });
    }
  });

  it("reports invalidated lifecycles as unavailable rather than available", () => {
    expect(primeResumeCursorStateFromUnknown({ ...cursorV2, lifecycle: "invalidated" })).toEqual({
      status: "unavailable",
      reason: "invalidated",
    });
    expect(primeResumeCursorStateFromUnknown(cursorV2)).toEqual({
      status: "available",
      cursor: decodeCursor(cursorV2),
    });
  });

  it("rejects transcript, settings and host-path content in a cursor payload", () => {
    expect(findPrimeResumeRedactionViolation(cursorV2)).toBeUndefined();
    expect(findPrimeResumeRedactionViolation({ ...cursorV2, transcript: ["hi"] })).toBe(
      "transcript",
    );
    expect(findPrimeResumeRedactionViolation({ ...cursorV2, settings: {} })).toBe("settings");
    expect(
      findPrimeResumeRedactionViolation({ ...cursorV2, scope: { ...scope, sessionFilePath: "x" } }),
    ).toBe("scope.sessionFilePath");
    expect(findPrimeResumeRedactionViolation({ ...cursorV2, note: "/Users/dev/.t3" })).toBe(
      "note.<host-path>",
    );
    expect(findPrimeResumeRedactionViolation({ ...cursorV2, note: "C:\\Users\\dev" })).toBe(
      "note.<host-path>",
    );
  });
});
