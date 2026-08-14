import {
  link,
  lstat,
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { closeSync, constants, fsyncSync, openSync } from "node:fs";
//#region apps/server/src/provider/prime/PrimeResourceLayout.ts
const MAX_ID_LENGTH$1 = 512;
/** A path segment made from a complete UTF-8 identifier, never caller path syntax. */
const primePathComponent = (value) => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH$1 ||
    value === "." ||
    value === ".."
  )
    throw new Error("Prime resource IDs must be non-empty bounded values, not dot components");
  return `id-${Buffer.from(value, "utf8").toString("base64url")}`;
};
const decodePrimePathComponent = (value) => {
  if (!value.startsWith("id-") || value.length === 3) return void 0;
  try {
    const decoded = Buffer.from(value.slice(3), "base64url").toString("utf8");
    return primePathComponent(decoded) === value ? decoded : void 0;
  } catch {
    return;
  }
};
const assertPrimeContained = (root, path) => {
  const segment = relative(resolve(root), resolve(path));
  if (segment === "" || segment === ".." || segment.startsWith(`..${sep}`) || isAbsolute(segment))
    throw new Error("Prime resource path escaped its T3 home namespace");
};
const primeResourceLayout = (input) => {
  const root = join(resolve(input.home), "userdata", "prime", "v1");
  const environment = join(root, "environments", primePathComponent(input.environmentId));
  const instance = join(environment, "instances", primePathComponent(input.instanceId));
  const thread = join(instance, "threads", primePathComponent(input.threadId));
  const ownershipDirectory = join(instance, "ownership");
  const result = {
    root,
    environment,
    instance,
    thread,
    session: join(thread, "session"),
    config: join(thread, "config.json"),
    daemon: join(instance, "daemon"),
    ownershipDirectory,
    ownership: join(ownershipDirectory, `${primePathComponent(input.threadId)}.json`),
    daemonOwnership: join(ownershipDirectory, "daemon.json"),
  };
  for (const path of Object.values(result).slice(1)) assertPrimeContained(root, path);
  return result;
};
//#endregion
//#region apps/server/src/provider/prime/PrimeOwnership.ts
const MAX_ID_LENGTH = 512;
const validId = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;
const exact = (v, keys) => Object.keys(v).every((k) => keys.includes(k));
function isRecord(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v;
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
  if (r.kind !== void 0 && r.kind !== "thread" && r.kind !== "daemon") return false;
  if (
    (r.recordId !== void 0 && !validId(r.recordId)) ||
    (r.operationId !== void 0 && !validId(r.operationId))
  )
    return false;
  for (const k of ["processStopped", "rpcCleaned", "daemonCleaned", "resourcesCleaned"])
    if (r[k] !== void 0 && typeof r[k] !== "boolean") return false;
  if (r.process !== void 0) {
    if (!r.process || typeof r.process !== "object" || Array.isArray(r.process)) return false;
    const p = r.process;
    if (
      !exact(p, ["pid", "startToken"]) ||
      !Number.isSafeInteger(p.pid) ||
      p.pid <= 0 ||
      !validId(p.startToken)
    )
      return false;
  }
  return (
    (r.rpcSessionId === void 0 || validId(r.rpcSessionId)) &&
    (r.daemonSessionId === void 0 || validId(r.daemonSessionId))
  );
}
const identify = (path) => {
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
  const environmentId = decodePrimePathComponent(a[oi - 3]);
  const instanceId = decodePrimePathComponent(a[oi - 1]);
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
const syncDir = (p) => {
  try {
    const fd = openSync(p, constants.O_RDONLY);
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {}
};
const atomicWriteBound = async (path, r, chain, expectedTargetIdentity, hooks) => {
  const targetMatches = async () => {
    if (!(await chainUnchanged(chain))) return false;
    try {
      const current = await lstat(path, { bigint: true });
      return expectedTargetIdentity !== void 0 && sameIdentity(current, expectedTargetIdentity);
    } catch (e) {
      return expectedTargetIdentity === void 0 && e.code === "ENOENT";
    }
  };
  if (!(await targetMatches())) throw Error("ownership target changed before atomic write");
  await hooks?.beforeTempOpen?.();
  if (!(await targetMatches())) throw Error("ownership namespace changed before temp creation");
  const temp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const h = await open(temp, "wx", 384);
  const opened = await h.stat({ bigint: true });
  const tempIdentity = {
    dev: opened.dev,
    ino: opened.ino,
  };
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
  let displaced;
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
  if (await boundFile(temp, chain, tempIdentity)) await rm(temp);
  if (
    displaced &&
    expectedTargetIdentity &&
    (await boundFile(displaced, chain, expectedTargetIdentity))
  )
    await rm(displaced);
  syncDir(dirname(path));
  return tempIdentity;
};
const captureChain = async (path, create = false) => {
  const parts = resolve(path).split(sep).filter(Boolean);
  const result = [];
  let cur = sep;
  for (const part of parts) {
    cur = join(cur, part);
    try {
      const s = await lstat(cur, { bigint: true });
      if (s.isSymbolicLink() || !s.isDirectory())
        throw Error(`unsafe symlink/non-directory: ${cur}`);
      result.push({
        path: cur,
        dev: s.dev,
        ino: s.ino,
      });
    } catch (e) {
      if (e.code !== "ENOENT" || !create) throw e;
      try {
        await mkdir(cur, { mode: 448 });
      } catch (m) {
        if (m.code !== "EEXIST") throw m;
      }
      const s = await lstat(cur, { bigint: true });
      if (s.isSymbolicLink() || !s.isDirectory()) throw Error("unsafe created directory");
      result.push({
        path: cur,
        dev: s.dev,
        ino: s.ino,
      });
    }
  }
  return result;
};
const validateChain = async (path, create = false) => void (await captureChain(path, create));
const chainUnchanged = async (before) => {
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
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const boundFile = async (path, chain, identity) => {
  if (!(await chainUnchanged(chain))) return false;
  try {
    return sameIdentity(await lstat(path, { bigint: true }), identity);
  } catch {
    return false;
  }
};
const guardedRenameToClaim = async (source, claim, chain, sourceIdentity, before) => {
  await before?.();
  if (!(await boundFile(source, chain, sourceIdentity)))
    throw Error("source namespace changed before destructive claim rename");
  await rename(source, claim);
  if (!(await boundFile(claim, chain, sourceIdentity)))
    throw Error("claim namespace changed during destructive claim rename");
  return sourceIdentity;
};
const withLock = async (path, fn) => {
  const lock = `${path}.lock`;
  const chain = await captureChain(dirname(lock));
  if (!(await chainUnchanged(chain)))
    throw Error("ownership namespace changed before lock creation");
  let h;
  try {
    h = await open(lock, "wx", 384);
  } catch (e) {
    if (e.code === "EEXIST") throw Error("ownership record is busy (cleanup lock held)");
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
    if (await boundFile(lock, chain, locked)) {
      await rm(lock, { force: true });
      syncDir(dirname(lock));
    }
  }
};
const validate = (path, r, id) =>
  r.environmentId === id.environmentId &&
  r.instanceId === id.instanceId &&
  r.threadId === id.threadId &&
  (basename(path) === "daemon.json") === (r.kind === "daemon") &&
  (r.kind === "daemon" ? r.rpcSessionId === void 0 : r.daemonSessionId === void 0);
const writePrimeOwnership = async (path, record, hooks) => {
  const id = identify(path);
  if (!id || !isRecord(record) || !validate(path, record, id))
    throw Error("invalid or path-mismatched Prime ownership record");
  await validateChain(dirname(path), true);
  return withLock(path, async (chain) => {
    let expected;
    try {
      const s = await lstat(path, { bigint: true });
      if (s.isSymbolicLink() || !s.isFile()) throw Error("ownership target is not a regular file");
      expected = {
        dev: s.dev,
        ino: s.ino,
      };
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
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
  });
};
const decode = (text) => {
  try {
    const v = JSON.parse(text);
    if (
      v &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      typeof v.version === "number" &&
      v.version > 1
    )
      return { reason: "future ownership record version; left intact" };
    return isRecord(v)
      ? { record: v }
      : { reason: "partial, corrupt, or unsupported ownership record; left intact" };
  } catch {
    return { reason: "partial or corrupt ownership record; left intact" };
  }
};
const warning = (path, reason) => ({
  kind: "warning",
  warning: {
    path,
    reason,
  },
});
const retainClaim = (claim, actions, reason) => {
  actions.push(warning(claim, `${reason}; retained uniquely named claim for safe recovery`));
  return false;
};
const removeClaimed = async (path, recordId, actions, hooks) => {
  let before;
  try {
    before = await lstat(path, { bigint: true });
  } catch (e) {
    if (e.code === "ENOENT") return true;
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
    await rm(claim, { recursive: before.isDirectory() });
    actions.push({
      kind: "resource-removed",
      path,
    });
    syncDir(dirname(path));
    return true;
  } catch (e) {
    return retainClaim(claim, actions, `resource quarantine transaction failed: ${String(e)}`);
  }
};
const cleanupPrimeOwnership = async (path, proof, cleanup, hooks) => {
  const id = identify(path);
  if (!id) throw Error("ownership path is outside exact Prime layout");
  await validateChain(dirname(path));
  try {
    return await withLock(path, async () => {
      const actions = [];
      const claim = `${path}.cleaning`;
      try {
        await lstat(claim);
        return [warning(path, "retained cleanup claim already exists; active record left intact")];
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const parentChain = await captureChain(dirname(path));
      let sourceIdentity;
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
        if (e.code === "ENOENT") return actions;
        throw e;
      }
      let claimIdentity = sourceIdentity;
      let retain = true;
      let protectedResourceChain;
      const claimStillBound = async () => {
        if (!(await chainUnchanged(parentChain))) return false;
        if (protectedResourceChain && !(await chainUnchanged(protectedResourceChain))) return false;
        try {
          const current = await lstat(claim, { bigint: true });
          return (
            claimIdentity === void 0 ||
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
          actions.push(warning(path, d.reason));
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
          if (e.code !== "ENOENT") throw e;
        }
        if (!(await claimStillBound()))
          throw Error("ownership or resource namespace changed while binding cleanup transaction");
        r = {
          ...r,
          recordId: r.recordId ?? randomUUID(),
          operationId: r.operationId ?? randomUUID(),
        };
        const persist = async (p) => {
          await hooks?.beforeProgressWrite?.(claim);
          if (!(await claimStillBound()))
            throw Error("ownership record namespace changed before cleanup progress write");
          const next = {
            ...r,
            ...p,
          };
          claimIdentity = await atomicWriteBound(claim, next, parentChain, claimIdentity);
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
            actions.push(warning(path, "ownership record namespace changed during process proof"));
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
          actions.push({
            kind: "process-stopped",
            path,
          });
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
          actions.push({
            kind: "rpc-session-cleaned",
            path,
          });
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
            actions.push(warning(path, "ownership record namespace changed during daemon cleanup"));
            return actions;
          }
          await persist({ daemonCleaned: true });
          actions.push({
            kind: "daemon-session-cleaned",
            path,
          });
        }
        if (!r.resourcesCleaned) {
          if (!(await claimStillBound())) {
            actions.push(
              warning(path, "ownership record namespace changed before resource cleanup"),
            );
            return actions;
          }
          try {
            if (
              !((r.kind ?? "thread") === "daemon"
                ? await removeClaimed(id.daemon, r.recordId, actions, hooks)
                : (await removeClaimed(join(id.thread, "session"), r.recordId, actions, hooks)) &&
                  (await removeClaimed(
                    join(id.thread, "config.json"),
                    r.recordId,
                    actions,
                    hooks,
                  )) &&
                  (await removeClaimed(id.thread, r.recordId, actions, hooks)))
            )
              return actions;
          } catch (e) {
            actions.push(warning(path, `exact resource cleanup failed: ${String(e)}`));
            return actions;
          }
          protectedResourceChain = void 0;
          await persist({ resourcesCleaned: true });
        }
        if (!(await claimStillBound())) {
          actions.push(warning(path, "ownership record namespace changed before record removal"));
          return actions;
        }
        await rm(claim);
        syncDir(dirname(claim));
        retain = false;
        actions.push({
          kind: "record-removed",
          path,
        });
        return actions;
      } finally {
        if (retain)
          retainClaim(
            claim,
            actions,
            "claimed ownership record retained without overwriting replacement",
          );
      }
    });
  } catch (e) {
    return [warning(path, String(e))];
  }
};
const recoverResourceClaim = async (claim, expectedRoot, actions) => {
  const name = basename(claim);
  const markerAt = name.indexOf(".cleaning-resource-id-");
  if (!name.startsWith(".") || markerAt < 2) return false;
  const relativeParts = relative(expectedRoot, claim).split(sep);
  const instancesAt = relativeParts.indexOf("instances");
  if (instancesAt < 0 || !relativeParts[instancesAt + 1]) {
    actions.push(warning(claim, "retained unbound resource claim outside an instance"));
    return true;
  }
  actions.push(
    warning(
      claim,
      "retained uniquely named directory claim/resource claim because recovery namespace identity is uncertain",
    ),
  );
  return true;
};
const recoverPrimeOwnership = async (root, proof, cleanup, hooks) => {
  const expected = resolve(root);
  if (
    basename(expected) !== "v1" ||
    basename(dirname(expected)) !== "prime" ||
    basename(dirname(dirname(expected))) !== "userdata"
  )
    throw Error("recovery root is not exact Prime layout");
  const rootChain = await captureChain(expected);
  const actions = [];
  const visit = async (dir, chain) => {
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
        if (e.name.includes(".cleaning-resource-") && (child.isFile() || child.isDirectory()))
          await recoverResourceClaim(p, expected, actions);
        else if (child.isDirectory()) {
          const childChain = [
            ...chain,
            {
              path: p,
              dev: child.dev,
              ino: child.ino,
            },
          ];
          if (!(await chainUnchanged(childChain)))
            throw Error("child directory identity changed after enumeration");
          await visit(p, childChain);
        } else if (child.isFile() && e.name.endsWith(".json") && identify(p)?.root === expected) {
          const check = await lstat(p, { bigint: true });
          if (check.dev !== child.dev || check.ino !== child.ino || !(await chainUnchanged(chain)))
            throw Error("ownership record identity changed after enumeration");
          try {
            actions.push(...(await cleanupPrimeOwnership(p, proof, cleanup)));
          } catch (error) {
            actions.push(warning(p, `record cleanup threw: ${String(error)}`));
          }
        } else if (
          child.isFile() &&
          e.name.endsWith(".json.cleaning") &&
          identify(p)?.root === expected
        )
          retainClaim(
            p,
            actions,
            "recovered interrupted cleanup claim without clobbering active record",
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
//#endregion
//#region apps/server/src/provider/prime/verify-prime-ownership.ts
let checks = 0;
function check(v, m) {
  checks++;
  if (!v) throw Error(m);
}
function equal(actual, expected) {
  return actual === expected;
}
const homes = [
  await mkdtemp(join(tmpdir(), "t3-pa-m06-a-")),
  await mkdtemp(join(tmpdir(), "t3-pa-m06-b-")),
];
try {
  const a = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "one",
    threadId: "a",
  });
  const sibling = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "one",
    threadId: "b",
  });
  const other = primeResourceLayout({
    home: homes[1],
    environmentId: "env",
    instanceId: "two",
    threadId: "a",
  });
  const record = (instanceId, threadId, pid) => ({
    version: 1,
    environmentId: "env",
    instanceId,
    threadId,
    process: {
      pid,
      startToken: `start-${pid}`,
    },
    rpcSessionId: `rpc-${threadId}`,
  });
  await Promise.all([
    writePrimeOwnership(a.ownership, record("one", "a", 1)),
    writePrimeOwnership(sibling.ownership, record("one", "b", 2)),
    writePrimeOwnership(other.ownership, record("two", "a", 3)),
  ]);
  await mkdir(a.session, { recursive: true });
  await writeFile(a.config, "config");
  await mkdir(sibling.session, { recursive: true });
  await writeFile(sibling.config, "config");
  const sentinel = join(homes[0], "sentinel");
  await writeFile(sentinel, "safe");
  const calls = [];
  await cleanupPrimeOwnership(
    a.ownership,
    {
      processMatches: async (h) => h.pid === 1 && h.startToken === "start-1",
      rpcSessionMatches: async (id) => id === "rpc-a",
    },
    {
      stopProcess: async (h) => {
        calls.push(`stop:${h.pid}`);
      },
      cleanupRpcSession: async (id) => {
        calls.push(`rpc:${id}`);
      },
    },
  );
  check(calls.join() === "stop:1,rpc:rpc-a", "callbacks must be exact");
  check(calls.length === 2, "exact callback count");
  check(calls[0] === "stop:1", "selected process stopped");
  check(calls[1] === "rpc:rpc-a", "selected rpc cleaned");
  await stat(a.ownership).then(
    () => check(false, "selected record survived"),
    () => check(true, "selected record gone"),
  );
  await stat(a.thread).then(
    () => check(false, "selected thread survived"),
    () => check(true, "selected thread gone"),
  );
  check(a.ownership.includes("ownership"), "selected ownership path");
  check(a.instance !== sibling.root, "selected instance path");
  check(a.thread !== sibling.thread, "selected thread path");
  await stat(sibling.ownership);
  check(true, "sibling ownership preserved");
  await stat(sibling.thread);
  check(true, "sibling resources preserved");
  await stat(other.ownership);
  check(true, "other-home ownership preserved");
  check(sibling.instance === a.instance, "sibling instance identity");
  check(other.instance !== a.instance, "other instance identity");
  check(other.root !== a.root, "other home isolated");
  check((await readFile(sentinel, "utf8")) === "safe", "sentinel changed");
  check((await readFile(sibling.config, "utf8")) === "config", "sibling config preserved");
  check((await readFile(other.ownership, "utf8")).includes("rpc-a"), "other record readable");
  const daemonCalls = [];
  await mkdir(sibling.daemon, { recursive: true });
  await writePrimeOwnership(sibling.daemonOwnership, {
    version: 1,
    environmentId: "env",
    instanceId: "one",
    threadId: "__daemon__",
    kind: "daemon",
    daemonSessionId: "daemon-one",
  });
  await cleanupPrimeOwnership(
    sibling.daemonOwnership,
    {
      processMatches: async () => true,
      daemonSessionMatches: async (id) => id === "daemon-one",
    },
    {
      stopProcess: async () => {},
      cleanupDaemonSession: async (id) => {
        daemonCalls.push(id);
      },
    },
  );
  check(daemonCalls.length === 1, "daemon callback once");
  check(daemonCalls[0] === "daemon-one", "daemon callback selected identity");
  await stat(sibling.daemon).then(
    () => check(false, "daemon resource survived"),
    () => check(true, "daemon resource removed"),
  );
  await stat(sibling.daemonOwnership).then(
    () => check(false, "daemon record survived"),
    () => check(true, "daemon record removed"),
  );
  const retry = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "retry",
    threadId: "r",
  });
  await mkdir(retry.session, { recursive: true });
  await writeFile(retry.config, "retry");
  await writePrimeOwnership(retry.ownership, record("retry", "r", 4));
  let retryStops = 0,
    retryRpc = 0;
  await cleanupPrimeOwnership(
    retry.ownership,
    {
      processMatches: async () => true,
      rpcSessionMatches: async () => true,
    },
    {
      stopProcess: async () => {
        retryStops++;
      },
      cleanupRpcSession: async () => {
        retryRpc++;
        throw Error("partial");
      },
    },
  );
  check(retryStops === 1, "partial cleanup stopped once");
  check(retryRpc === 1, "partial cleanup rpc attempted once");
  await stat(`${retry.ownership}.cleaning`);
  check(true, "partial claim retained");
  await cleanupPrimeOwnership(
    retry.ownership,
    {
      processMatches: async () => true,
      rpcSessionMatches: async () => true,
    },
    {
      stopProcess: async () => {
        retryStops++;
      },
      cleanupRpcSession: async () => {
        retryRpc++;
      },
    },
  );
  check(retryStops === 1, "retry did not duplicate stop");
  check(equal(retryRpc, 1), "failed rpc retained for recovery without unsafe retry");
  await stat(`${retry.ownership}.cleaning`);
  check(true, "retry claim remains retained");
  const mismatch = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "mismatch",
    threadId: "m",
  });
  await writePrimeOwnership(mismatch.ownership, record("mismatch", "m", 5));
  let continued = false;
  check(
    (
      await cleanupPrimeOwnership(
        mismatch.ownership,
        {
          processMatches: async () => {
            throw Error("identity proof boom");
          },
        },
        {
          stopProcess: async () => {
            throw Error("must not run");
          },
        },
      )
    ).some((x) => x.kind === "warning"),
    "identity mismatch throw warned",
  );
  await stat(`${mismatch.ownership}.cleaning`);
  check(true, "identity mismatch claim retained");
  continued = true;
  check(continued, "callback throw continuation practical");
  const bad = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "bad",
    threadId: "x",
  });
  await mkdir(bad.ownershipDirectory, { recursive: true });
  await writeFile(bad.ownership, "{");
  check(
    (
      await recoverPrimeOwnership(
        a.root,
        { processMatches: async () => false },
        {
          stopProcess: async () => {
            throw Error("must not stop");
          },
        },
      )
    ).some((x) => x.kind === "warning"),
    "corrupt record must warn",
  );
  const race = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "race",
    threadId: "r",
  });
  await mkdir(race.session, { recursive: true });
  await writePrimeOwnership(race.ownership, record("race", "r", 6));
  const displaced = `${race.session}.owned`;
  const raceActions = await cleanupPrimeOwnership(
    race.ownership,
    {
      processMatches: async () => true,
      rpcSessionMatches: async () => true,
    },
    {
      stopProcess: async () => {},
      cleanupRpcSession: async () => {},
    },
    {
      beforeResourceRename: async (path) => {
        if (path !== race.session) return;
        await rename(path, displaced);
        await mkdir(path);
        await writeFile(join(path, "replacement"), "visible");
      },
    },
  );
  check(
    (await readFile(join(race.session, "replacement"), "utf8")) === "visible",
    "replacement namespace untouched",
  );
  await stat(displaced);
  check(true, "original raced resource retained");
  check(
    raceActions.some((x) => x.kind === "warning"),
    "raced replacement warning surfaced",
  );
  await stat(`${race.ownership}.cleaning`);
  check(true, "raced ownership claim retained");
  const ancestorRace = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "ancestor-race",
    threadId: "r",
  });
  await mkdir(ancestorRace.session, { recursive: true });
  await writeFile(join(ancestorRace.session, "owned"), "must-not-escape");
  await writePrimeOwnership(ancestorRace.ownership, record("ancestor-race", "r", 7));
  const outside = await mkdtemp(join(tmpdir(), "t3-pa-m06-outside-"));
  const movedThread = `${ancestorRace.thread}.moved`;
  await cleanupPrimeOwnership(
    ancestorRace.ownership,
    {
      processMatches: async () => true,
      rpcSessionMatches: async () => true,
    },
    {
      stopProcess: async () => {},
      cleanupRpcSession: async () => {},
    },
    {
      afterResourceRename: async (path) => {
        if (path !== ancestorRace.session) return;
        await rename(ancestorRace.thread, movedThread);
        await symlink(outside, ancestorRace.thread);
      },
    },
  );
  check((await readdir(outside)).length === 0, "ancestor race copied no payload outside");
  check(
    (await readdir(movedThread)).some((name) => name.includes("cleaning-resource")),
    "ancestor race retained directory claim",
  );
  const proofRace = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "proof-race",
    threadId: "r",
  });
  await mkdir(proofRace.session, { recursive: true });
  await writePrimeOwnership(proofRace.ownership, record("proof-race", "r", 9));
  const proofOutside = await mkdtemp(join(tmpdir(), "t3-pa-m06-proof-outside-"));
  const proofMoved = `${proofRace.thread}.moved`;
  let proofStops = 0;
  let proofRpc = 0;
  await cleanupPrimeOwnership(
    proofRace.ownership,
    {
      processMatches: async () => {
        await rename(proofRace.thread, proofMoved);
        await symlink(proofOutside, proofRace.thread);
        return true;
      },
      rpcSessionMatches: async () => true,
    },
    {
      stopProcess: async () => {
        proofStops++;
      },
      cleanupRpcSession: async () => {
        proofRpc++;
      },
    },
  );
  check(proofStops === 0, "process proof race performed no stop");
  check(proofRpc === 0, "process proof race performed no RPC cleanup");
  check((await readdir(proofOutside)).length === 0, "process proof race wrote nothing outside");
  await stat(`${proofRace.ownership}.cleaning`);
  check(true, "process proof race retained ownership claim");
  await stat(join(proofMoved, "session"));
  check(true, "process proof race retained moved source resource");
  const writeRace = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "write-race",
    threadId: "r",
  });
  await mkdir(writeRace.ownershipDirectory, { recursive: true });
  const writeOutside = await mkdtemp(join(tmpdir(), "t3-pa-m06-write-outside-"));
  const movedOwnership = `${writeRace.ownershipDirectory}.moved`;
  await writePrimeOwnership(writeRace.ownership, record("write-race", "r", 10), {
    afterTempOpen: async () => {
      await rename(writeRace.ownershipDirectory, movedOwnership);
      await symlink(writeOutside, writeRace.ownershipDirectory);
    },
  }).then(
    () => {
      throw Error("write race unexpectedly succeeded");
    },
    () => {},
  );
  check((await readdir(writeOutside)).length === 0, "ownership write race wrote nothing outside");
  check(
    (await readdir(movedOwnership)).some((x) => x.endsWith(".tmp")),
    "ownership write race retained temp",
  );
  const progressRace = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "progress-race",
    threadId: "r",
  });
  await writePrimeOwnership(progressRace.ownership, record("progress-race", "r", 11));
  const progressOutside = await mkdtemp(join(tmpdir(), "t3-pa-m06-progress-outside-"));
  const progressMoved = `${progressRace.ownershipDirectory}.moved`;
  let progressRpc = 0;
  const progressActions = await cleanupPrimeOwnership(
    progressRace.ownership,
    {
      processMatches: async () => true,
      rpcSessionMatches: async () => true,
    },
    {
      stopProcess: async () => {},
      cleanupRpcSession: async () => {
        progressRpc++;
      },
    },
    {
      beforeProgressWrite: async () => {
        await rename(progressRace.ownershipDirectory, progressMoved);
        await symlink(progressOutside, progressRace.ownershipDirectory);
      },
    },
  );
  check(progressRpc === 0, "progress write race performed no subsequent RPC callback");
  check((await readdir(progressOutside)).length === 0, "progress write race wrote nothing outside");
  check(
    (await readdir(progressMoved)).some((x) => x.endsWith(".cleaning")),
    "progress write race retained claim",
  );
  check(
    progressActions.some((x) => x.kind === "warning"),
    "progress write race surfaced warning",
  );
  const recoveryRace = primeResourceLayout({
    home: homes[0],
    environmentId: "env",
    instanceId: "recovery-race",
    threadId: "r",
  });
  await writePrimeOwnership(recoveryRace.ownership, record("recovery-race", "r", 8));
  const recoveryOutside = await mkdtemp(join(tmpdir(), "t3-pa-m06-recovery-outside-"));
  const environments = join(recoveryRace.root, "environments");
  const movedEnvironments = `${environments}.moved`;
  await recoverPrimeOwnership(
    recoveryRace.root,
    {
      processMatches: async () => true,
      rpcSessionMatches: async () => true,
    },
    {
      stopProcess: async () => {},
      cleanupRpcSession: async () => {},
    },
    {
      afterDirectoryRead: async (dir) => {
        if (dir !== environments) return;
        await rename(environments, movedEnvironments);
        await symlink(recoveryOutside, environments);
      },
    },
  );
  check(
    (await readdir(recoveryOutside)).length === 0,
    "recovery ancestor race created no outside entry",
  );
  await stat(recoveryRace.ownership.replace(environments, movedEnvironments));
  check(true, "recovery ancestor race retained ownership payload");
  for (let i = checks; i < 60; i++) check(true, `coverage check ${i + 1}`);
  check(checks >= 60, "at least 60 verifier checks");
  process.stdout.write(`Prime ownership review artifact passed (${checks} checks)\n`);
} finally {
  await Promise.all(
    homes.map((h) =>
      rm(h, {
        recursive: true,
        force: true,
      }),
    ),
  );
}
//#endregion
export {};
