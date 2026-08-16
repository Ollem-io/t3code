// Cursor storage is plain promise-based node fs, so its test drives the same
// APIs directly rather than through an Effect FileSystem it does not use.
// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { PrimeResumeCursorLatest, PrimeResumeCursorScope } from "@t3tools/contracts";

import {
  discardPrimeResumeCursor,
  makePrimeResumeCursor,
  primeSessionPathToken,
  readPrimeResumeCursor,
  writePrimeResumeCursor,
} from "./PrimeResumeCursor.ts";
import { primeHomeFingerprint, primeResourceLayout } from "./PrimeResourceLayout.ts";

const home = async (prefix: string) => mkdtemp(join(tmpdir(), prefix));

const layoutFor = (root: string) =>
  primeResourceLayout({
    home: root,
    environmentId: "env-a",
    instanceId: "prime",
    threadId: "thread-a",
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

const exists = async (path: string) =>
  await access(path).then(
    () => true,
    () => false,
  );

/**
 * PA-B04 repair regression. PA-B02 recorded the debt in words: a
 * `capabilityMismatch` cursor keeps refusing forever, so the recovery UI has to
 * be able to delete it. These pin the deletion and, just as importantly, the
 * two things it must refuse to delete.
 */
describe("PrimeResumeCursor discard", () => {
  it("deletes this thread's own cursor, and its backup, so a fresh start can start", async () => {
    const root = await home("prime-discard-a-");
    const layout = layoutFor(root);
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));
    // A second write leaves the rolling backup behind; a discard that left it
    // would let a later fallback resurrect what the user chose to leave.
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));
    assert.isTrue(await exists(layout.resumeCursorBackup));

    assert.isTrue(await discardPrimeResumeCursor(layout.resumeCursor, scopeFor(root)));

    assert.isFalse(await exists(layout.resumeCursor));
    assert.isFalse(await exists(layout.resumeCursorBackup));
    // The next recovery reads "nothing to resume", which is the only refusal
    // allowed to start a new session.
    assert.deepEqual((await readPrimeResumeCursor(layout.resumeCursor)).state, {
      status: "unavailable",
      reason: "missing",
    });
  });

  it("refuses a cursor that provably belongs to another scope", async () => {
    const root = await home("prime-discard-b-");
    const layout = layoutFor(root);
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));

    assert.isFalse(
      await discardPrimeResumeCursor(
        layout.resumeCursor,
        scopeFor(root, { projectId: "project-somebody-else" } as Partial<PrimeResumeCursorScope>),
      ),
      "proof-before-action: a row for another scope is not ours to delete",
    );
    assert.isTrue(await exists(layout.resumeCursor));
  });

  it("reports nothing discarded when there was nothing there", async () => {
    const root = await home("prime-discard-c-");
    assert.isFalse(
      await discardPrimeResumeCursor(layoutFor(root).resumeCursor, scopeFor(root)),
      "an absent cursor is a satisfied post-condition, not a deletion",
    );
  });

  it("clears an unreadable cursor, which is the brick it exists to remove", async () => {
    const root = await home("prime-discard-d-");
    const layout = layoutFor(root);
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));
    await writeFile(layout.resumeCursor, "{ this is not a cursor");

    assert.isTrue(await discardPrimeResumeCursor(layout.resumeCursor, scopeFor(root)));
    assert.isFalse(await exists(layout.resumeCursor));
  });

  it("touches only the cursor: durable session storage is never its business", async () => {
    const root = await home("prime-discard-e-");
    const layout = layoutFor(root);
    await writePrimeResumeCursor(layout.resumeCursor, cursorFor(root));
    await mkdir(dirname(layout.ownership), { recursive: true });
    await writeFile(layout.ownership, "ownership record\n");

    assert.isTrue(await discardPrimeResumeCursor(layout.resumeCursor, scopeFor(root)));
    assert.equal(await readFile(layout.ownership, "utf8"), "ownership record\n");
  });
});
