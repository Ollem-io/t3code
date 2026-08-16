import { assert, describe, it } from "@effect/vitest";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PrimeResumeCursorLatest, PrimeResumeCursorScope } from "@t3tools/contracts";

import {
  decodePrimeResumeCursor,
  encodePrimeResumeCursor,
  invalidatePrimeResumeCursor,
  makePrimeResumeCursor,
  PRIME_RESUME_DIRECTORY_MODE,
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

const home = async (prefix: string) => mkdtemp(join(tmpdir(), prefix));

const layoutFor = (root: string, options?: { readonly threadId?: string }) =>
  primeResourceLayout({
    home: root,
    environmentId: "env-a",
    instanceId: "prime",
    threadId: options?.threadId ?? "thread-a",
  });

const scopeFor = (root: string, overrides?: Partial<PrimeResumeCursorScope>) =>
  ({
    environmentId: "env-a",
    providerInstanceId: "prime",
    projectId: "project-a",
    threadId: "thread-a",
    homeFingerprint: primeHomeFingerprint(root),
    ...overrides,
  }) as PrimeResumeCursorScope;

const cursorFor = (root: string, overrides?: Partial<PrimeResumeCursorLatest>) =>
  ({
    ...makePrimeResumeCursor({
      scope: scopeFor(root),
      sessionPathToken: primeSessionPathToken(root, layoutFor(root).session),
      ownershipGeneration: 4,
      compatibility: { agentVersion: "0.7.2", band: "compatible" },
      capabilityDigest: "sha256:cap",
      recordedAt: "2026-08-16T00:00:00.000Z",
    }),
    ...overrides,
  }) as PrimeResumeCursorLatest;

describe("PrimeResumeCursor", () => {
  it("stores a cursor T3-scoped with restrictive permissions and deterministic bytes", async () => {
    const root = await home("prime-resume-a-");
    const layout = layoutFor(root);
    const cursor = cursorFor(root);

    await writePrimeResumeCursor(layout.resumeCursor, cursor);

    assert.isTrue(layout.resumeCursor.startsWith(join(root, "userdata", "prime", "v1")));
    assert.equal(await primeResumeCursorFileMode(layout.resumeCursor), PRIME_RESUME_FILE_MODE);
    assert.equal(await primeResumeCursorFileMode(layout.thread), PRIME_RESUME_DIRECTORY_MODE);
    assert.equal(
      await readFile(layout.resumeCursor, "utf8"),
      encodePrimeResumeCursor(cursor),
      "encoding is byte-stable",
    );

    const read = await readPrimeResumeCursor(layout.resumeCursor, scopeFor(root));
    assert.deepEqual(read.state, { status: "available", cursor });
  });

  it("never leaks a session path: the token is opaque and home-specific", async () => {
    const one = await home("prime-resume-b-");
    const two = await home("prime-resume-c-");
    const token = primeSessionPathToken(one, layoutFor(one).session);

    assert.match(token, /^spt-[0-9a-f]{32}$/);
    assert.notInclude(token, "userdata");
    assert.equal(token, primeSessionPathToken(one, layoutFor(one).session));
    assert.notEqual(token, primeSessionPathToken(two, layoutFor(two).session));
    assert.notEqual(token, primeSessionPathToken(one, layoutFor(one, { threadId: "b" }).session));
    assert.throws(() => primeSessionPathToken(one, join(one, "escape")));
  });

  it("keeps two T3 homes isolated: a foreign cursor is unavailable, not adopted", async () => {
    const one = await home("prime-resume-d-");
    const two = await home("prime-resume-e-");
    await writePrimeResumeCursor(layoutFor(one).resumeCursor, cursorFor(one));
    await writePrimeResumeCursor(layoutFor(two).resumeCursor, cursorFor(two));

    const crossRead = await readPrimeResumeCursor(layoutFor(one).resumeCursor, scopeFor(two));
    assert.deepEqual(crossRead.state, { status: "unavailable", reason: "scopeMismatch" });

    for (const mismatch of [
      { environmentId: "env-b" },
      { providerInstanceId: "prime-2" },
      { projectId: "project-b" },
      { threadId: "thread-b" },
    ] as unknown as ReadonlyArray<Partial<PrimeResumeCursorScope>>) {
      const state = (
        await readPrimeResumeCursor(layoutFor(one).resumeCursor, scopeFor(one, mismatch))
      ).state;
      assert.deepEqual(state, { status: "unavailable", reason: "scopeMismatch" });
    }
  });

  it("reads corrupt, oversized, partial and future cursors as unavailable, never a crash", async () => {
    const root = await home("prime-resume-f-");
    const layout = layoutFor(root);
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));

    assert.deepEqual(decodePrimeResumeCursor("{not json"), {
      status: "unavailable",
      reason: "corrupt",
    });
    assert.deepEqual(decodePrimeResumeCursor(JSON.stringify({ version: 2 })), {
      status: "unavailable",
      reason: "corrupt",
    });
    assert.deepEqual(decodePrimeResumeCursor(JSON.stringify({ ...cursorFor(root), version: 7 })), {
      status: "unavailable",
      reason: "unsupportedVersion",
      storedVersion: 7,
    });
    assert.deepEqual(
      decodePrimeResumeCursor(
        JSON.stringify({ ...cursorFor(root), padding: "x".repeat(PRIME_RESUME_MAX_BYTES) }),
      ),
      { status: "unavailable", reason: "corrupt" },
    );
    // A cursor that somehow carries content is refused on read as well as write.
    assert.deepEqual(
      decodePrimeResumeCursor(JSON.stringify({ ...cursorFor(root), transcript: ["hello"] })),
      { status: "unavailable", reason: "corrupt" },
    );
    assert.throws(() =>
      makePrimeResumeCursor({
        scope: scopeFor(root),
        sessionPathToken: join(root, "userdata"),
        ownershipGeneration: 1,
        compatibility: { agentVersion: "0.7.2", band: "compatible" },
        capabilityDigest: "sha256:cap",
        recordedAt: "2026-08-16T00:00:00.000Z",
      }),
    );

    const missing = await readPrimeResumeCursor(
      layoutFor(await home("prime-resume-g-")).resumeCursor,
    );
    assert.deepEqual(missing.state, { status: "unavailable", reason: "missing" });
  });

  it("preserves an unknown future cursor byte-for-byte instead of overwriting it blindly", async () => {
    const root = await home("prime-resume-h-");
    const layout = layoutFor(root);
    const future = `${JSON.stringify({ ...cursorFor(root), version: 99, futureField: { a: 1 } })}\n`;
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));
    await writeFile(layout.resumeCursor, future);

    const read = await readPrimeResumeCursor(layout.resumeCursor, scopeFor(root));
    assert.deepEqual(read.state, {
      status: "unavailable",
      reason: "unsupportedVersion",
      storedVersion: 99,
    });
    assert.equal(read.raw, future, "the unknown row is returned verbatim, not reinterpreted");

    // A downgraded build that writes its own cursor must keep the newer one.
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));
    assert.equal(await readFile(layout.resumeCursorBackup, "utf8"), future);
    assert.equal(
      await primeResumeCursorFileMode(layout.resumeCursorBackup),
      PRIME_RESUME_FILE_MODE,
    );
    assert.isFalse(await invalidatePrimeResumeCursor(layout.resumeCursorBackup + ".missing"));
  });

  it("keeps an unknown future cursor across repeated downgraded writes and invalidation", async () => {
    const root = await home("prime-resume-h2-");
    const layout = layoutFor(root);
    const future = `${JSON.stringify({ ...cursorFor(root), version: 99, futureField: { a: 1 } })}\n`;
    const preserved = primeResumeCursorPreservedPath(layout.resumeCursor, 99);
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));
    await writeFile(layout.resumeCursor, future);

    // A downgraded build writing over and over must never reach a state where
    // the future payload exists nowhere on disk.
    for (let attempt = 0; attempt < 5; attempt++) {
      await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));
      assert.equal(await readFile(preserved, "utf8"), future, `write ${attempt} destroyed v99`);
    }
    assert.equal(await primeResumeCursorFileMode(preserved), PRIME_RESUME_FILE_MODE);

    // Invalidation is itself a write; it must not destroy the unknown row either.
    assert.isTrue(await invalidatePrimeResumeCursor(layout.resumeCursor));
    assert.equal(await readFile(preserved, "utf8"), future);
    // ...and it must not leave a still-`recorded` copy behind in the rolling slot.
    assert.isFalse(
      await access(layout.resumeCursorBackup).then(
        () => true,
        () => false,
      ),
    );

    // A second, different unknown version gets its own slot rather than
    // overwriting the first one.
    const otherFuture = `${JSON.stringify({ ...cursorFor(root), version: 100 })}\n`;
    await writeFile(layout.resumeCursor, otherFuture);
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));
    assert.equal(await readFile(preserved, "utf8"), future);
    assert.equal(
      await readFile(primeResumeCursorPreservedPath(layout.resumeCursor, 100), "utf8"),
      otherFuture,
    );
  });

  it("does not collide when two writes to one cursor overlap in a single process", async () => {
    const root = await home("prime-resume-h3-");
    const layout = layoutFor(root);
    const cursor = cursorFor(root);

    await Promise.all([
      writePrimeResumeCursor(layout.resumeCursor, cursor),
      writePrimeResumeCursor(layout.resumeCursor, cursor),
      writePrimeResumeCursor(layout.resumeCursor, cursor),
    ]);

    assert.equal(await readFile(layout.resumeCursor, "utf8"), encodePrimeResumeCursor(cursor));
  });

  it("invalidates without deleting, and stays idempotent", async () => {
    const root = await home("prime-resume-i-");
    const layout = layoutFor(root);
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));

    assert.isTrue(await invalidatePrimeResumeCursor(layout.resumeCursor));
    const read = await readPrimeResumeCursor(layout.resumeCursor, scopeFor(root));
    assert.deepEqual(read.state, { status: "unavailable", reason: "invalidated" });
    assert.isFalse(await invalidatePrimeResumeCursor(layout.resumeCursor));
    assert.include(read.raw ?? "", "invalidated");
  });

  it("redacts diagnostics down to a digest, a status and a closed reason code", async () => {
    const root = await home("prime-resume-j-");
    const scope = scopeFor(root);
    const available = redactPrimeResumeDiagnostics({
      scope,
      state: { status: "available", cursor: cursorFor(root) },
    });
    const unavailable = redactPrimeResumeDiagnostics({
      scope,
      state: { status: "unavailable", reason: "unsupportedVersion", storedVersion: 99 },
    });

    assert.deepEqual(available, {
      scopeDigest: available.scopeDigest,
      status: "available",
      cursorVersion: 2,
    });
    assert.match(available.scopeDigest, /^[0-9a-f]{12}$/);
    assert.deepEqual(unavailable, {
      scopeDigest: available.scopeDigest,
      status: "unavailable",
      reason: "unsupportedVersion",
      storedVersion: 99,
    });
    const serialized = JSON.stringify({ available, unavailable });
    assert.notInclude(serialized, root);
    assert.notInclude(serialized, "project-a");
    assert.notInclude(serialized, "thread-a");
  });
});
