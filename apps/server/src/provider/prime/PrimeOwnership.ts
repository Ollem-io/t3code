import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

export const PRIME_OWNERSHIP_VERSION = 1 as const;
const MAX_ID_LENGTH = 512;
const ownershipName = "ownership.json";
export type PrimeProcessHandle = { readonly pid: number; readonly startToken: string };
export type PrimeOwnershipRecord = { readonly version: typeof PRIME_OWNERSHIP_VERSION; readonly environmentId: string; readonly instanceId: string; readonly threadIds: readonly string[]; readonly process?: PrimeProcessHandle; readonly rpcSessionId?: string; readonly daemonSessionId?: string };
export type PrimeOwnershipWarning = { readonly path: string; readonly reason: string };
export type PrimeOwnershipAction = { readonly kind: "stopped"; readonly path: string } | { readonly kind: "removed"; readonly path: string } | { readonly kind: "warning"; readonly warning: PrimeOwnershipWarning };

const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH;
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every((key) => allowed.includes(key));
const isLayoutRoot = (root: string): boolean => {
  const parts = resolve(root).split(/[\\/]/);
  return parts.length >= 4 && parts.at(-1) === "v1" && parts.at(-2) === "prime" && parts.at(-3) === "userdata";
};
const ownershipRoot = (path: string): string | undefined => {
  const absolute = resolve(path);
  const marker = `${String.raw`/`}userdata${String.raw`/`}prime${String.raw`/`}v1${String.raw`/`}`;
  const index = absolute.lastIndexOf(marker);
  if (index < 0 || basename(absolute) !== ownershipName) return undefined;
  const root = absolute.slice(0, index + marker.length - 1);
  const remainder = relative(root, absolute).split(/[\\/]/);
  return isLayoutRoot(root) && remainder.length === 5 && remainder[0] === "environments" && remainder[1].startsWith("id-") && remainder[2] === "instances" && remainder[3].startsWith("id-") && remainder[4] === ownershipName ? root : undefined;
};
const assertOwnershipPath = (path: string): void => { if (!ownershipRoot(path)) throw new Error("ownership path is outside the exact Prime layout"); };

/** Atomic JSON persistence: a reader sees either the old complete record or the new complete record. */
export const writePrimeOwnership = async (path: string, record: PrimeOwnershipRecord): Promise<void> => {
  assertOwnershipPath(path);
  if (record.version !== PRIME_OWNERSHIP_VERSION || !isRecord(record)) throw new Error("invalid Prime ownership record");
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try { await writeFile(temporary, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }).catch(() => undefined); }
};

type Decode = { readonly record?: PrimeOwnershipRecord; readonly reason?: string };
const decode = (text: string): Decode => {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "partial or corrupt ownership record" };
    const raw = value as Record<string, unknown>;
    if (typeof raw.version === "number" && raw.version > PRIME_OWNERSHIP_VERSION) return { reason: "future ownership record version; left intact" };
    if (!isRecord(raw)) return { reason: raw.version !== PRIME_OWNERSHIP_VERSION ? "unsupported ownership record version; left intact" : "partial or corrupt ownership record" };
    return { record: raw };
  } catch { return { reason: "partial or corrupt ownership record" }; }
};
function isRecord(value: unknown): value is PrimeOwnershipRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  if (!exactKeys(raw, ["version", "environmentId", "instanceId", "threadIds", "process", "rpcSessionId", "daemonSessionId"]) || raw.version !== PRIME_OWNERSHIP_VERSION || !validId(raw.environmentId) || !validId(raw.instanceId) || !Array.isArray(raw.threadIds) || raw.threadIds.length > MAX_ID_LENGTH || !raw.threadIds.every(validId)) return false;
  if (raw.process !== undefined) {
    if (!raw.process || typeof raw.process !== "object" || Array.isArray(raw.process)) return false;
    const process = raw.process as Record<string, unknown>;
    if (!exactKeys(process, ["pid", "startToken"]) || !Number.isSafeInteger(process.pid) || (process.pid as number) <= 0 || !validId(process.startToken)) return false;
  }
  return (raw.rpcSessionId === undefined || validId(raw.rpcSessionId)) && (raw.daemonSessionId === undefined || validId(raw.daemonSessionId));
}
export const readPrimeOwnership = async (path: string): Promise<PrimeOwnershipRecord | undefined> => { try { return decode(await readFile(path, "utf8")).record; } catch { return undefined; } };
export type PrimeOwnershipProof = { readonly processMatches: (handle: PrimeProcessHandle) => Promise<boolean>; readonly daemonSessionMatches?: (id: string) => Promise<boolean>; readonly rpcSessionMatches?: (id: string) => Promise<boolean> };
export type PrimeOwnershipStop = (handle: PrimeProcessHandle) => Promise<void>;

/** Stops only a recorded process after every recorded identity has been proven. */
export const cleanupPrimeOwnership = async (path: string, proof: PrimeOwnershipProof, stop: PrimeOwnershipStop): Promise<readonly PrimeOwnershipAction[]> => {
  assertOwnershipPath(path);
  let source: string;
  try { source = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; return [{ kind: "warning", warning: { path, reason: "ownership record cannot be read; left intact" } }]; }
  const decoded = decode(source);
  if (!decoded.record) return [{ kind: "warning", warning: { path, reason: `${decoded.reason}; left intact` } }];
  const record = decoded.record;
  if (!record.process) {
    if (record.rpcSessionId || record.daemonSessionId) return [{ kind: "warning", warning: { path, reason: "session or daemon identity exists without a process; left intact" } }];
    await rm(path, { force: true }); return [{ kind: "removed", path }];
  }
  if (!(await proof.processMatches(record.process))) return [{ kind: "warning", warning: { path, reason: "captured process identity cannot be proven; left intact" } }];
  if (record.rpcSessionId && !(await proof.rpcSessionMatches?.(record.rpcSessionId) ?? false)) return [{ kind: "warning", warning: { path, reason: "RPC session identity cannot be proven; left intact" } }];
  if (record.daemonSessionId && !(await proof.daemonSessionMatches?.(record.daemonSessionId) ?? false)) return [{ kind: "warning", warning: { path, reason: "daemon session identity cannot be proven; left intact" } }];
  await stop(record.process); await rm(path, { force: true }); return [{ kind: "stopped", path }, { kind: "removed", path }];
};

/** Startup recovery is restricted to an exact `<home>/userdata/prime/v1` layout root. */
export const recoverPrimeOwnership = async (root: string, proof: PrimeOwnershipProof, stop: PrimeOwnershipStop): Promise<readonly PrimeOwnershipAction[]> => {
  const expectedRoot = resolve(root); if (!isLayoutRoot(expectedRoot)) throw new Error("recovery root is not an exact Prime layout root");
  const actions: PrimeOwnershipAction[] = [];
  const visit = async (directory: string): Promise<void> => {
    try { for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) await visit(path); else if (entry.isFile() && entry.name === ownershipName && ownershipRoot(path) === expectedRoot) actions.push(...await cleanupPrimeOwnership(path, proof, stop)); else if (entry.isFile() && entry.name.startsWith(".ownership.json.") && entry.name.endsWith(".tmp") && ownershipRoot(join(directory, ownershipName)) === expectedRoot) { await rm(path, { force: true }); actions.push({ kind: "warning", warning: { path, reason: "discarded incomplete atomic ownership write" } }); } } } catch { /* concurrent removal is safe; unreadable files remain untouched */ }
  };
  await visit(expectedRoot); return actions;
};
