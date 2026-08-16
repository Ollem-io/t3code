export type PrimeCommandCapabilities = {
  readonly commandDiscovery?: boolean | undefined;
};
export type PrimeCommandEntry = {
  readonly name: string;
  readonly kind: "command" | "prompt" | "skill";
  readonly description?: string | undefined;
  readonly source: "builtin" | "user" | "project" | "extension";
  readonly location?: string | undefined;
};

/**
 * Prime-discovered commands, prompts, and skills.
 *
 * Discovery happens on the host and only sanitized metadata crosses the wire,
 * so nothing here can reveal a host path — a `location` is a bare file name or
 * nothing at all. Invocation is an ordinary prompt: there is no separate
 * execution channel to get wrong.
 *
 * This module is kept byte-identical with its mobile twin
 * (`apps/mobile/src/features/threads/primeCommands.ts`), and each surface's test
 * asserts that equality so the two cannot drift apart.
 */
export const PRIME_COMMAND_ORIGIN = "Prime";

/** True only when the runtime advertises the PA-A04 discovery extension. */
export function hasPrimeCommandSurface(
  providerName: string | null | undefined,
  capabilities: PrimeCommandCapabilities | undefined,
): boolean {
  return providerName === "prime-agent" && capabilities?.commandDiscovery === true;
}

const KIND_LABEL: Record<PrimeCommandEntry["kind"], string> = {
  command: "command",
  prompt: "prompt",
  skill: "skill",
};
const SOURCE_LABEL: Record<PrimeCommandEntry["source"], string> = {
  builtin: "built-in",
  user: "user",
  project: "project",
  extension: "extension",
};

/**
 * Origin is always stated: a user must be able to tell a Prime-supplied entry
 * from a T3 one, and where it came from, before running it.
 */
export function primeCommandOriginLabel(entry: PrimeCommandEntry): string {
  const kind = KIND_LABEL[entry.kind];
  const source = SOURCE_LABEL[entry.source];
  return entry.location === undefined
    ? `${PRIME_COMMAND_ORIGIN} ${source} ${kind}`
    : `${PRIME_COMMAND_ORIGIN} ${source} ${kind} · ${entry.location}`;
}

/** The exact text sent as an ordinary prompt. */
export function primeCommandPrompt(name: string, input?: string | undefined): string {
  const trimmed = input?.trim() ?? "";
  return trimmed.length > 0 ? `/${name} ${trimmed}` : `/${name}`;
}

/**
 * Case-insensitive search over name and description. The catalog is an
 * authoritative snapshot held in session state, so this filters what is already
 * in memory rather than asking the host per keystroke.
 */
export function searchPrimeCommands(
  entries: ReadonlyArray<PrimeCommandEntry> | undefined,
  query: string,
): ReadonlyArray<PrimeCommandEntry> {
  if (!entries || entries.length === 0) return [];
  const needle = query.trim().replace(/^\//u, "").toLowerCase();
  if (needle.length === 0) return entries;
  return entries.filter(
    (entry) =>
      entry.name.includes(needle) || (entry.description?.toLowerCase().includes(needle) ?? false),
  );
}

/**
 * Appends an invocation to whatever the user already typed. Picking a command
 * is an insertion, never a replacement: a draft in progress is the user's work
 * and no picker may discard it.
 */
export function appendPrimeCommandToDraft(draft: string, prompt: string): string {
  const base = draft.replace(/\s+$/u, "");
  return base.length === 0 ? prompt : `${base} ${prompt}`;
}

/**
 * Resolves an invocation against the current catalog. A command deleted on the
 * host between render and click fails with an actionable reason instead of
 * sending a prompt the runtime will reject, so callers must pass the newest
 * catalog they hold rather than the array the item was rendered from.
 */
export function resolvePrimeCommandInvocation(
  entries: ReadonlyArray<PrimeCommandEntry> | undefined,
  name: string,
  input?: string | undefined,
): { ok: true; prompt: string } | { ok: false; reason: string } {
  const entry = entries?.find((candidate) => candidate.name === name);
  if (!entry)
    return {
      ok: false,
      reason: `/${name} is no longer offered by this runtime.`,
    };
  return { ok: true, prompt: primeCommandPrompt(entry.name, input) };
}
