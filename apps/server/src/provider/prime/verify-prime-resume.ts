import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { primeResumeCursorStateFromUnknown, primeResumeScopeKey } from "@t3tools/contracts";
import { migrationManifest } from "../../persistence/Migrations.ts";
import {
  decodePrimeResumeCursor,
  encodePrimeResumeCursor,
  invalidatePrimeResumeCursor,
  makePrimeResumeCursor,
  PRIME_RESUME_FILE_MODE,
  PRIME_RESUME_MAX_BYTES,
  primeResumeCursorFileMode,
  primeResumeCursorPreservedPath,
  primeSessionPathToken,
  readPrimeResumeCursor,
  redactPrimeResumeDiagnostics,
  writePrimeResumeCursor,
} from "./PrimeResumeCursor.ts";
import { primeHomeFingerprint, primeResourceLayout } from "./PrimeResourceLayout.ts";

/**
 * PA-B01 review artifact. Every assertion below runs the checked-in production
 * cursor codec, storage and redaction code. Nothing is mocked, no live state is
 * touched, and the report contains no content and no host path.
 */

let checks = 0;
function check(value: unknown, message: string): asserts value {
  checks++;
  if (!value) throw new Error(message);
}

const report: Array<string> = [];
const line = (text: string) => report.push(text);

const homeA = await mkdtemp(join(tmpdir(), "t3-pa-b01-a-"));
const homeB = await mkdtemp(join(tmpdir(), "t3-pa-b01-b-"));

const layoutFor = (home: string, threadId = "thread-a") =>
  primeResourceLayout({ home, environmentId: "env-a", instanceId: "prime", threadId });

const scopeFor = (home: string, overrides: Record<string, string> = {}) =>
  ({
    environmentId: "env-a",
    providerInstanceId: "prime",
    projectId: "project-a",
    threadId: "thread-a",
    homeFingerprint: primeHomeFingerprint(home),
    ...overrides,
  }) as never;

const cursorFor = (home: string) =>
  makePrimeResumeCursor({
    scope: scopeFor(home),
    sessionPathToken: primeSessionPathToken(home, layoutFor(home).session),
    ownershipGeneration: 4,
    compatibility: { agentVersion: "0.7.2", band: "compatible" },
    capabilityDigest: "sha256:cap",
    recordedAt: "2026-08-16T00:00:00.000Z",
  });

// 1. Encode/decode round trip is deterministic and byte-stable.
const cursorA = cursorFor(homeA);
const encoded = encodePrimeResumeCursor(cursorA);
check(encoded === encodePrimeResumeCursor(cursorA), "encoding must be deterministic");
const roundTrip = decodePrimeResumeCursor(encoded);
check(roundTrip.status === "available", "a freshly written cursor must decode as available");
check(
  JSON.stringify(roundTrip.cursor) === JSON.stringify(cursorA),
  "decoding must reproduce the exact cursor",
);
line(`encode/decode: stable v${cursorA.version} round trip, ${encoded.length} bytes`);

// 2. Version matrix: old, new, future, corrupt, partial.
const matrix: ReadonlyArray<readonly [string, unknown]> = [
  ["v1 (older supported)", { ...cursorA, version: 1, capabilityDigest: undefined }],
  ["v2 (current)", cursorA],
  ["v99 (unknown future)", { ...cursorA, version: 99, futureOnly: { keep: true } }],
  ["partial row", { version: 2 }],
  ["corrupt bytes", "{not json"],
  ["oversized row", { ...cursorA, padding: "x".repeat(PRIME_RESUME_MAX_BYTES) }],
  ["invalidated", { ...cursorA, lifecycle: "invalidated" }],
];
for (const [name, value] of matrix) {
  const text =
    typeof value === "string" ? value : JSON.stringify(JSON.parse(JSON.stringify(value)));
  const state = decodePrimeResumeCursor(text);
  check(
    state.status === "available" ||
      ["corrupt", "unsupportedVersion", "invalidated"].includes(state.reason),
    `${name} must produce a readable state`,
  );
  const expectedAvailable = name.startsWith("v1") || name.startsWith("v2");
  check(
    (state.status === "available") === expectedAvailable,
    `${name} availability must match the version policy`,
  );
  line(
    `version matrix: ${name} -> ${state.status}${
      state.status === "unavailable" ? ` (${state.reason})` : ""
    }`,
  );
}

// 3. Cross-environment and two-home confusion is impossible.
await writePrimeResumeCursor(layoutFor(homeA).resumeCursor, cursorA);
await writePrimeResumeCursor(layoutFor(homeB).resumeCursor, cursorFor(homeB));
const foreign = await readPrimeResumeCursor(layoutFor(homeA).resumeCursor, scopeFor(homeB));
check(
  foreign.state.status === "unavailable" && foreign.state.reason === "scopeMismatch",
  "a cursor from another T3 home must never be adopted",
);
for (const field of ["environmentId", "providerInstanceId", "projectId", "threadId"]) {
  const state = (
    await readPrimeResumeCursor(
      layoutFor(homeA).resumeCursor,
      scopeFor(homeA, { [field]: "other" }),
    )
  ).state;
  check(
    state.status === "unavailable" && state.reason === "scopeMismatch",
    `a cursor with a different ${field} must never be adopted`,
  );
}
check(
  primeResumeScopeKey(scopeFor(homeA)) !== primeResumeScopeKey(scopeFor(homeB)),
  "two T3 homes must produce different scope keys",
);
line(`two homes: independent scope keys, cross-home read -> unavailable (scopeMismatch)`);

