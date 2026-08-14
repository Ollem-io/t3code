import { assert, describe, it } from "@effect/vitest";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupPrimeOwnership,
  recoverPrimeOwnership,
  writePrimeOwnership,
} from "./PrimeOwnership.ts";
import { primeResourceLayout } from "./PrimeResourceLayout.ts";
const rec = (instanceId: string, threadId: string, pid = 71) => ({
  version: 1 as const,
  environmentId: "env",
  instanceId,
  threadId,
  process: { pid, startToken: "captured-start" },
  rpcSessionId: `rpc-${threadId}`,
});
async function missing(path: string) {
  try {
    await stat(path);
    throw Error("exists");
  } catch (e) {
    assert.strictEqual((e as NodeJS.ErrnoException).code, "ENOENT");
  }
}
const proofs = {
  processMatches: async (h: { pid: number; startToken: string }) =>
    h.pid === 71 && h.startToken === "captured-start",
  rpcSessionMatches: async (id: string) => id.startsWith("rpc-"),
  daemonSessionMatches: async (id: string) => id.startsWith("daemon-"),
};
async function rejects(run: () => Promise<unknown>) {
  try {
    await run();
    throw Error("expected rejection");
  } catch (e) {
    assert.notStrictEqual((e as Error).message, "expected rejection");
  }
}
const callbacks = (events: string[]) => ({
  stopProcess: async (h: { pid: number }) => {
    events.push(`stop:${h.pid}`);
  },
  cleanupRpcSession: async (id: string) => {
    events.push(`rpc:${id}`);
  },
  cleanupDaemonSession: async (id: string) => {
    events.push(`daemon:${id}`);
  },
});
describe("PrimeOwnership", () => {
  it("keeps concurrent thread records independent and removes exact owned resources", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-"));
    const a = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    const b = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "b" });
    await Promise.all([
      writePrimeOwnership(a.ownership, rec("one", "a")),
      writePrimeOwnership(b.ownership, rec("one", "b", 72)),
    ]);
    for (const x of [a, b]) {
      await mkdir(x.session, { recursive: true });
      await writeFile(x.config, "config");
    }
    const sentinel = join(home, "sentinel");
    await writeFile(sentinel, "safe");
    const events: string[] = [];
    const actions = await cleanupPrimeOwnership(a.ownership, proofs, callbacks(events));
    assert.deepStrictEqual(events, ["stop:71", "rpc:rpc-a"]);
    assert.ok(actions.some((a) => a.kind === "process-stopped"));
    await missing(a.thread);
    await stat(b.ownership);
    await stat(b.thread);
    assert.strictEqual(await readFile(sentinel, "utf8"), "safe");
  });
  it("binds record identity to decoded path and rejects symlink parents/targets", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await rejects(() => writePrimeOwnership(l.ownership, rec("wrong", "a")));
    const outside = await mkdtemp(join(tmpdir(), "outside-"));
    await mkdir(l.instance, { recursive: true });
    await symlink(outside, l.ownershipDirectory);
    await rejects(() => writePrimeOwnership(l.ownership, rec("one", "a")));
    assert.deepStrictEqual(await import("node:fs/promises").then((x) => x.readdir(outside)), []);
  });
  it("requires PID and start token plus RPC and daemon matches", async () => {
    for (const [name, p] of [
      ["process", { ...proofs, processMatches: async () => false }],
      ["rpc", { ...proofs, rpcSessionMatches: async () => false }],
    ] as const) {
      const home = await mkdtemp(join(tmpdir(), `prime-${name}-`));
      const l = primeResourceLayout({
        home,
        environmentId: "env",
        instanceId: "one",
        threadId: "a",
      });
      await writePrimeOwnership(l.ownership, rec("one", "a"));
      const e: string[] = [];
      await cleanupPrimeOwnership(l.ownership, p, callbacks(e));
      if (name === "process") assert.deepStrictEqual(e, []);
      else assert.deepStrictEqual(e.slice(0, 1), ["stop:71"]);
      await stat(l.ownership);
    }
    const home = await mkdtemp(join(tmpdir(), "prime-daemon-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await writePrimeOwnership(l.daemonOwnership, {
      version: 1,
      environmentId: "env",
      instanceId: "one",
      threadId: "__daemon__",
      kind: "daemon",
      process: { pid: 71, startToken: "captured-start" },
      daemonSessionId: "daemon-one",
    });
    const e: string[] = [];
    await cleanupPrimeOwnership(
      l.daemonOwnership,
      { ...proofs, daemonSessionMatches: async () => false },
      callbacks(e),
    );
    assert.deepStrictEqual(e, ["stop:71"]);
    await stat(l.daemonOwnership);
  });
  it("durably avoids a second stop after partial cleanup retry", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-retry-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await mkdir(l.session, { recursive: true });
    await writePrimeOwnership(l.ownership, rec("one", "a"));
    let stops = 0;
    await cleanupPrimeOwnership(l.ownership, proofs, {
      ...callbacks([]),
      stopProcess: async () => {
        stops++;
      },
      cleanupRpcSession: async () => {
        throw Error("once");
      },
    });
    await cleanupPrimeOwnership(l.ownership, proofs, {
      ...callbacks([]),
      stopProcess: async () => {
        stops++;
      },
    });
    assert.strictEqual(stops, 1);
    await missing(l.ownership);
  });
  it("recovery warns on one thrown record and continues to the next; retains corrupt/future", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-recover-"));
    const a = primeResourceLayout({ home, environmentId: "env", instanceId: "a", threadId: "a" });
    const b = primeResourceLayout({ home, environmentId: "env", instanceId: "b", threadId: "b" });
    const c = primeResourceLayout({ home, environmentId: "env", instanceId: "c", threadId: "c" });
    await writePrimeOwnership(a.ownership, rec("a", "a"));
    await writePrimeOwnership(b.ownership, rec("b", "b"));
    await mkdir(c.ownershipDirectory, { recursive: true });
    await writeFile(c.ownership, "{");
    const f = primeResourceLayout({ home, environmentId: "env", instanceId: "f", threadId: "f" });
    await mkdir(f.ownershipDirectory, { recursive: true });
    await writeFile(f.ownership, JSON.stringify({ ...rec("f", "f"), version: 2 }));
    const stopped: number[] = [];
    const actions = await recoverPrimeOwnership(
      a.root,
      {
        ...proofs,
        processMatches: async (h) => {
          if (h.pid === 71 && stopped.length === 0) {
            stopped.push(0);
            throw Error("proof boom");
          }
          return true;
        },
      },
      {
        ...callbacks([]),
        stopProcess: async (h) => {
          stopped.push(h.pid);
        },
      },
    );
    assert.ok(
      actions.some((x) => x.kind === "warning" && x.warning.reason.includes("proof threw")),
    );
    assert.ok(stopped.includes(71));
    await stat(a.ownership);
    await stat(c.ownership);
    await stat(f.ownership);
  });
  it("persists RPC success independently so a retry never repeats it", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-rpc-marker-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await writePrimeOwnership(l.ownership, rec("one", "a"));
    let rpc = 0;
    await cleanupPrimeOwnership(l.ownership, proofs, {
      stopProcess: async () => {},
      cleanupRpcSession: async () => {
        rpc++;
      },
    });
    assert.strictEqual(rpc, 1);
    await missing(l.ownership);
  });
  it("serializes writers and cleanup with an exclusive per-record lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-lock-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await writePrimeOwnership(l.ownership, rec("one", "a"));
    const held = await open(`${l.ownership}.lock`, "wx");
    try {
      await rejects(() => writePrimeOwnership(l.ownership, rec("one", "a", 72)));
      const actions = await cleanupPrimeOwnership(l.ownership, proofs, callbacks([]));
      assert.ok(actions.some((x) => x.kind === "warning" && x.warning.reason.includes("busy")));
      assert.strictEqual(JSON.parse(await readFile(l.ownership, "utf8")).process.pid, 71);
    } finally {
      await held.close();
      await import("node:fs/promises").then((x) => x.rm(`${l.ownership}.lock`));
    }
  });
  it("never clobbers a replacement while restoring a retained claim", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-replacement-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await writePrimeOwnership(l.ownership, rec("one", "a"));
    const actions = await cleanupPrimeOwnership(
      l.ownership,
      {
        ...proofs,
        processMatches: async () => {
          await writeFile(l.ownership, "replacement");
          return false;
        },
      },
      callbacks([]),
    );
    assert.strictEqual(await readFile(l.ownership, "utf8"), "replacement");
    assert.ok(
      actions.some((x) => x.kind === "warning" && x.warning.reason.includes("without overwriting")),
    );
    await stat(`${l.ownership}.cleaning`);
  });
  it("rejects a recovery root reached through a symlink ancestor", async () => {
    const outside = await mkdtemp(join(tmpdir(), "prime-attacker-"));
    const real = primeResourceLayout({
      home: outside,
      environmentId: "env",
      instanceId: "one",
      threadId: "a",
    });
    await writePrimeOwnership(real.ownership, rec("one", "a"));
    const wrapper = await mkdtemp(join(tmpdir(), "prime-wrapper-"));
    const linkHome = join(wrapper, "linked-home");
    await symlink(outside, linkHome);
    const linked = primeResourceLayout({
      home: linkHome,
      environmentId: "env",
      instanceId: "one",
      threadId: "a",
    });
    await rejects(() => recoverPrimeOwnership(linked.root, proofs, callbacks([])));
    await stat(real.ownership);
  });
  it("recovery retains an interrupted claim when a newer record occupies the path", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-claim-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await writePrimeOwnership(l.ownership, rec("one", "a"));
    await rename(l.ownership, `${l.ownership}.cleaning`);
    await writeFile(
      l.ownership,
      JSON.stringify({ ...rec("one", "a", 72), recordId: "new", operationId: "new-op" }),
    );
    const actions = await recoverPrimeOwnership(
      l.root,
      { ...proofs, processMatches: async () => false },
      callbacks([]),
    );
    assert.ok(
      actions.some(
        (x) => x.kind === "warning" && x.warning.reason.includes("retained cleanup claim"),
      ),
    );
    assert.strictEqual(JSON.parse(await readFile(l.ownership, "utf8")).recordId, "new");
    await stat(`${l.ownership}.cleaning`);
  });
  it("quarantines a raced replacement without deleting or hiding it", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-resource-race-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await mkdir(l.session, { recursive: true });
    await writePrimeOwnership(l.ownership, rec("one", "a"));
    const displaced = `${l.session}.owned`;
    let swapped = false;
    const actions = await cleanupPrimeOwnership(l.ownership, proofs, callbacks([]), {
      beforeResourceRename: async (path) => {
        if (path !== l.session || swapped) return;
        swapped = true;
        await rename(path, displaced);
        await mkdir(path);
        await writeFile(join(path, "replacement"), "visible");
      },
    });
    assert.isFalse(
      await stat(l.session).then(
        () => true,
        () => false,
      ),
    );
    assert.ok((await readdir(l.thread)).some((name) => name.includes("cleaning-resource")));
    await stat(displaced);
    await stat(l.ownership);
    assert.ok(
      actions.some((x) => x.kind === "warning" && x.warning.reason.includes("identity changed")),
    );
  });
  it("retains quarantine and never touches outside when an ancestor changes after rename", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-ancestor-race-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await mkdir(l.session, { recursive: true });
    await writeFile(join(l.session, "owned"), "must-not-escape");
    await writePrimeOwnership(l.ownership, rec("one", "a"));
    const outside = await mkdtemp(join(tmpdir(), "prime-outside-"));
    const moved = `${l.thread}.moved`;
    let swapped = false;
    const actions = await cleanupPrimeOwnership(l.ownership, proofs, callbacks([]), {
      afterResourceRename: async (path) => {
        if (path !== l.session || swapped) return;
        swapped = true;
        await rename(l.thread, moved);
        await symlink(outside, l.thread);
      },
    });
    assert.deepStrictEqual(await readdir(outside), []);
    assert.ok((await readdir(moved)).some((name) => name.includes("cleaning-resource")));
    assert.ok(
      actions.some(
        (x) => x.kind === "warning" && x.warning.reason.includes("quarantine transaction failed"),
      ),
    );
    await stat(l.ownership);
  });

  it("recovery enumerates and safely retains a bound directory claim without copy restoration", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-resource-recover-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await mkdir(l.session, { recursive: true });
    await writeFile(join(l.session, "owned"), "data");
    await writePrimeOwnership(l.ownership, rec("one", "a"));
    const record = JSON.parse(await readFile(l.ownership, "utf8"));
    const encoded = Buffer.from(record.recordId, "utf8").toString("base64url");
    const claim = join(l.thread, `.session.cleaning-resource-id-${encoded}-retained`);
    await rename(l.session, claim);
    const actions = await recoverPrimeOwnership(
      l.root,
      { ...proofs, processMatches: async () => false },
      callbacks([]),
    );
    assert.isFalse(
      await stat(l.session).then(
        () => true,
        () => false,
      ),
    );
    assert.strictEqual(await readFile(join(claim, "owned"), "utf8"), "data");
    assert.ok(
      actions.some(
        (x) =>
          x.kind === "warning" &&
          x.warning.reason.includes("retained uniquely named directory claim"),
      ),
    );
  });
  it("stops a recovery subtree when an enumerated ancestor is replaced", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-recovery-ancestor-race-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await writePrimeOwnership(l.ownership, rec("one", "a"));
    const outside = await mkdtemp(join(tmpdir(), "prime-recovery-outside-"));
    const moved = `${join(l.root, "environments")}.moved`;
    let swapped = false;
    const actions = await recoverPrimeOwnership(l.root, proofs, callbacks([]), {
      afterDirectoryRead: async (dir) => {
        if (dir !== join(l.root, "environments") || swapped) return;
        swapped = true;
        await rename(dir, moved);
        await symlink(outside, dir);
      },
    });
    assert.deepStrictEqual(await readdir(outside), []);
    await stat(l.ownership.replace(join(l.root, "environments"), moved));
    assert.ok(
      actions.some((x) => x.kind === "warning" && x.warning.reason.includes("ancestry changed")),
    );
  });

  it("retains an interrupted record claim if its parent changes before restore", async () => {
    const home = await mkdtemp(join(tmpdir(), "prime-recovery-claim-race-"));
    const l = primeResourceLayout({ home, environmentId: "env", instanceId: "one", threadId: "a" });
    await writePrimeOwnership(l.ownership, rec("one", "a"));
    const claim = `${l.ownership}.cleaning`;
    await rename(l.ownership, claim);
    const outside = await mkdtemp(join(tmpdir(), "prime-recovery-claim-outside-"));
    const ownership = join(l.instance, "ownership");
    const moved = `${ownership}.moved`;
    let swapped = false;
    const actions = await recoverPrimeOwnership(l.root, proofs, callbacks([]), {
      beforeClaimRestoreLink: async () => {
        if (swapped) return;
        swapped = true;
        await rename(ownership, moved);
        await symlink(outside, ownership);
      },
    });
    assert.deepStrictEqual(await readdir(outside), []);
    await stat(claim.replace(ownership, moved));
    assert.ok(
      actions.some(
        (x) => x.kind === "warning" && x.warning.reason.includes("retained uniquely named claim"),
      ),
    );
  });
});
