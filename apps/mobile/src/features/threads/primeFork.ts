export type PrimeNamingCapabilities = {
  readonly namingAndForking?: boolean | undefined;
};
export type PrimeForkPoint = {
  readonly forkPointId: string;
  readonly label: string;
  readonly role: "user" | "assistant";
  readonly index: number;
};
export type PrimeSessionIdentityCard = {
  readonly name?: string | undefined;
  readonly forkPoints: ReadonlyArray<PrimeForkPoint>;
  readonly truncated?: true | undefined;
};
export type PrimeThreadForkOrigin = {
  readonly threadId: string;
  readonly forkPointLabel?: string | undefined;
  readonly checkpointId?: string | undefined;
  readonly forkedAt: string;
};
export type PrimeSessionLiveness = {
  readonly status?: string | undefined;
} | null;

/**
 * Session naming and forking as both clients see them. This module is kept
 * byte-identical with its mobile twin
 * (`apps/mobile/src/features/threads/primeFork.ts`), and each surface's test
 * asserts that equality so the two cannot drift apart.
 */
export const PRIME_NAMING_UNAVAILABLE =
  "This Prime Agent version does not support session naming or forking. Update Prime Agent to rename or fork this session.";

/**
 * Shown before every fork, worded as what actually happens. Forking is easy to
 * mistake for "reopen an old session"; it is not, and this sentence is the only
 * place a user finds that out before pressing the button.
 */
export const PRIME_FORK_NOT_RESUME_NOTE =
  "A fork starts a new Prime Agent session and a new T3 thread from the chosen point. The original thread is untouched. This is not durable resume of a past session.";

/** Shown whenever the page is a window onto a longer conversation. */
export const PRIME_FORK_TRUNCATED_NOTE =
  "Showing the most recent fork points for this session; earlier messages are not listed.";

/** The whole-session choice, so "fork from here" is never the only option. */
export const PRIME_FORK_WHOLE_SESSION_LABEL = "Whole session";

/** Mirrors the `thread.session.rename` bound so the cap is stated inline, not by schema rejection. */
export const MAX_PRIME_SESSION_NAME_CHARS = 120;

/** True only when the runtime advertises the PA-A08 naming and forking extension. */
export function hasPrimeNaming(
  providerName: string | null | undefined,
  capabilities: PrimeNamingCapabilities | undefined,
): boolean {
  return providerName === "prime-agent" && capabilities?.namingAndForking === true;
}

/**
 * A rename or a fork acts on a live session. After a crash or restart the
 * session row can survive with its last card attached, and offering "Fork" on a
 * dead process would be a control that can never succeed.
 */
export function hasLivePrimeSession(session: PrimeSessionLiveness | undefined): boolean {
  return session?.status === "running" || session?.status === "ready";
}

