import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { decodePrimePathComponent, primePathComponent } from "./PrimeResourceLayout.ts";

export const PRIME_OWNERSHIP_VERSION = 1 as const;
const MAX_ID_LENGTH = 512;
type Phase = "active" | "stopping" | "stopped" | "sessions-cleaned" | "resources-cleaned";
export type PrimeProcessHandle = { readonly pid: number; readonly startToken: string };
export type PrimeOwnershipRecord = {
  readonly version: 1;
  readonly environmentId: string;
  readonly instanceId: string;
  readonly threadId: string;
  readonly kind?: "thread" | "daemon";
  readonly phase?: Phase;
  readonly process?: PrimeProcessHandle;
  readonly rpcSessionId?: string;
  readonly daemonSessionId?: string;
};
export type PrimeOwnershipWarning = { readonly path: string; readonly reason: string };
export type PrimeOwnershipAction =
  | {
      readonly kind:
        | "process-stopping"
        | "process-stopped"
        | "rpc-session-cleaned"
        | "daemon-session-cleaned"
        | "resource-removed"
        | "record-removed";
      readonly path: string;
    }
  | { readonly kind: "warning"; readonly warning: PrimeOwnershipWarning };
export type PrimeOwnershipProof = {
  readonly processMatches: (handle: PrimeProcessHandle) => Promise<boolean>;
  readonly daemonSessionMatches?: (id: string) => Promise<boolean>;
  readonly rpcSessionMatches?: (id: string) => Promise<boolean>;
};
export type PrimeOwnershipCleanup = {
  readonly stopProcess: (handle: PrimeProcessHandle) => Promise<void>;
  readonly cleanupRpcSession?: (id: string) => Promise<void>;
  readonly cleanupDaemonSession?: (id: string) => Promise<void>;
};
const validId = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
const exact = (v: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
function isRecord(v: unknown): v is PrimeOwnershipRecord {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  if (
    !exact(r, [
      "version",
      "environmentId",
      "instanceId",
      "threadId",
      "kind",
      "phase",
      "process",
      "rpcSessionId",
      "daemonSessionId",
    ]) ||
    r.version !== 1 ||
    !validId(r.environmentId) ||
    !validId(r.instanceId) ||
    !validId(r.threadId)
  )
    return false;
  if (r.kind !== undefined && r.kind !== "thread" && r.kind !== "daemon") return false;
  if (
    r.phase !== undefined &&
    !["active", "stopping", "stopped", "sessions-cleaned", "resources-cleaned"].includes(
      r.phase as string,
    )
  )
    return false;
  if (r.process !== undefined) {
    if (!r.process || typeof r.process !== "object" || Array.isArray(r.process)) return false;
    const p = r.process as Record<string, unknown>;
    if (
      !exact(p, ["pid", "startToken"]) ||
      !Number.isSafeInteger(p.pid) ||
      (p.pid as number) <= 0 ||
      !validId(p.startToken)
    )
      return false;
  }
  return (
    (r.rpcSessionId === undefined || validId(r.rpcSessionId)) &&
    (r.daemonSessionId === undefined || validId(r.daemonSessionId))
  );
}
type Identity = {
  root: string;
  environmentId: string;
  instanceId: string;
  threadId: string;
  instance: string;
  thread: string;
  daemon: string;
};
const identify = (path: string): Identity | undefined => {
  const a = resolve(path).split(sep);
  const n = a.length;
  const file = basename(path).replace(/\.cleaning$/, "");
  if (!file.endsWith(".json")) return;
  const oi = a.lastIndexOf("ownership");
  if (
    oi < 7 ||
    oi !== n - 2 ||
    a[oi - 1]?.startsWith("id-") !== true ||
    a[oi - 2] !== "instances" ||
    a[oi - 3]?.startsWith("id-") !== true ||
    a[oi - 4] !== "environments" ||
    a[oi - 5] !== "v1" ||
    a[oi - 6] !== "prime" ||
    a[oi - 7] !== "userdata"
  )
    return;
  const environmentId = decodePrimePathComponent(a[oi - 3]!);
  const instanceId = decodePrimePathComponent(a[oi - 1]!);
  const threadId =
    file === "daemon.json" ? "__daemon__" : decodePrimePathComponent(file.slice(0, -5));
  if (!environmentId || !instanceId || !threadId) return;
  const root = a.slice(0, oi - 4).join(sep) || sep;
  const instance = a.slice(0, oi).join(sep) || sep;
  return {
    root,
    environmentId,
    instanceId,
    threadId,
    instance,
    thread: join(instance, "threads", primePathComponent(threadId)),
    daemon: join(instance, "daemon"),
  };
};
const syncDir = (p: string) => {
  try {
    const fd = openSync(p, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    /* directory fsync unsupported */
  }
};
const atomicWrite = async (path: string, record: PrimeOwnershipRecord) => {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const h = await open(temp, "wx", 0o600);
  try {
    await h.writeFile(`${JSON.stringify(record)}\n`);
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await rename(temp, path);
    syncDir(dirname(path));
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
};
const safeParents = async (path: string, id: Identity) => {
  const rel = relative(id.root, dirname(path));
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`))
    throw new Error("ownership path is outside Prime root");
  await mkdir(id.root, { recursive: true, mode: 0o700 });
  let cur = id.root;
  const rootStat = await lstat(cur);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw new Error("Prime root is not a real directory");
  for (const part of rel.split(sep)) {
    cur = join(cur, part);
    try {
      const s = await lstat(cur);
      if (!s.isDirectory() || s.isSymbolicLink())
        throw new Error("Prime ownership parent is not a real directory");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      try {
        await mkdir(cur, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const made = await lstat(cur);
      if (!made.isDirectory() || made.isSymbolicLink())
        throw new Error("Prime ownership parent is not a real directory");
    }
  }
};
/** Durable atomic persistence into a per-thread record; no concurrent thread can overwrite another. */
export const writePrimeOwnership = async (path: string, record: PrimeOwnershipRecord) => {
  const id = identify(path);
  if (
    !id ||
    !isRecord(record) ||
    record.environmentId !== id.environmentId ||
    record.instanceId !== id.instanceId ||
    record.threadId !== id.threadId ||
    (basename(path) === "daemon.json") !== (record.kind === "daemon") ||
    (record.kind === "daemon"
      ? record.rpcSessionId !== undefined
      : record.daemonSessionId !== undefined)
  )
    throw new Error("invalid or path-mismatched Prime ownership record");
  await safeParents(path, id);
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink() || !s.isFile())
      throw new Error("ownership target is not a regular file");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  await atomicWrite(path, { ...record, phase: record.phase ?? "active" });
};
const decode = (text: string): { record?: PrimeOwnershipRecord; reason?: string } => {
  try {
    const v: unknown = JSON.parse(text);
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof (v as any).version === "number" &&
      (v as any).version > 1
    )
      return { reason: "future ownership record version; left intact" };
    return isRecord(v)
      ? { record: v }
      : { reason: "partial, corrupt, or unsupported ownership record; left intact" };
  } catch {
    return { reason: "partial or corrupt ownership record; left intact" };
  }
};
const warning = (path: string, reason: string): PrimeOwnershipAction => ({
  kind: "warning",
  warning: { path, reason },
});
const removeExact = async (path: string, actions: PrimeOwnershipAction[]) => {
  try {
    const s = await lstat(path);
    if (s.isSymbolicLink()) throw new Error("refusing to follow resource symlink");
    await rm(path, { recursive: s.isDirectory(), force: true });
    actions.push({ kind: "resource-removed", path });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
};
export const cleanupPrimeOwnership = async (
  path: string,
  proof: PrimeOwnershipProof,
  cleanup: PrimeOwnershipCleanup,
): Promise<readonly PrimeOwnershipAction[]> => {
  const id = identify(path);
  if (!id) throw new Error("ownership path is outside exact Prime layout");
  const actions: PrimeOwnershipAction[] = [];
  const claim = `${path}.cleaning`;
  try {
    await rename(path, claim);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return actions;
    return [warning(path, "ownership record could not be claimed; left intact")];
  }
  let retain = true;
  try {
    const s = await lstat(claim);
    if (!s.isFile() || s.isSymbolicLink())
      throw new Error("claimed ownership record is not a regular file");
    const d = decode(await readFile(claim, "utf8"));
    if (!d.record) {
      actions.push(warning(path, d.reason!));
      return actions;
    }
    let r = d.record;
    if (
      r.environmentId !== id.environmentId ||
      r.instanceId !== id.instanceId ||
      r.threadId !== id.threadId ||
      (basename(path) === "daemon.json") !== (r.kind === "daemon") ||
      (r.kind === "daemon" ? r.rpcSessionId !== undefined : r.daemonSessionId !== undefined)
    ) {
      actions.push(
        warning(path, "ownership identity does not match its exact layout path; left intact"),
      );
      return actions;
    }
    let phase = r.phase ?? "active";
    if (phase === "stopping") {
      actions.push(
        warning(path, "process stop outcome is ambiguous; retained for manual recovery"),
      );
      return actions;
    }
    if (phase === "active" && r.process) {
      const process = r.process;
      let matched = false;
      try {
        matched = await proof.processMatches(process);
      } catch (e) {
        actions.push(warning(path, `process proof threw: ${String(e)}`));
        return actions;
      }
      if (!matched) {
        actions.push(
          warning(path, "captured process PID/start token cannot be proven; left intact"),
        );
        return actions;
      }
      r = { ...r, phase: "stopping" };
      await atomicWrite(claim, r);
      actions.push({ kind: "process-stopping", path });
      try {
        await cleanup.stopProcess(process);
      } catch (e) {
        actions.push(
          warning(path, `process stop threw after durable stopping transition: ${String(e)}`),
        );
        return actions;
      }
      r = { ...r, phase: "stopped" };
      await atomicWrite(claim, r);
      phase = "stopped";
      actions.push({ kind: "process-stopped", path });
    } else if (phase === "active") {
      r = { ...r, phase: "stopped" };
      await atomicWrite(claim, r);
      phase = "stopped";
    }
    if (phase === "stopped") {
      for (const [name, value, match, fn, kind] of [
        [
          "RPC",
          r.rpcSessionId,
          proof.rpcSessionMatches,
          cleanup.cleanupRpcSession,
          "rpc-session-cleaned",
        ],
        [
          "daemon",
          r.daemonSessionId,
          proof.daemonSessionMatches,
          cleanup.cleanupDaemonSession,
          "daemon-session-cleaned",
        ],
      ] as const) {
        if (value) {
          let ok = false;
          try {
            ok = (await match?.(value)) ?? false;
          } catch (e) {
            actions.push(warning(path, `${name} proof threw: ${String(e)}`));
            return actions;
          }
          if (!ok) {
            actions.push(warning(path, `${name} identity cannot be proven; left intact`));
            return actions;
          }
          try {
            await fn?.(value);
            if (!fn) throw new Error("cleanup callback missing");
            actions.push({ kind, path } as PrimeOwnershipAction);
          } catch (e) {
            actions.push(warning(path, `${name} cleanup threw: ${String(e)}`));
            return actions;
          }
        }
      }
      r = { ...r, phase: "sessions-cleaned" };
      await atomicWrite(claim, r);
      phase = "sessions-cleaned";
    }
    if (phase === "sessions-cleaned") {
      try {
        if ((r.kind ?? "thread") === "daemon") await removeExact(id.daemon, actions);
        else {
          await removeExact(join(id.thread, "session"), actions);
          await removeExact(join(id.thread, "config.json"), actions);
          await removeExact(id.thread, actions);
        }
      } catch (e) {
        actions.push(warning(path, `exact resource cleanup failed: ${String(e)}`));
        return actions;
      }
      r = { ...r, phase: "resources-cleaned" };
      await atomicWrite(claim, r);
    }
    try {
      await rm(claim);
      syncDir(dirname(claim));
      retain = false;
      actions.push({ kind: "record-removed", path });
    } catch (e) {
      actions.push(warning(path, `record removal failed after cleanup: ${String(e)}`));
    }
    return actions;
  } catch (e) {
    actions.push(warning(path, `cleanup failed: ${String(e)}`));
    return actions;
  } finally {
    if (retain) {
      try {
        await rename(claim, path);
      } catch (e) {
        actions.push(warning(path, `could not restore claimed record: ${String(e)}`));
      }
    }
  }
};
export const recoverPrimeOwnership = async (
  root: string,
  proof: PrimeOwnershipProof,
  cleanup: PrimeOwnershipCleanup,
): Promise<readonly PrimeOwnershipAction[]> => {
  const expected = resolve(root);
  if (
    basename(expected) !== "v1" ||
    basename(dirname(expected)) !== "prime" ||
    basename(dirname(dirname(expected))) !== "userdata"
  )
    throw new Error("recovery root is not exact Prime layout");
  const actions: PrimeOwnershipAction[] = [];
  const visit = async (dir: string): Promise<void> => {
    try {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) await visit(p);
        else if (e.isFile() && e.name.endsWith(".json") && identify(p)?.root === expected) {
          try {
            actions.push(...(await cleanupPrimeOwnership(p, proof, cleanup)));
          } catch (error) {
            actions.push(warning(p, `record cleanup threw: ${String(error)}`));
          }
        } else if (
          e.isFile() &&
          e.name.endsWith(".json.cleaning") &&
          identify(p)?.root === expected
        ) {
          try {
            await rename(p, p.slice(0, -9));
            actions.push(warning(p, "recovered interrupted cleanup claim"));
          } catch (error) {
            actions.push(warning(p, `claim recovery failed: ${String(error)}`));
          }
        } else if (e.isFile() && e.name.includes(".tmp")) {
          actions.push(warning(p, "incomplete atomic write retained for inspection"));
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        actions.push(warning(dir, `ownership directory unreadable: ${String(error)}`));
    }
  };
  await visit(expected);
  return actions;
};
