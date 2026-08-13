import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

/**
 * Private, host-local namespace for resources launched by the Prime adapter.
 * IDs are encoded rather than used as path components, so caller supplied IDs
 * cannot escape a T3 home or collide with each other.
 */
export type PrimeResourceLocation = {
  readonly root: string;
  readonly environment: string;
  readonly instance: string;
  readonly thread: string;
  readonly session: string;
  readonly config: string;
  readonly daemon: string;
  readonly ownership: string;
};

const component = (value: string) => encodeURIComponent(value);

export const primeResourceLayout = (input: {
  readonly home: string;
  readonly environmentId: string;
  readonly instanceId: string;
  readonly threadId: string;
}): PrimeResourceLocation => {
  // A short home fingerprint is diagnostic only; isolation comes from `home`.
  const home = resolve(input.home);
  const root = join(home, "userdata", "prime", "v1");
  const environment = join(root, "environments", component(input.environmentId));
  const instance = join(environment, "instances", component(input.instanceId));
  const thread = join(instance, "threads", component(input.threadId));
  return {
    root,
    environment,
    instance,
    thread,
    session: join(thread, "session"),
    config: join(thread, "config.json"),
    daemon: join(instance, "daemon"),
    ownership: join(instance, "ownership.json"),
  };
};

/** Stable non-secret label useful in warnings without exposing the home path. */
export const primeHomeFingerprint = (home: string) =>
  createHash("sha256").update(resolve(home)).digest("hex").slice(0, 12);
