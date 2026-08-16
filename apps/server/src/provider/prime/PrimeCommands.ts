import type {
  ProviderSessionCommandEntry,
  SessionCommandsUpdatedPayload,
} from "@t3tools/contracts";

/**
 * Prime 0.7.2 command/prompt/skill discovery (`get_commands`).
 *
 * Three invariants are load-bearing here:
 *  - **Nothing is invoked from here.** Discovery only describes what the runtime
 *    offers; an eligible entry is invoked as an ordinary prompt, so this module
 *    never gains an execution path of its own.
 *  - **Ineligible entries do not exist.** TUI-only and session/auth-mutating
 *    entries are dropped at this boundary, so no surface can offer one by
 *    accident. An unrecognized shape yields nothing rather than a guess.
 *  - **No host path leaves the host.** `location` is reduced to a bare file
 *    name; anything absolute, parent-relative, or home-relative is dropped
 *    entirely rather than sanitized into something that still discloses layout,
 *    and a path embedded in a free-text `description` is collapsed the same way.
 */

/** The native no-argument discovery command. Exact 0.7.2 shape, never inferred. */
export const PRIME_GET_COMMANDS_COMMAND = Object.freeze({ type: "get_commands" as const });

/** Maximum entries published. Discovery is a picker, not a filesystem listing. */
const MAX_COMMANDS = 128;
const MAX_RAW_ENTRIES = 1_024;
const MAX_DESCRIPTION_CHARS = 256;
const MAX_LOCATION_CHARS = 64;

/** A public command name: lowercase, no whitespace, no path separators. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

/**
 * Entries that mutate authentication, the daemon, or the T3-owned session
 * lifecycle. T3 owns those transitions; offering them as a prompt would let a
 * client reach around every guarantee this integration makes.
 */
const UNSAFE_NAMES = new Set([
  "login",
  "logout",
  "auth",
  "signin",
  "signout",
  "exit",
  "quit",
  "reset",
  "shutdown",
  "daemon",
  "new",
  "new-session",
  "resume",
  "fork",
  "clear",
]);

const KINDS = new Set(["command", "prompt", "skill"]);
const SOURCES = new Set(["builtin", "user", "project", "extension"]);

/**
 * Absolute host paths anywhere in free text. Unix, home-relative, and Windows
 * drive/UNC forms are all covered; a match is replaced by its bare file name so
 * the sentence still reads while the host layout never leaves the host.
 */
const HOST_PATH_PATTERN =
  /(?<![\w.~])(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\/)[^\s"'`;)\]}]*[\\/][^\s"'`,;)\]}]*/gu;

const redactHostPaths = (text: string): string =>
  text.replace(HOST_PATH_PATTERN, (match) => {
    const trimmed = match.replace(/[.,;:!?]+$/u, "");
    const segments = trimmed.split(/[\\/]/u).filter((segment) => segment !== "" && segment !== "~");
    const last = segments.at(-1);
    const tail = match.slice(trimmed.length);
    return (last === undefined || last.length > MAX_LOCATION_CHARS ? "[path]" : last) + tail;
  });

const cleanText = (value: unknown, maximum: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maximum)
    .trim();
  return text.length > 0 ? text : undefined;
};

/**
 * Reduces a native location to a bare file name. Absolute paths, parent
 * traversal, home-relative paths, and Windows drive/UNC paths are dropped: a
 * remote client is entitled to know which file an entry came from, never where
 * that file lives on the host.
 */
export function sanitizePrimeCommandLocation(value: unknown): string | undefined {
  const raw = cleanText(value, 512);
  if (raw === undefined) return undefined;
  if (raw.startsWith("~") || raw.includes("..")) return undefined;
  if (raw.startsWith("/") || raw.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(raw)) return undefined;
  const segments = raw.split(/[\\/]/u).filter((segment) => segment.length > 0);
  const last = segments.at(-1);
  if (last === undefined || last.length > MAX_LOCATION_CHARS) return undefined;
  return last;
}