// 4. Storage policy: T3-scoped path, restrictive mode, non-destructive replace.
check(
  layoutFor(homeA).resumeCursor.startsWith(join(homeA, "userdata", "prime", "v1")),
  "cursors must live inside the T3 home namespace",
);
check(
  (await primeResumeCursorFileMode(layoutFor(homeA).resumeCursor)) === PRIME_RESUME_FILE_MODE,
  "cursor files must be owner-only",
);
const future = `${JSON.stringify({ ...cursorA, version: 99, futureOnly: { keep: true } })}\n`;
await writeFile(layoutFor(homeA).resumeCursor, future);
const unknownRead = await readPrimeResumeCursor(layoutFor(homeA).resumeCursor, scopeFor(homeA));
check(
  unknownRead.state.status === "unavailable" &&
    unknownRead.state.reason === "unsupportedVersion" &&
    unknownRead.state.storedVersion === 99,
  "an unknown future cursor must be readable as unavailable",
);
await writePrimeResumeCursor(layoutFor(homeA).resumeCursor, cursorA);
check(
  (await readFile(layoutFor(homeA).resumeCursorBackup, "utf8")) === future,
  "a downgrade must preserve the unknown cursor it replaced",
);
// Preservation must survive an unbounded number of downgraded writes, not one:
// a single rolling backup slot would lose the unknown row on the next write.
const preserved = primeResumeCursorPreservedPath(layoutFor(homeA).resumeCursor, 99);
check(
  (await readFile(preserved, "utf8")) === future,
  "the unknown cursor must be preserved in a version-keyed slot",
);
for (let repeat = 0; repeat < 3; repeat++) {
  await writePrimeResumeCursor(layoutFor(homeA).resumeCursor, cursorA);
  check(
    (await readFile(preserved, "utf8")) === future,
    "repeated downgraded writes must never destroy the unknown cursor",
  );
}
check(
  await invalidatePrimeResumeCursor(layoutFor(homeA).resumeCursor),
  "invalidation must succeed on a readable cursor",
);
check(
  (await readFile(preserved, "utf8")) === future,
  "invalidation must never destroy the unknown cursor either",
);
check(
  (await readFile(layoutFor(homeA).resumeCursorBackup, "utf8").catch(() => undefined)) ===
    undefined,
  "invalidation must not leave a still-recorded copy in the rolling backup",
);
check(
  !(await invalidatePrimeResumeCursor(layoutFor(homeA).resumeCursor)),
  "invalidation must be idempotent",
);
line(
  "storage: owner-only T3-scoped file, write-once preservation of unknown versions across repeated downgraded writes, idempotent invalidation",
);

// 5. Redaction: no content, no host path, closed reason codes.
for (const forbidden of [
  { transcript: ["hello"] },
  { settings: { theme: "dark" } },
  { telemetry: { events: 1 } },
  { sessionFilePath: "/Users/dev/.t3" },
]) {
  let threw = false;
  try {
    await writePrimeResumeCursor(layoutFor(homeA, "thread-reject").resumeCursor, {
      ...cursorA,
      ...forbidden,
    } as never);
  } catch {
    threw = true;
  }
  check(threw, `storage must refuse a cursor carrying ${Object.keys(forbidden)[0]}`);
}
const diagnostics = [
  redactPrimeResumeDiagnostics({
    scope: scopeFor(homeA),
    state: { status: "available", cursor: cursorA },
  }),
  redactPrimeResumeDiagnostics({
    scope: scopeFor(homeA),
    state: { status: "unavailable", reason: "unsupportedVersion", storedVersion: 99 },
  }),
];
const serialized = JSON.stringify(diagnostics);
for (const secret of [homeA, homeB, "project-a", "thread-a", "env-a", "userdata"]) {
  check(!serialized.includes(secret), "diagnostics must not carry identifiers or host paths");
}
line(`redaction: diagnostics reduced to ${serialized.length} bytes of digest + status codes`);

// 6. The migration slot that owns this storage is registered exactly once.
const slot = migrationManifest.filter(([, name]) => name === "PrimeResumeCursors");
check(slot.length === 1, "the resume cursor migration must be registered once");
check(slot[0]![0] === 48, "the resume cursor migration must own slot 48");
check(
  primeResumeCursorStateFromUnknown({ version: 48 }).status === "unavailable",
  "an unrelated payload must never look like a cursor",
);
line(`migration: slot ${slot[0]![0]} ${slot[0]![1]} registered once`);

process.stdout.write(`${report.join("\n")}\n`);
process.stdout.write(`PA-B01 resume cursor artifact: ${checks} source-derived assertions passed\n`);