export type PrimeIdentityView =
  | { readonly kind: "hidden" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | {
      readonly kind: "identity";
      readonly name?: string | undefined;
      readonly forkPoints: ReadonlyArray<PrimeForkPoint>;
      readonly truncated: boolean;
    };

/**
 * The single surface decision, shared by both clients.
 *
 * A live Prime session on a runtime that never advertises the extension
 * explains itself instead of rendering nothing: an older runtime should look
 * outdated, not broken. Everything else (another provider, a dead session)
 * stays hidden — but a capable live session is always shown, even before it has
 * any fork points, because that is where a session gets its name.
 */
export function primeIdentityView(
  providerName: string | null | undefined,
  capabilities: PrimeNamingCapabilities | undefined,
  card: PrimeSessionIdentityCard | undefined,
  session: PrimeSessionLiveness | undefined,
): PrimeIdentityView {
  if (providerName !== "prime-agent" || !hasLivePrimeSession(session)) return { kind: "hidden" };
  if (capabilities?.namingAndForking !== true)
    return { kind: "unavailable", reason: PRIME_NAMING_UNAVAILABLE };
  return {
    kind: "identity",
    ...(card?.name ? { name: card.name } : {}),
    forkPoints: card?.forkPoints ?? [],
    truncated: card?.truncated === true,
  };
}

export function renderPrimeForkPoint(point: PrimeForkPoint): string {
  const who = point.role === "user" ? "You" : "Prime Agent";
  return `${who}: ${point.label}`;
}

/** Every attached client derives these lines from the same snapshot. */
export function renderPrimeIdentityCard(
  card: PrimeSessionIdentityCard | undefined,
  session: PrimeSessionLiveness | undefined,
): ReadonlyArray<string> {
  if (!card || !hasLivePrimeSession(session)) return [];
  return [
    ...(card.name ? [`Session name: ${card.name}`] : []),
    ...card.forkPoints.map(renderPrimeForkPoint),
    ...(card.truncated ? [PRIME_FORK_TRUNCATED_NOTE] : []),
  ];
}

/**
 * The reverse-navigation label on a forked thread.
 *
 * Ancestry outlives the sessions on both sides, so this reads from the thread
 * record and never from a provider card: a fork stays traceable to its origin
 * with Prime Agent uninstalled.
 */
export function renderPrimeForkOrigin(origin: PrimeThreadForkOrigin | null | undefined): string {
  if (!origin) return "";
  const at = origin.forkPointLabel ? ` at "${origin.forkPointLabel}"` : "";
  const checkpoint = origin.checkpointId ? ` · source checkpoint ${origin.checkpointId}` : "";
  return `Forked from another thread${at}${checkpoint}`;
}

export type PrimeRenameDecision =
  | { readonly canRename: true; readonly name: string }
  | { readonly canRename: false; readonly reason: string };

/**
 * Whether a rename may be requested.
 *
 * The bound is stated inline rather than left to the wire schema: a name the
 * server would reject should be refused where it is typed, with the reason.
 */
export function primeRenameDraftDecision(
  card: PrimeSessionIdentityCard | undefined,
  session: PrimeSessionLiveness | undefined,
  capabilities: PrimeNamingCapabilities | undefined,
  name: string,
): PrimeRenameDecision {
  if (capabilities?.namingAndForking !== true)
    return { canRename: false, reason: PRIME_NAMING_UNAVAILABLE };
  if (!hasLivePrimeSession(session))
    return { canRename: false, reason: "Start a Prime Agent session before renaming it." };
  const trimmed = name.trim();
  if (trimmed.length === 0) return { canRename: false, reason: "Give this session a name." };
  if (trimmed.length > MAX_PRIME_SESSION_NAME_CHARS)
    return {
      canRename: false,
      reason: `Keep the session name to ${MAX_PRIME_SESSION_NAME_CHARS} characters or fewer.`,
    };
  if (trimmed === card?.name)
    return { canRename: false, reason: "This session already has that name." };
  return { canRename: true, name: trimmed };
}

export type PrimeForkDecision =
  | { readonly canFork: true; readonly disclosure: string }
  | { readonly canFork: false; readonly reason: string };

/**
 * Whether a fork may be requested, and the disclosure to show first.
 *
 * The disclosure is returned with the permission rather than left to each
 * surface: "this is not resume" must be stated before forking on every client,
 * and nothing can render the button without also getting the sentence.
 */
export function primeForkDraftDecision(
  card: PrimeSessionIdentityCard | undefined,
  session: PrimeSessionLiveness | undefined,
  capabilities: PrimeNamingCapabilities | undefined,
  forkPointId: string | undefined,
): PrimeForkDecision {
  if (capabilities?.namingAndForking !== true)
    return { canFork: false, reason: PRIME_NAMING_UNAVAILABLE };
  if (!hasLivePrimeSession(session))
    return { canFork: false, reason: "Start a Prime Agent session before forking it." };
  // A point the current page does not offer is refused here and again on the
  // host: a client rendering an older page must not be able to name a fork
  // point this session no longer has.
  if (
    forkPointId !== undefined &&
    !(card?.forkPoints ?? []).some((point) => point.forkPointId === forkPointId)
  )
    return { canFork: false, reason: "This session no longer offers that fork point." };
  return { canFork: true, disclosure: PRIME_FORK_NOT_RESUME_NOTE };
}