const isTuiOnly = (raw: Record<string, unknown>): boolean =>
  raw.tuiOnly === true ||
  raw.tui === true ||
  raw.hidden === true ||
  raw.interactive === "tui" ||
  raw.surface === "tui" ||
  (Array.isArray(raw.surfaces) && raw.surfaces.length > 0 && !raw.surfaces.includes("rpc"));

/** Maps one native entry, or `undefined` when it is ineligible for any surface. */
function mapEntry(value: unknown): ProviderSessionCommandEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (isTuiOnly(raw)) return undefined;
  const name = cleanText(raw.name, 64)?.replace(/^\//u, "").toLowerCase();
  // Separators are normalized before the deny check so `new_session` cannot
  // slip past an entry spelled `new-session`.
  if (
    name === undefined ||
    !NAME_PATTERN.test(name) ||
    UNSAFE_NAMES.has(name.replace(/[_:]/gu, "-"))
  )
    return undefined;
  const kind = typeof raw.kind === "string" && KINDS.has(raw.kind) ? raw.kind : "command";
  const source = typeof raw.source === "string" && SOURCES.has(raw.source) ? raw.source : "builtin";
  // Descriptions are host-authored free text, so they get the same host-path
  // treatment as `location`: a path collapses to its bare file name.
  const cleanedDescription = cleanText(raw.description, MAX_DESCRIPTION_CHARS);
  const description =
    cleanedDescription === undefined ? undefined : redactHostPaths(cleanedDescription);
  const location = sanitizePrimeCommandLocation(raw.location ?? raw.path ?? raw.file);
  return {
    name,
    kind: kind as ProviderSessionCommandEntry["kind"],
    source: source as ProviderSessionCommandEntry["source"],
    ...(description === undefined ? {} : { description }),
    ...(location === undefined ? {} : { location }),
  };
}

/**
 * Normalizes a `get_commands` response body into the neutral catalog. A body
 * with no recognizable list yields an empty catalog, which hides the feature
 * rather than inventing one.
 */
export function normalizePrimeCommands(data: unknown): SessionCommandsUpdatedPayload {
  const container =
    data && typeof data === "object" ? (data as Record<string, unknown>) : undefined;
  const list = Array.isArray(data)
    ? data
    : Array.isArray(container?.commands)
      ? container.commands
      : undefined;
  if (!list) return { commands: [] };
  const byName = new Map<string, ProviderSessionCommandEntry>();
  for (const value of list.slice(0, MAX_RAW_ENTRIES)) {
    const entry = mapEntry(value);
    // First definition wins so a later duplicate cannot redefine an entry the
    // user already saw, and the catalog stays bounded regardless of input size.
    if (entry && !byName.has(entry.name) && byName.size < MAX_COMMANDS)
      byName.set(entry.name, entry);
  }
  return {
    commands: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
  };
}

/**
 * Session-scoped discovery cache. Prime re-reads command files on the host, so
 * discovery is done once per session and refreshed only on an explicit request;
 * nothing here polls, and nothing here survives its session.
 */
export class PrimeCommandCache {
  #catalog: SessionCommandsUpdatedPayload | undefined;
  #publishedJson: string | undefined;

  get catalog(): SessionCommandsUpdatedPayload | undefined {
    return this.#catalog;
  }

  /** True once discovery has run, so a caller can avoid a redundant RPC. */
  get isDiscovered(): boolean {
    return this.#catalog !== undefined;
  }

  /**
   * Records a discovery result and returns the snapshot to publish, or
   * `undefined` when it is byte-identical to the last published one.
   */
  apply(data: unknown): SessionCommandsUpdatedPayload | undefined {
    const catalog = normalizePrimeCommands(data);
    this.#catalog = catalog;
    const json = JSON.stringify(catalog);
    if (json === this.#publishedJson) return undefined;
    this.#publishedJson = json;
    return catalog;
  }

  /** Explicit invalidation; the next discovery republishes even if unchanged. */
  invalidate(): void {
    this.#catalog = undefined;
    this.#publishedJson = undefined;
  }
}
