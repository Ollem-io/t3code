import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync } from "node:fs";
import { link, lstat, mkdir, open, readdir, readFile, rename, stat } from "node:fs/promises";
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
  /**
   * Exact ids of heartbeats this environment created on the owned session.
   *
   * A heartbeat outlives its turn and can keep a daemon resident, so its id is
   * the minimum handle that makes cleanup exact: without it a later cleanup
   * would either leave T3's own schedule running forever or have to guess,
   * and guessing here means stopping someone else's work.
   */
  readonly heartbeatIds?: readonly string[];
  readonly processStopped?: boolean;
  readonly rpcCleaned?: boolean;
  readonly heartbeatsCleaned?: boolean;
  readonly daemonCleaned?: boolean;
  readonly resourcesCleaned?: boolean;
};
export type PrimeOwnershipWarning = { readonly path: string; readonly reason: string };
export type PrimeOwnershipAction =
  | {
      readonly kind:
        | "process-stopped"
        | "rpc-session-cleaned"
        | "heartbeat-stopped"
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
  /** Proves this exact heartbeat still exists and is the one T3 created. */
  readonly heartbeatMatches?: (id: string) => Promise<boolean>;
};
export type PrimeOwnedResource = {
  readonly path: string;
  readonly kind: "session" | "config" | "thread" | "daemon" | "ownership";
  readonly operationId: string;
  /** Exact identity proven immediately before delegation. Native implementations must act through an anchored handle with no-replace semantics. */
  readonly identity: { readonly dev: string; readonly ino: string };
};
export type PrimeOwnershipCleanup = {
  readonly stopProcess: (handle: PrimeProcessHandle, operationId?: string) => Promise<void>;
  readonly cleanupRpcSession?: (id: string, operationId?: string) => Promise<void>;
  readonly cleanupDaemonSession?: (id: string, operationId?: string) => Promise<void>;
  /** Stops one exact owned heartbeat. Never a delete-all or list-then-delete. */
  readonly cleanupHeartbeat?: (id: string, operationId?: string) => Promise<void>;
  /**
   * Optional platform-owned destructive boundary. The registry never renames or
   * unlinks a resource itself: Node pathname operations cannot close a hostile
   * parent-swap or destination-clobber race. Missing callbacks fail closed.
   */
  readonly removeOwnedResource?: (resource: PrimeOwnedResource) => Promise<"removed" | "retained">;
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
      "heartbeatIds",
      "processStopped",
      "rpcCleaned",
      "heartbeatsCleaned",
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
  for (const k of [
    "processStopped",
    "rpcCleaned",
    "heartbeatsCleaned",
    "daemonCleaned",
    "resourcesCleaned",
  ] as const)
    if (r[k] !== undefined && typeof r[k] !== "boolean") return false;
  // Bounded and exact: the canonical board caps owned heartbeats at eight, and
  // a duplicated or unrepresentable id would make cleanup ambiguous.
  if (r.heartbeatIds !== undefined) {
    if (!Array.isArray(r.heartbeatIds) || r.heartbeatIds.length > 8) return false;
    if (!r.heartbeatIds.every(validId)) return false;
    if (new Set(r.heartbeatIds as readonly string[]).size !== r.heartbeatIds.length) return false;
  }
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
type QuarantineKind = "ownership" | "resource" | "temp" | "superseded" | "lock";
type QuarantineHooks = {
  /** Test/platform hook after the exact inode is out of the active namespace. */
  readonly afterQuarantineRename?: (
    source: string,
    quarantine: string,
    kind: QuarantineKind,
  ) => Promise<void>;
};
type AtomicWriteHooks = QuarantineHooks & {
  readonly beforeTempOpen?: () => Promise<void>;
  readonly afterTempOpen?: () => Promise<void>;
  readonly beforePublish?: () => Promise<void>;
};

const atomicWriteBound = async (
  path: string,
  r: PrimeOwnershipRecord,
  chain: ChainIdentity,
  expectedTargetIdentity?: FileIdentity,
  hooks?: AtomicWriteHooks,
): Promise<FileIdentity> => {
  const targetMatches = async () => {
    if (!(await chainUnchanged(chain))) return false;
    try {
      const current = await lstat(path, { bigint: true });
      return expectedTargetIdentity !== undefined && sameIdentity(current, expectedTargetIdentity);
    } catch (e) {
      return expectedTargetIdentity === undefined && (e as NodeJS.ErrnoException).code === "ENOENT";
    }
  };
  if (!(await targetMatches())) throw Error("ownership target changed before atomic write");
  await hooks?.beforeTempOpen?.();
  if (!(await targetMatches())) throw Error("ownership namespace changed before temp creation");
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const h = await open(temp, "wx", 0o600);
  const opened = await h.stat({ bigint: true });
  const tempIdentity = { dev: opened.dev, ino: opened.ino };
  try {
    await hooks?.afterTempOpen?.();
    if (!(await boundFile(temp, chain, tempIdentity)))
      throw Error("ownership namespace changed after temp creation");
    await h.writeFile(`${JSON.stringify(r)}\n`);
    await h.sync();
  } finally {
    await h.close();
  }
  await hooks?.beforePublish?.();
  if (!(await boundFile(temp, chain, tempIdentity)) || !(await targetMatches()))
    throw Error("ownership namespace or target changed before atomic publish");

  let displaced: string | undefined;
  if (expectedTargetIdentity) {
    displaced = join(dirname(path), `.${basename(path)}.superseded-${randomUUID()}`);
    await guardedRenameToClaim(path, displaced, chain, expectedTargetIdentity);
    if (!(await boundFile(displaced, chain, expectedTargetIdentity)))
      throw Error("ownership target changed during update claim");
  }
  try {
    if (!(await boundFile(temp, chain, tempIdentity)))
      throw Error("ownership temp changed before no-clobber publish");
    await link(temp, path);
    if (!(await boundFile(path, chain, tempIdentity)))
      throw Error("ownership namespace changed during no-clobber publish");
    syncDir(dirname(path));
  } catch (e) {
    throw Error(`ownership no-clobber publish failed; retained recovery files: ${String(e)}`);
  }
  await quarantineThenDelete(temp, chain, tempIdentity, "temp", hooks?.afterQuarantineRename);
  if (displaced && expectedTargetIdentity)
    await quarantineThenDelete(
      displaced,
      chain,
      expectedTargetIdentity,
      "superseded",
      hooks?.afterQuarantineRename,
    );
  syncDir(dirname(path));
  return tempIdentity;
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
type FileIdentity = { readonly dev: bigint; readonly ino: bigint };
const sameIdentity = (a: FileIdentity, b: FileIdentity) => a.dev === b.dev && a.ino === b.ino;
const boundFile = async (path: string, chain: ChainIdentity, identity: FileIdentity) => {
  if (!(await chainUnchanged(chain))) return false;
  try {
    return sameIdentity(await lstat(path, { bigint: true }), identity);
  } catch {
    return false;
  }
};
const guardedRenameToClaim = async (
  source: string,
  claim: string,
  chain: ChainIdentity,
  sourceIdentity: FileIdentity,
  before?: () => Promise<void>,
) => {
  await before?.();
  if (!(await boundFile(source, chain, sourceIdentity)))
    throw Error("source namespace changed before destructive claim rename");
  await rename(source, claim);
  if (!(await boundFile(claim, chain, sourceIdentity)))
    throw Error("claim namespace changed during destructive claim rename");
  return sourceIdentity;
};
/**
 * Logical deletion for a hostile pathname namespace. Node cannot unlink an inode
 * through an anchored directory descriptor, so the proven inode is atomically
 * removed from its active name and retained under an unpredictable tombstone.
 */
const quarantineThenDelete = async (
  source: string,
  chain: ChainIdentity,
  sourceIdentity: FileIdentity,
  kind: QuarantineKind,
  hook?: QuarantineHooks["afterQuarantineRename"],
) => {
  if (!(await boundFile(source, chain, sourceIdentity)))
    throw Error(`${kind} source changed before quarantine rename`);
  const quarantine = join(
    dirname(source),
    `.${basename(source)}.quarantine-${kind}-${randomUUID()}`,
  );
  await rename(source, quarantine);
  if (!(await boundFile(quarantine, chain, sourceIdentity)))
    throw Error(`${kind} quarantine changed during rename; retained without deletion`);
  await hook?.(source, quarantine, kind);
  if (!(await boundFile(quarantine, chain, sourceIdentity)))
    throw Error(`${kind} quarantine changed after delete-window hook; retained without deletion`);
  syncDir(dirname(source));
  return quarantine;
};
export type PrimeOwnershipTransactionHooks = QuarantineHooks & {
  readonly beforeOwnershipRename?: (path: string, claim: string) => Promise<void>;
  readonly beforeResourceRename?: (path: string) => Promise<void>;
  readonly afterResourceRename?: (path: string, claim: string) => Promise<void>;
  readonly beforeProgressWrite?: (claim: string) => Promise<void>;
};
export type PrimeOwnershipRecoveryHooks = {
  readonly afterDirectoryRead?: (path: string) => Promise<void>;
  readonly beforeChild?: (path: string) => Promise<void>;
  readonly beforeClaimRestoreLink?: (claim: string, original: string) => Promise<void>;
};
const withLock = async <T>(
  path: string,
  fn: (chain: ChainIdentity) => Promise<T>,
  hooks?: QuarantineHooks,
): Promise<T> => {
  const lock = `${path}.lock`;
  const chain = await captureChain(dirname(lock));
  if (!(await chainUnchanged(chain)))
    throw Error("ownership namespace changed before lock creation");
  let h;
  try {
    h = await open(lock, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST")
      throw Error("ownership record is busy (cleanup lock held)");
    throw e;
  }
  const locked = await h.stat({ bigint: true });
  if (!(await boundFile(lock, chain, locked))) {
    await h.close();
    throw Error("ownership namespace changed during lock creation");
  }
  try {
    return await fn(chain);
  } finally {
    await h.close();
    try {
      await quarantineThenDelete(lock, chain, locked, "lock", hooks?.afterQuarantineRename);
    } catch {
      // The active lock is retained only when its namespace no longer proves
      // ownership. Never pathname-delete a possible replacement.
    }
  }
};
const validate = (path: string, r: PrimeOwnershipRecord, id: Identity) =>
  r.environmentId === id.environmentId &&
  r.instanceId === id.instanceId &&
  r.threadId === id.threadId &&
  (basename(path) === "daemon.json") === (r.kind === "daemon") &&
  (r.kind === "daemon" ? r.rpcSessionId === undefined : r.daemonSessionId === undefined);
/**
 * The one shape every thread ownership write uses.
 *
 * Each write replaces the record whole, so a site that forgets the owned
 * heartbeat ids does not just omit them — it erases the only handle that makes
 * a resident T3-created schedule stoppable later. Building the record in one
 * place is what keeps the process-exit write as exact as the create write.
 */
export const primeThreadOwnershipRecord = (input: {
  readonly environmentId: string;
  readonly instanceId: string;
  readonly threadId: string;
  readonly process: PrimeProcessHandle;
  readonly ownedHeartbeatIds: Iterable<string>;
  readonly processStopped?: boolean;
}): PrimeOwnershipRecord => {
  const heartbeatIds = [...input.ownedHeartbeatIds];
  return {
    version: PRIME_OWNERSHIP_VERSION,
    environmentId: input.environmentId,
    instanceId: input.instanceId,
    threadId: input.threadId,
    kind: "thread",
    process: input.process,
    ...(heartbeatIds.length > 0 ? { heartbeatIds } : {}),
    ...(input.processStopped === true ? { processStopped: true } : {}),
  };
};
export type PrimeOwnershipWriteHooks = AtomicWriteHooks;
export const writePrimeOwnership = async (
  path: string,
  record: PrimeOwnershipRecord,
  hooks?: PrimeOwnershipWriteHooks,
) => {
  const id = identify(path);
  if (!id || !isRecord(record) || !validate(path, record, id))
    throw Error("invalid or path-mismatched Prime ownership record");
  await validateChain(dirname(path), true);
  return withLock(
    path,
    async (chain) => {
      let expected: FileIdentity | undefined;
      try {
        const s = await lstat(path, { bigint: true });
        if (s.isSymbolicLink() || !s.isFile())
          throw Error("ownership target is not a regular file");
        expected = { dev: s.dev, ino: s.ino };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      await atomicWriteBound(
        path,
        {
          ...record,
          recordId: record.recordId ?? randomUUID(),
          operationId: record.operationId ?? randomUUID(),
        },
        chain,
        expected,
        hooks,
      );
    },
    hooks,
  );
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
const retainClaim = (claim: string, actions: PrimeOwnershipAction[], reason: string) => {
  actions.push(warning(claim, `${reason}; retained uniquely named claim for safe recovery`));
  return false;
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
  const claim = join(
    dirname(path),
    `.${basename(path)}.cleaning-resource-${primePathComponent(recordId)}-${randomUUID()}`,
  );
  try {
    await guardedRenameToClaim(
      path,
      claim,
      chain,
      before,
      () => hooks?.beforeResourceRename?.(path) ?? Promise.resolve(),
    );
  } catch (e) {
    actions.push(warning(path, `resource claim rename failed safely: ${String(e)}`));
    return false;
  }
  try {
    await hooks?.afterResourceRename?.(path, claim);
    if (!(await boundFile(claim, chain, before)))
      return retainClaim(claim, actions, "resource namespace changed after claim callback");
    const quarantine = await quarantineThenDelete(
      claim,
      chain,
      before,
      "resource",
      hooks?.afterQuarantineRename,
    );
    actions.push({ kind: "resource-removed", path });
    actions.push(
      warning(quarantine, "active resource removed; exact owned inode retained in quarantine"),
    );
    return true;
  } catch (e) {
    return retainClaim(claim, actions, `resource quarantine transaction failed: ${String(e)}`);
  }
};
export const unsafePathnameCleanupPrimeOwnershipForTests = async (
  path: string,
  proof: PrimeOwnershipProof,
  cleanup: PrimeOwnershipCleanup,
  hooks?: PrimeOwnershipTransactionHooks,
): Promise<readonly PrimeOwnershipAction[]> => {
  const id = identify(path);
  if (!id) throw Error("ownership path is outside exact Prime layout");
  await validateChain(dirname(path));
  try {
    return await withLock(
      path,
      async () => {
        const actions: PrimeOwnershipAction[] = [];
        const claim = `${path}.cleaning`;
        try {
          await lstat(claim);
          return [
            warning(path, "retained cleanup claim already exists; active record left intact"),
          ];
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        }
        const parentChain = await captureChain(dirname(path));
        let sourceIdentity: FileIdentity;
        try {
          sourceIdentity = await lstat(path, { bigint: true });
          await guardedRenameToClaim(
            path,
            claim,
            parentChain,
            sourceIdentity,
            () => hooks?.beforeOwnershipRename?.(path, claim) ?? Promise.resolve(),
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return actions;
          throw e;
        }
        let claimIdentity: FileIdentity | undefined = sourceIdentity;
        let retain = true;
        let protectedResourceChain: ChainIdentity | undefined;
        const claimStillBound = async () => {
          if (!(await chainUnchanged(parentChain))) return false;
          if (protectedResourceChain && !(await chainUnchanged(protectedResourceChain)))
            return false;
          try {
            const current = await lstat(claim, { bigint: true });
            return (
              claimIdentity === undefined ||
              (current.dev === claimIdentity.dev && current.ino === claimIdentity.ino)
            );
          } catch {
            return false;
          }
        };
        try {
          const claimed = await lstat(claim, { bigint: true });
          if (!sameIdentity(claimed, sourceIdentity) || !(await chainUnchanged(parentChain)))
            throw Error("ownership parent chain or claim changed after record claim rename");
          const s = claimed;
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
          const protectedResource = (r.kind ?? "thread") === "daemon" ? id.daemon : id.thread;
          try {
            protectedResourceChain = await captureChain(protectedResource);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
          }
          if (!(await claimStillBound()))
            throw Error(
              "ownership or resource namespace changed while binding cleanup transaction",
            );
          r = {
            ...r,
            recordId: r.recordId ?? randomUUID(),
            operationId: r.operationId ?? randomUUID(),
          };
          const persist = async (p: Partial<PrimeOwnershipRecord>) => {
            await hooks?.beforeProgressWrite?.(claim);
            if (!(await claimStillBound()))
              throw Error("ownership record namespace changed before cleanup progress write");
            const next = { ...r, ...p };
            claimIdentity = await atomicWriteBound(claim, next, parentChain, claimIdentity!);
            r = next;
            if (!(await claimStillBound()))
              throw Error("ownership record namespace changed during cleanup progress write");
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
            if (!(await claimStillBound())) {
              actions.push(
                warning(path, "ownership record namespace changed during process proof"),
              );
              return actions;
            }
            try {
              await cleanup.stopProcess(r.process, `${r.operationId}:process`);
            } catch (e) {
              actions.push(warning(path, `process stop threw: ${String(e)}`));
              return actions;
            }
            if (!(await claimStillBound())) {
              actions.push(warning(path, "ownership record namespace changed during process stop"));
              return actions;
            }
            await persist({ processStopped: true });
            actions.push({ kind: "process-stopped", path });
          }
          // Owned heartbeats are stopped before the session that hosts them, so
          // a schedule can never survive as an orphan pointing at a dead
          // session. Each id is proven individually and stopped individually:
          // there is no delete-all, and an id that cannot be proven leaves that
          // heartbeat — and every unowned one — completely alone.
          if (r.heartbeatIds?.length && !r.heartbeatsCleaned) {
            for (const heartbeatId of r.heartbeatIds) {
              let ok = false;
              try {
                ok = (await proof.heartbeatMatches?.(heartbeatId)) ?? false;
              } catch (e) {
                actions.push(warning(path, `heartbeat proof threw: ${String(e)}`));
                return actions;
              }
              if (!ok) {
                actions.push(warning(path, "heartbeat identity cannot be proven; left intact"));
                return actions;
              }
              if (!(await claimStillBound())) {
                actions.push(
                  warning(path, "ownership record namespace changed during heartbeat proof"),
                );
                return actions;
              }
              try {
                if (!cleanup.cleanupHeartbeat) throw Error("cleanup callback missing");
                await cleanup.cleanupHeartbeat(heartbeatId, `${r.operationId}:heartbeat`);
              } catch (e) {
                actions.push(warning(path, `heartbeat cleanup threw: ${String(e)}`));
                return actions;
              }
              if (!(await claimStillBound())) {
                actions.push(
                  warning(path, "ownership record namespace changed during heartbeat cleanup"),
                );
                return actions;
              }
              actions.push({ kind: "heartbeat-stopped", path });
            }
            await persist({ heartbeatsCleaned: true });
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
            if (!(await claimStillBound())) {
              actions.push(warning(path, "ownership record namespace changed during RPC proof"));
              return actions;
            }
            try {
              if (!cleanup.cleanupRpcSession) throw Error("cleanup callback missing");
              await cleanup.cleanupRpcSession(r.rpcSessionId, `${r.operationId}:rpc`);
            } catch (e) {
              actions.push(warning(path, `RPC cleanup threw: ${String(e)}`));
              return actions;
            }
            if (!(await claimStillBound())) {
              actions.push(warning(path, "ownership record namespace changed during RPC cleanup"));
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
            if (!(await claimStillBound())) {
              actions.push(warning(path, "ownership record namespace changed during daemon proof"));
              return actions;
            }
            try {
              if (!cleanup.cleanupDaemonSession) throw Error("cleanup callback missing");
              await cleanup.cleanupDaemonSession(r.daemonSessionId, `${r.operationId}:daemon`);
            } catch (e) {
              actions.push(warning(path, `daemon cleanup threw: ${String(e)}`));
              return actions;
            }
            if (!(await claimStillBound())) {
              actions.push(
                warning(path, "ownership record namespace changed during daemon cleanup"),
              );
              return actions;
            }
            await persist({ daemonCleaned: true });
            actions.push({ kind: "daemon-session-cleaned", path });
          }
          if (!r.resourcesCleaned) {
            if (!(await claimStillBound())) {
              actions.push(
                warning(path, "ownership record namespace changed before resource cleanup"),
              );
              return actions;
            }
            try {
              const cleaned =
                (r.kind ?? "thread") === "daemon"
                  ? await removeClaimed(id.daemon, r.recordId!, actions, hooks)
                  : (await removeClaimed(
                      join(id.thread, "session"),
                      r.recordId!,
                      actions,
                      hooks,
                    )) &&
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
            protectedResourceChain = undefined;
            await persist({ resourcesCleaned: true });
          }
          if (!(await claimStillBound())) {
            actions.push(warning(path, "ownership record namespace changed before record removal"));
            return actions;
          }
          const quarantine = await quarantineThenDelete(
            claim,
            parentChain,
            claimIdentity!,
            "ownership",
            hooks?.afterQuarantineRename,
          );
          retain = false;
          actions.push({ kind: "record-removed", path });
          actions.push(
            warning(
              quarantine,
              "active ownership record removed; exact inode retained in quarantine",
            ),
          );
          return actions;
        } finally {
          if (retain)
            retainClaim(
              claim,
              actions,
              "claimed ownership record retained without overwriting replacement",
            );
        }
      },
      hooks,
    );
  } catch (e) {
    return [warning(path, String(e))];
  }
};

const delegatedIdentity = async (path: string, chain: ChainIdentity) => {
  if (!(await chainUnchanged(chain))) return;
  try {
    const value = await lstat(path, { bigint: true });
    if (value.isSymbolicLink()) return;
    return { value, identity: { dev: String(value.dev), ino: String(value.ino) } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/**
 * Proves ownership and delegates destructive filesystem work. It deliberately
 * does not rename, quarantine, unlink, or rewrite the record during cleanup.
 * A later platform storage implementation can use openat2/RENAME_NOREPLACE (or
 * an equivalent anchored native primitive); the portable default warns and
 * retains every pathname.
 */
export const cleanupPrimeOwnership = async (
  path: string,
  proof: PrimeOwnershipProof,
  cleanup: PrimeOwnershipCleanup,
  _hooks?: PrimeOwnershipTransactionHooks,
): Promise<readonly PrimeOwnershipAction[]> => {
  const id = identify(path);
  if (!id) throw Error("ownership path is outside exact Prime layout");
  const actions: PrimeOwnershipAction[] = [];
  let chain: ChainIdentity;
  try {
    chain = await captureChain(dirname(path));
    const bound = await delegatedIdentity(path, chain);
    if (bound === null) return actions;
    if (!bound || !bound.value.isFile())
      return [warning(path, "ownership record is not a bound regular file; retained")];
    const decoded = decode(await readFile(path, "utf8"));
    if (!decoded.record) return [warning(path, decoded.reason!)];
    const record = decoded.record;
    if (!validate(path, record, id))
      return [warning(path, "ownership identity does not match its exact layout path; retained")];
    if (!(await boundFile(path, chain, bound.value)))
      return [warning(path, "ownership record changed while reading; retained")];
    const operationId = record.operationId ?? `legacy-${record.recordId ?? "record"}`;
    if (!cleanup.removeOwnedResource) {
      actions.push(
        warning(
          path,
          "destructive filesystem callback unavailable; no cleanup effects ran and owned resources plus active ownership record were retained",
        ),
      );
      return actions;
    }

    if (record.process && !record.processStopped) {
      if (!(await proof.processMatches(record.process)))
        return [warning(path, "captured process PID/start token cannot be proven; retained")];
      if (!(await boundFile(path, chain, bound.value)))
        return [warning(path, "ownership record changed during process proof; retained")];
      await cleanup.stopProcess(record.process, `${operationId}:process`);
      actions.push({ kind: "process-stopped", path });
    }
    if (record.heartbeatIds?.length && !record.heartbeatsCleaned) {
      for (const heartbeatId of record.heartbeatIds) {
        if (!(await proof.heartbeatMatches?.(heartbeatId)))
          return [...actions, warning(path, "heartbeat identity cannot be proven; retained")];
        if (!cleanup.cleanupHeartbeat)
          return [...actions, warning(path, "heartbeat cleanup callback missing; retained")];
        if (!(await boundFile(path, chain, bound.value)))
          return [
            ...actions,
            warning(path, "ownership record changed during heartbeat proof; retained"),
          ];
        await cleanup.cleanupHeartbeat(heartbeatId, `${operationId}:heartbeat`);
        actions.push({ kind: "heartbeat-stopped", path });
      }
    }
    if (record.rpcSessionId && !record.rpcCleaned) {
      if (!(await proof.rpcSessionMatches?.(record.rpcSessionId)))
        return [...actions, warning(path, "RPC identity cannot be proven; retained")];
      if (!cleanup.cleanupRpcSession)
        return [...actions, warning(path, "RPC cleanup callback missing; retained")];
      if (!(await boundFile(path, chain, bound.value)))
        return [...actions, warning(path, "ownership record changed during RPC proof; retained")];
      await cleanup.cleanupRpcSession(record.rpcSessionId, `${operationId}:rpc`);
      actions.push({ kind: "rpc-session-cleaned", path });
    }
    if (record.daemonSessionId && !record.daemonCleaned) {
      if (!(await proof.daemonSessionMatches?.(record.daemonSessionId)))
        return [...actions, warning(path, "daemon identity cannot be proven; retained")];
      if (!cleanup.cleanupDaemonSession)
        return [...actions, warning(path, "daemon cleanup callback missing; retained")];
      if (!(await boundFile(path, chain, bound.value)))
        return [
          ...actions,
          warning(path, "ownership record changed during daemon proof; retained"),
        ];
      await cleanup.cleanupDaemonSession(record.daemonSessionId, `${operationId}:daemon`);
      actions.push({ kind: "daemon-session-cleaned", path });
    }

    const resources: readonly [string, PrimeOwnedResource["kind"]][] =
      (record.kind ?? "thread") === "daemon"
        ? [[id.daemon, "daemon"]]
        : [
            [join(id.thread, "session"), "session"],
            [join(id.thread, "config.json"), "config"],
            [id.thread, "thread"],
          ];
    for (const [resourcePath, kind] of resources) {
      const resourceChain = await captureChain(dirname(resourcePath));
      const resource = await delegatedIdentity(resourcePath, resourceChain);
      if (resource === null) continue;
      if (!resource)
        return [
          ...actions,
          warning(resourcePath, "resource ancestry or identity cannot be proven; retained"),
        ];
      const result = await cleanup.removeOwnedResource({
        path: resourcePath,
        kind,
        operationId: `${operationId}:resource:${kind}`,
        identity: resource.identity,
      });
      if (result !== "removed")
        return [...actions, warning(resourcePath, "platform cleanup retained owned resource")];
      actions.push({ kind: "resource-removed", path: resourcePath });
    }
    if (!(await boundFile(path, chain, bound.value)))
      return [
        ...actions,
        warning(path, "ownership record changed before delegated removal; retained"),
      ];
    const removed = await cleanup.removeOwnedResource({
      path,
      kind: "ownership",
      operationId: `${operationId}:ownership`,
      identity: bound.identity,
    });
    if (removed === "removed") actions.push({ kind: "record-removed", path });
    else actions.push(warning(path, "platform cleanup retained active ownership record"));
    return actions;
  } catch (error) {
    return [...actions, warning(path, `delegated cleanup failed closed: ${String(error)}`)];
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
  const relativeParts = relative(expectedRoot, claim).split(sep);
  const instancesAt = relativeParts.indexOf("instances");
  if (instancesAt < 0 || !relativeParts[instancesAt + 1]) {
    actions.push(warning(claim, "retained unbound resource claim outside an instance"));
    return true;
  }
  // A recovery scan cannot prove that a source-derived resource pathname still
  // belongs to the namespace that created the claim. Quarantine is preferable
  // to restoring through a pathname whose ancestry may have been replaced.
  actions.push(
    warning(
      claim,
      "retained uniquely named directory claim/resource claim because recovery namespace identity is uncertain",
    ),
  );
  return true;
};

const recoverPrimeOwnershipImpl = async (
  root: string,
  proof: PrimeOwnershipProof,
  cleanup: PrimeOwnershipCleanup,
  hooks: PrimeOwnershipRecoveryHooks | undefined,
  cleanRecord: typeof cleanupPrimeOwnership,
  scope?: { readonly environmentId: string; readonly instanceId: string },
): Promise<readonly PrimeOwnershipAction[]> => {
  const expected = resolve(root);
  if (
    basename(expected) !== "v1" ||
    basename(dirname(expected)) !== "prime" ||
    basename(dirname(dirname(expected))) !== "userdata"
  )
    throw Error("recovery root is not exact Prime layout");
  const rootChain = await captureChain(expected);
  const actions: PrimeOwnershipAction[] = [];
  const visit = async (dir: string, chain: ChainIdentity): Promise<void> => {
    if (!(await chainUnchanged(rootChain)) || !(await chainUnchanged(chain))) {
      actions.push(warning(dir, "recovery directory ancestry changed; subtree retained"));
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
      await hooks?.afterDirectoryRead?.(dir);
      if (!(await chainUnchanged(rootChain)) || !(await chainUnchanged(chain)))
        throw Error("directory ancestry changed during enumeration");
    } catch (error) {
      actions.push(warning(dir, `recovery directory retained safely: ${String(error)}`));
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      try {
        await hooks?.beforeChild?.(p);
        if (!(await chainUnchanged(rootChain)) || !(await chainUnchanged(chain)))
          throw Error("directory ancestry changed before child processing");
        const child = await lstat(p, { bigint: true });
        if (child.isSymbolicLink()) {
          actions.push(warning(p, "symlink skipped during recovery"));
          continue;
        }
        if (e.name.includes(".cleaning-resource-") && (child.isFile() || child.isDirectory())) {
          await recoverResourceClaim(p, expected, actions);
        } else if (child.isDirectory()) {
          const childChain = [...chain, { path: p, dev: child.dev, ino: child.ino }];
          if (!(await chainUnchanged(childChain)))
            throw Error("child directory identity changed after enumeration");
          await visit(p, childChain);
        } else if (child.isFile() && e.name.endsWith(".json") && identify(p)?.root === expected) {
          const identity = identify(p);
          if (
            scope &&
            (identity?.environmentId !== scope.environmentId ||
              identity.instanceId !== scope.instanceId)
          )
            continue;
          const check = await lstat(p, { bigint: true });
          if (check.dev !== child.dev || check.ino !== child.ino || !(await chainUnchanged(chain)))
            throw Error("ownership record identity changed after enumeration");
          try {
            actions.push(...(await cleanRecord(p, proof, cleanup)));
          } catch (error) {
            actions.push(warning(p, `record cleanup threw: ${String(error)}`));
          }
        } else if (
          child.isFile() &&
          e.name.endsWith(".json.cleaning") &&
          identify(p)?.root === expected
        ) {
          retainClaim(
            p,
            actions,
            "recovered interrupted cleanup claim without clobbering active record",
          );
        } else if (e.name.includes(".quarantine-") && (child.isFile() || child.isDirectory()))
          actions.push(
            warning(p, "retained exact-inode quarantine; active namespace is already clear"),
          );
        else if (child.isFile() && e.name.includes(".tmp"))
          actions.push(warning(p, "incomplete atomic write retained for inspection"));
      } catch (error) {
        actions.push(warning(p, `recovery child retained safely: ${String(error)}`));
      }
    }
  };
  await visit(expected, rootChain);
  return actions;
};

export const recoverPrimeOwnership = (
  root: string,
  proof: PrimeOwnershipProof,
  cleanup: PrimeOwnershipCleanup,
  hooks?: PrimeOwnershipRecoveryHooks,
) => recoverPrimeOwnershipImpl(root, proof, cleanup, hooks, cleanupPrimeOwnership);
/** Recovers only records for one exact environment/instance while retaining all siblings. */
export const recoverPrimeInstanceOwnership = (
  root: string,
  scope: { readonly environmentId: string; readonly instanceId: string },
  proof: PrimeOwnershipProof,
  cleanup: PrimeOwnershipCleanup,
  hooks?: PrimeOwnershipRecoveryHooks,
) => recoverPrimeOwnershipImpl(root, proof, cleanup, hooks, cleanupPrimeOwnership, scope);

export const unsafePathnameRecoverPrimeOwnershipForTests = (
  root: string,
  proof: PrimeOwnershipProof,
  cleanup: PrimeOwnershipCleanup,
  hooks?: PrimeOwnershipRecoveryHooks,
) =>
  recoverPrimeOwnershipImpl(
    root,
    proof,
    cleanup,
    hooks,
    unsafePathnameCleanupPrimeOwnershipForTests,
  );
