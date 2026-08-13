import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const PRIME_OWNERSHIP_VERSION = 1 as const;

export type PrimeProcessHandle = { readonly pid: number; readonly startToken: string };
export type PrimeOwnershipRecord = {
  readonly version: typeof PRIME_OWNERSHIP_VERSION;
  readonly environmentId: string;
  readonly instanceId: string;
  readonly threadIds: readonly string[];
  readonly process?: PrimeProcessHandle;
  readonly rpcSessionId?: string;
  readonly daemonSessionId?: string;
};
export type PrimeOwnershipWarning = { readonly path: string; readonly reason: string };
export type PrimeOwnershipAction =
  | { readonly kind: "stopped"; readonly path: string }
  | { readonly kind: "removed"; readonly path: string }
  | { readonly kind: "warning"; readonly warning: PrimeOwnershipWarning };

/** Atomic JSON persistence: a reader sees either the old complete record or the new complete record. */
export const writePrimeOwnership = async (path: string, record: PrimeOwnershipRecord) => {
  if (record.version !== PRIME_OWNERSHIP_VERSION) throw new Error("unsupported Prime ownership version");
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
};

const decode = (text: string): PrimeOwnershipRecord | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object") return undefined;
    const record = value as Partial<PrimeOwnershipRecord>;
    if (record.version !== PRIME_OWNERSHIP_VERSION || typeof record.environmentId !== "string" ||
      typeof record.instanceId !== "string" || !Array.isArray(record.threadIds) ||
      !record.threadIds.every((id) => typeof id === "string")) return undefined;
    if (record.process && (typeof record.process.pid !== "number" || typeof record.process.startToken !== "string")) return undefined;
    if (record.rpcSessionId !== undefined && typeof record.rpcSessionId !== "string") return undefined;
    if (record.daemonSessionId !== undefined && typeof record.daemonSessionId !== "string") return undefined;
    return record as PrimeOwnershipRecord;
  } catch { return undefined; }
};

export const readPrimeOwnership = async (path: string): Promise<PrimeOwnershipRecord | undefined> => {
  try { return decode(await readFile(path, "utf8")); } catch { return undefined; }
};

export type PrimeOwnershipProof = {
  /** Must inspect this precise PID and its captured OS start token; no name lookup is permitted. */
  readonly processMatches: (handle: PrimeProcessHandle) => Promise<boolean>;
  /** Optional active daemon identity must agree before the exact process is stopped. */
  readonly daemonSessionMatches?: (id: string) => Promise<boolean>;
  /** RPC session identity is independently checked when a record captured one. */
  readonly rpcSessionMatches?: (id: string) => Promise<boolean>;
};
export type PrimeOwnershipStop = (handle: PrimeProcessHandle) => Promise<void>;

/**
 * Stop/remove one known ownership file. Every destructive action is preceded by
 * identity proof. Missing files make this naturally idempotent.
 */
export const cleanupPrimeOwnership = async (
  path: string, proof: PrimeOwnershipProof, stop: PrimeOwnershipStop,
): Promise<readonly PrimeOwnershipAction[]> => {
  let source: string;
  try { source = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [{ kind: "warning", warning: { path, reason: "ownership record cannot be read; left intact" } }];
  }
  const record = decode(source);
  if (!record) return [{ kind: "warning", warning: { path, reason: "partial, corrupt, or unsupported ownership record; left intact" } }];
  if (record.process) {
    if (!(await proof.processMatches(record.process))) return [{ kind: "warning", warning: { path, reason: "captured process identity cannot be proven; left intact" } }];
    if (record.rpcSessionId && !(await proof.rpcSessionMatches?.(record.rpcSessionId) ?? false))
      return [{ kind: "warning", warning: { path, reason: "RPC session identity cannot be proven; left intact" } }];
    if (record.daemonSessionId && !(await proof.daemonSessionMatches?.(record.daemonSessionId) ?? false))
      return [{ kind: "warning", warning: { path, reason: "daemon session identity cannot be proven; left intact" } }];
    await stop(record.process);
    await rm(path, { force: true });
    return [{ kind: "stopped", path }, { kind: "removed", path }];
  }
  await rm(path, { force: true });
  return [{ kind: "removed", path }];
};

/** Startup recovery scans only the supplied T3 home namespace, never host-wide Prime state. */
export const recoverPrimeOwnership = async (
  root: string, proof: PrimeOwnershipProof, stop: PrimeOwnershipStop,
): Promise<readonly PrimeOwnershipAction[]> => {
  const actions: PrimeOwnershipAction[] = [];
  const visit = async (directory: string): Promise<void> => {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (entry.isFile() && entry.name === "ownership.json") {
          actions.push(...await cleanupPrimeOwnership(path, proof, stop));
        } else if (entry.isFile() && entry.name.startsWith(".ownership.json.") && entry.name.endsWith(".tmp")) {
          await rm(path, { force: true });
          actions.push({ kind: "warning", warning: { path, reason: "discarded incomplete atomic ownership write" } });
        }
      }
    } catch {
      // A concurrently removed directory is already recovered; do not broaden scope.
    }
  };
  await visit(root);
  return actions;
};
