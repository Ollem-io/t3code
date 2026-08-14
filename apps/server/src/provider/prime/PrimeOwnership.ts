import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync } from "node:fs";
import {
  cp,
  lstat,
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { decodePrimePathComponent, primePathComponent } from "./PrimeResourceLayout.ts";

export const PRIME_OWNERSHIP_VERSION = 1 as const;
const MAX_ID_LENGTH = 512;
export type PrimeProcessHandle = { readonly pid: number; readonly startToken: string };
export type PrimeOwnershipRecord = {
  readonly version: 1;
  readonly environmentId: string;
  readonly instanceId: string;
  readonly threadId: string;
  readonly kind?: "thread" | "daemon";
  readonly recordId?: string;
  readonly operationId?: string;
  readonly process?: PrimeProcessHandle;
  readonly rpcSessionId?: string;
  readonly daemonSessionId?: string;
  readonly processStopped?: boolean;
  readonly rpcCleaned?: boolean;
  readonly daemonCleaned?: boolean;
  readonly resourcesCleaned?: boolean;
};
export type PrimeOwnershipWarning = { readonly path: string; readonly reason: string };
export type PrimeOwnershipAction =
  | {
      readonly kind:
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
  readonly stopProcess: (handle: PrimeProcessHandle, operationId?: string) => Promise<void>;
  readonly cleanupRpcSession?: (id: string, operationId?: string) => Promise<void>;
  readonly cleanupDaemonSession?: (id: string, operationId?: string) => Promise<void>;
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
      "recordId",
      "operationId",
      "process",
      "rpcSessionId",
      "daemonSessionId",
      "processStopped",
      "rpcCleaned",
      "daemonCleaned",
      "resourcesCleaned",
    ]) ||
    r.version !== 1 ||
    !validId(r.environmentId) ||
    !validId(r.instanceId) ||
    !validId(r.threadId)
  )
    return false;
  if (r.kind !== undefined && r.kind !== "thread" && r.kind !== "daemon") return false;
  if (
    (r.recordId !== undefined && !validId(r.recordId)) ||
    (r.operationId !== undefined && !validId(r.operationId))
  )
    return false;
  for (const k of ["processStopped", "rpcCleaned", "daemonCleaned", "resourcesCleaned"] as const)
    if (r[k] !== undefined && typeof r[k] !== "boolean") return false;
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
  const normalized = path.replace(/\.cleaning$/, "");
  const a = resolve(normalized).split(sep);
  const n = a.length;
  const file = basename(normalized);
  if (!file.endsWith(".json")) return;
  const oi = a.lastIndexOf("ownership");
  if (
    oi < 7 ||
    oi !== n - 2 ||
    !a[oi - 1]?.startsWith("id-") ||
    a[oi - 2] !== "instances" ||
    !a[oi - 3]?.startsWith("id-") ||
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
  } catch {}
};
const atomicWrite = async (path: string, r: PrimeOwnershipRecord) => {
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const h = await open(temp, "wx", 0o600);
  try {
    await h.writeFile(`${JSON.stringify(r)}\n`);
    await h.sync();
  } finally {
    await h.close();
  }
  try {
    await rename(temp, path);
    syncDir(dirname(path));
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
};
type ChainIdentity = readonly {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}[];
const captureChain = async (path: string, create = false): Promise<ChainIdentity> => {
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  const result: { path: string; dev: bigint; ino: bigint }[] = [];
  let cur: string = sep;
  for (const part of parts) {
    cur = join(cur, part);
    try {
      const s = await lstat(cur, { bigint: true });
      if (s.isSymbolicLink() || !s.isDirectory())
        throw Error(`unsafe symlink/non-directory: ${cur}`);
      result.push({ path: cur, dev: s.dev, ino: s.ino });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw e;
      try {
        await mkdir(cur, { mode: 0o700 });
      } catch (m) {
        if ((m as NodeJS.ErrnoException).code !== "EEXIST") throw m;
      }
      const s = await lstat(cur, { bigint: true });
      if (s.isSymbolicLink() || !s.isDirectory()) throw Error("unsafe created directory");
      result.push({ path: cur, dev: s.dev, ino: s.ino });
    }
  }
  return result;
};
const validateChain = async (path: string, create = false) =>
  void (await captureChain(path, create));
const chainUnchanged = async (before: ChainIdentity) => {
  try {
    const after = await captureChain(before.at(-1)?.path ?? sep);
    return (
      before.length === after.length &&
      before.every((entry, i) => entry.dev === after[i]?.dev && entry.ino === after[i]?.ino)
    );
  } catch {
    return false;
  }
};
export type PrimeOwnershipTransactionHooks = {
  readonly beforeResourceRename?: (path: string) => Promise<void>;
  readonly afterResourceRename?: (path: string, claim: string) => Promise<void>;
};
const withLock = async <T>(path: string, fn: () => Promise<T>): Promise<T> => {
  const lock = `${path}.lock`;
  let h;
  try {
    h = await open(lock, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw Error("ownership record is busy (cleanup lock held)");
    throw e;
  }
  try {
    return await fn();
  } finally {
    await h.close();
    await rm(lock, { force: true });
    syncDir(dirname(lock));
  }
};
const validate = (path: string, r: PrimeOwnershipRecord, id: Identity) =>
  r.environmentId === id.environmentId &&
  r.instanceId === id.instanceId &&
  r.threadId === id.threadId &&
  (basename(path) === "daemon.json") === (r.kind === "daemon") &&
  (r.kind === "daemon" ? r.rpcSessionId === undefined : r.daemonSessionId === undefined);
export const writePrimeOwnership = async (path: string, record: PrimeOwnershipRecord) => {
  const id = identify(path);
  if (!id || !isRecord(record) || !validate(path, record, id))
    throw Error("invalid or path-mismatched Prime ownership record");
  await validateChain(dirname(path), true);
  return withLock(path, async () => {
    try {
      const s = await lstat(path);
      if (s.isSymbolicLink() || !s.isFile()) throw Error("ownership target is not a regular file");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await atomicWrite(path, {
      ...record,
      recordId: record.recordId ?? randomUUID(),
      operationId: record.operationId ?? randomUUID(),
    });
  });
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
const restoreClaimNoClobber = async (
  original: string,
  claim: string,
  actions: PrimeOwnershipAction[],
  reason: string,
) => {
  try {
    const claimed = await lstat(claim);
    if (claimed.isDirectory()) {
      await mkdir(original, { mode: 0o700 });
      for (const entry of await readdir(claim))
        await cp(join(claim, entry), join(original, entry), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      actions.push(
        warning(original, `${reason}; directory restored by no-clobber copy and claim retained`),
      );
      syncDir(dirname(original));
      return true;
    }
    await link(claim, original);
    await rm(claim);
    syncDir(dirname(original));
    actions.push(warning(original, `${reason}; claimed entry restored without clobbering`));
    return true;
  } catch (e) {
    actions.push(
      warning(
        claim,
        `${reason}; retained uniquely named claim because original is occupied or restore failed: ${String(e)}`,
      ),
    );
    return false;
  }
};
const removeClaimed = async (
  path: string,
  recordId: string,
  actions: PrimeOwnershipAction[],
  hooks?: PrimeOwnershipTransactionHooks,
) => {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw e;
  }
  if (before.isSymbolicLink()) throw Error("refusing to follow resource symlink");
  const chain = await captureChain(dirname(path));
  await hooks?.beforeResourceRename?.(path);
  const claim = join(
    dirname(path),
    `.${basename(path)}.cleaning-resource-${primePathComponent(recordId)}-${randomUUID()}`,
  );
  try {
    await rename(path, claim);
  } catch (e) {
    actions.push(warning(path, `resource claim rename failed safely: ${String(e)}`));
    return false;
  }
  try {
    await hooks?.afterResourceRename?.(path, claim);
    const after = await lstat(claim, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino) {
      await restoreClaimNoClobber(path, claim, actions, "resource identity changed while claimed");
      return false;
    }
    if (!(await chainUnchanged(chain))) {
      await restoreClaimNoClobber(
        path,
        claim,
        actions,
        "resource ancestor chain changed while claimed",
      );
      return false;
    }
    const again = await lstat(claim, { bigint: true });
    if (after.dev !== again.dev || after.ino !== again.ino) {
      await restoreClaimNoClobber(path, claim, actions, "claimed resource was swapped");
      return false;
    }
    await rm(claim, { recursive: after.isDirectory() });
    actions.push({ kind: "resource-removed", path });
    syncDir(dirname(path));
    return true;
  } catch (e) {
    await restoreClaimNoClobber(
      path,
      claim,
      actions,
      `resource quarantine transaction failed: ${String(e)}`,
    );
    return false;
  }
};
export const cleanupPrimeOwnership = async (
  path: string,
  proof: PrimeOwnershipProof,
  cleanup: PrimeOwnershipCleanup,
  hooks?: PrimeOwnershipTransactionHooks,
): Promise<readonly PrimeOwnershipAction[]> => {
  const id = identify(path);
  if (!id) throw Error("ownership path is outside exact Prime layout");
  await validateChain(dirname(path));
  try {
    return await withLock(path, async () => {
      const actions: PrimeOwnershipAction[] = [];
      const claim = `${path}.cleaning`;
      try {
        await lstat(claim);
        return [warning(path, "retained cleanup claim already exists; active record left intact")];
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      try {
        await rename(path, claim);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return actions;
        throw e;
      }
      let retain = true;
      try {
        const s = await lstat(claim);
        if (!s.isFile() || s.isSymbolicLink())
          throw Error("claimed ownership record is not a regular file");
        const d = decode(await readFile(claim, "utf8"));
        if (!d.record) {
          actions.push(warning(path, d.reason!));
          return actions;
        }
        let r = d.record;
        if (!validate(path, r, id)) {
          actions.push(
            warning(path, "ownership identity does not match its exact layout path; left intact"),
          );
          return actions;
        }
        r = {
          ...r,
          recordId: r.recordId ?? randomUUID(),
          operationId: r.operationId ?? randomUUID(),
        };
        await atomicWrite(claim, r);
        const persist = async (p: Partial<PrimeOwnershipRecord>) => {
          r = { ...r, ...p };
          await atomicWrite(claim, r);
        };
        if (r.process && !r.processStopped) {
          let ok = false;
          try {
            ok = await proof.processMatches(r.process);
          } catch (e) {
            actions.push(warning(path, `process proof threw: ${String(e)}`));
            return actions;
          }
          if (!ok) {
            actions.push(
              warning(path, "captured process PID/start token cannot be proven; left intact"),
            );
            return actions;
          }
          try {
            await cleanup.stopProcess(r.process, `${r.operationId}:process`);
          } catch (e) {
            actions.push(warning(path, `process stop threw: ${String(e)}`));
            return actions;
          }
          await persist({ processStopped: true });
          actions.push({ kind: "process-stopped", path });
        }
        if (r.rpcSessionId && !r.rpcCleaned) {
          let ok = false;
          try {
            ok = (await proof.rpcSessionMatches?.(r.rpcSessionId)) ?? false;
          } catch (e) {
            actions.push(warning(path, `RPC proof threw: ${String(e)}`));
            return actions;
          }
          if (!ok) {
            actions.push(warning(path, "RPC identity cannot be proven; left intact"));
            return actions;
          }
          try {
            if (!cleanup.cleanupRpcSession) throw Error("cleanup callback missing");
            await cleanup.cleanupRpcSession(r.rpcSessionId, `${r.operationId}:rpc`);
          } catch (e) {
            actions.push(warning(path, `RPC cleanup threw: ${String(e)}`));
            return actions;
          }
          await persist({ rpcCleaned: true });
          actions.push({ kind: "rpc-session-cleaned", path });
        }
        if (r.daemonSessionId && !r.daemonCleaned) {
          let ok = false;
          try {
            ok = (await proof.daemonSessionMatches?.(r.daemonSessionId)) ?? false;
          } catch (e) {
            actions.push(warning(path, `daemon proof threw: ${String(e)}`));
            return actions;
          }
          if (!ok) {
            actions.push(warning(path, "daemon identity cannot be proven; left intact"));
            return actions;
          }
          try {
            if (!cleanup.cleanupDaemonSession) throw Error("cleanup callback missing");
            await cleanup.cleanupDaemonSession(r.daemonSessionId, `${r.operationId}:daemon`);
          } catch (e) {
            actions.push(warning(path, `daemon cleanup threw: ${String(e)}`));
            return actions;
          }
          await persist({ daemonCleaned: true });
          actions.push({ kind: "daemon-session-cleaned", path });
        }
        if (!r.resourcesCleaned) {
          try {
            const cleaned =
              (r.kind ?? "thread") === "daemon"
                ? await removeClaimed(id.daemon, r.recordId!, actions, hooks)
                : (await removeClaimed(join(id.thread, "session"), r.recordId!, actions, hooks)) &&
                  (await removeClaimed(
                    join(id.thread, "config.json"),
                    r.recordId!,
                    actions,
                    hooks,
                  )) &&
                  (await removeClaimed(id.thread, r.recordId!, actions, hooks));
            if (!cleaned) return actions;
          } catch (e) {
            actions.push(warning(path, `exact resource cleanup failed: ${String(e)}`));
            return actions;
          }
          await persist({ resourcesCleaned: true });
        }
        await rm(claim);
        syncDir(dirname(claim));
        retain = false;
        actions.push({ kind: "record-removed", path });
        return actions;
      } finally {
        if (retain) {
          try {
            await link(claim, path);
            await rm(claim);
            syncDir(dirname(path));
          } catch (e) {
            actions.push(
              warning(
                path,
                `claimed record retained without overwriting replacement: ${String(e)}`,
              ),
            );
          }
        }
      }
    });
  } catch (e) {
    return [warning(path, String(e))];
  }
};
const recoverResourceClaim = async (
  claim: string,
  expectedRoot: string,
  actions: PrimeOwnershipAction[],
) => {
  const name = basename(claim);
  const marker = ".cleaning-resource-id-";
  const markerAt = name.indexOf(marker);
  if (!name.startsWith(".") || markerAt < 2) return false;
  const original = join(dirname(claim), name.slice(1, markerAt));
  const relativeParts = relative(expectedRoot, claim).split(sep);
  const instancesAt = relativeParts.indexOf("instances");
  if (instancesAt < 0 || !relativeParts[instancesAt + 1]) {
    actions.push(warning(claim, "retained unbound resource claim outside an instance"));
    return true;
  }
  const instance = join(expectedRoot, ...relativeParts.slice(0, instancesAt + 2));
  const ownership = join(instance, "ownership");
  let bound = false;
  try {
    for (const entry of await readdir(ownership, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        (!entry.name.endsWith(".json") && !entry.name.endsWith(".json.cleaning"))
      )
        continue;
      const decoded = decode(await readFile(join(ownership, entry.name), "utf8"));
      if (!decoded.record?.recordId) continue;
      if (name.includes(`${primePathComponent(decoded.record.recordId)}-`)) {
        bound = true;
        if (decoded.record.resourcesCleaned) {
          actions.push(
            warning(claim, "retained resource claim bound to completed generation for inspection"),
          );
          return true;
        }
        await restoreClaimNoClobber(
          original,
          claim,
          actions,
          "recovered resource claim bound to incomplete ownership generation",
        );
        return true;
      }
    }
  } catch (e) {
    actions.push(warning(claim, `resource claim recovery inspection failed safely: ${String(e)}`));
    return true;
  }
  if (!bound)
    actions.push(warning(claim, "retained resource claim with no matching ownership generation"));
  return true;
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
    throw Error("recovery root is not exact Prime layout");
  await validateChain(expected);
  const actions: PrimeOwnershipAction[] = [];
  const visit = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        actions.push(warning(p, "symlink skipped during recovery"));
        continue;
      }
      if (e.name.includes(".cleaning-resource-") && (e.isFile() || e.isDirectory())) {
        await recoverResourceClaim(p, expected, actions);
      } else if (e.isDirectory()) await visit(p);
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
        const original = p.slice(0, -9);
        try {
          await link(p, original);
          await rm(p);
          actions.push(
            warning(p, "recovered interrupted cleanup claim without clobbering active record"),
          );
          actions.push(...(await cleanupPrimeOwnership(original, proof, cleanup)));
        } catch (error) {
          actions.push(
            warning(p, `retained cleanup claim recovery failed safely: ${String(error)}`),
          );
        }
      } else if (e.isFile() && e.name.includes(".tmp"))
        actions.push(warning(p, "incomplete atomic write retained for inspection"));
    }
  };
  await visit(expected);
  return actions;
};
