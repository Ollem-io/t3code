import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_ID_LENGTH = 512;

/** A path segment made from a complete UTF-8 identifier, never caller path syntax. */
export const primePathComponent = (value: string): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_ID_LENGTH ||
    value === "." ||
    value === ".."
  ) {
    throw new Error("Prime resource IDs must be non-empty bounded values, not dot components");
  }
  return `id-${Buffer.from(value, "utf8").toString("base64url")}`;
};

export const decodePrimePathComponent = (value: string): string | undefined => {
  if (!value.startsWith("id-") || value.length === 3) return undefined;
  try {
    const decoded = Buffer.from(value.slice(3), "base64url").toString("utf8");
    return primePathComponent(decoded) === value ? decoded : undefined;
  } catch {
    return undefined;
  }
};

export const assertPrimeContained = (root: string, path: string): void => {
  const segment = relative(resolve(root), resolve(path));
  if (segment === "" || segment === ".." || segment.startsWith(`..${sep}`) || isAbsolute(segment)) {
    throw new Error("Prime resource path escaped its T3 home namespace");
  }
};

/** Private, host-local namespace for resources launched by the Prime adapter. */
export type PrimeResourceLocation = {
  readonly root: string;
  readonly environment: string;
  readonly instance: string;
  readonly thread: string;
  readonly session: string;
  readonly config: string;
  readonly daemon: string;
  readonly ownershipDirectory: string;
  readonly ownership: string;
  readonly daemonOwnership: string;
};

export const primeResourceLayout = (input: {
  readonly home: string;
  readonly environmentId: string;
  readonly instanceId: string;
  readonly threadId: string;
}): PrimeResourceLocation => {
  const home = resolve(input.home);
  const root = join(home, "userdata", "prime", "v1");
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

/** Stable non-secret label useful in warnings without exposing the home path. */
export const primeHomeFingerprint = (home: string) =>
  createHash("sha256").update(resolve(home)).digest("hex").slice(0, 12);
