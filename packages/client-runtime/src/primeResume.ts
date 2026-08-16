import {
  primeResumeAllowsFreshStart,
  type PrimeResumeFailureReason,
  type PrimeResumeState,
} from "@t3tools/contracts";

/**
 * PA-B04 — the one client-side model of Prime Agent durable resume.
 *
 * Every surface (web, desktop, mobile) derives its banner, its composer gate
 * and its recovery choices from this module, so the three cannot disagree about
 * what happened to a session. The host publishes only the coarse PA-B02 states
 * (`reconnecting`, `resumed`, `unavailable` + reason code); nothing here ever
 * learns a path, an owner, a native session id, or which device is writing.
 *
 * The rule the whole module exists to keep: **a failed resume never silently
 * becomes a fresh conversation.** The only refusal that may start fresh on its
 * own is "there was nothing to resume".
 */

/**
 * The Prime Agent *driver kind*, which is what the session read model reports
 * as `providerName`. Deliberately not an instance id: a second configured Prime
 * instance is still Prime Agent, and a resume that refused there has to surface
 * exactly the same way rather than silently going hidden.
 */
export const PRIME_RESUME_DRIVER_KIND = "prime-agent";

/** What a client may ask for once a resume did not land exactly. */
export type PrimeResumeChoiceKind = "retry" | "fork" | "fresh";

export type PrimeResumeChoice =
  | { readonly kind: "retry"; readonly label: string }
  | { readonly kind: "fork"; readonly label: string }
  | {
      readonly kind: "fresh";
      readonly label: string;
      /**
       * A fresh start is only honest if the cursor that refused resume stops
       * refusing. Invalidating it in place would leave the thread permanently
       * unable to start (the PA-B02 `capabilityMismatch` brick), so the choice
       * carries an explicit discard of the *cursor* — never of durable session
       * data, which is out of this milestone's scope.
       */
      readonly discardCursor: boolean;
      readonly confirm: string;
    };

/** A recovery choice as a client dispatches it. */
export type PrimeResumeIntent =
  | { readonly kind: "retry" }
  | { readonly kind: "fork" }
  | { readonly kind: "fresh"; readonly discardCursor: boolean };

export const PRIME_RESUME_RETRY_LABEL = "Try reconnecting again";
export const PRIME_RESUME_FORK_LABEL = "Fork into a new thread";
export const PRIME_RESUME_FRESH_LABEL = "Start a new session";

/**
 * Shown before a fresh start, because it is the only irreversible choice here:
 * the past session stays on disk, but this thread stops pointing at it.
 */
export const PRIME_RESUME_FRESH_CONFIRM =
  "Starting a new session leaves this thread's earlier Prime Agent session behind. The messages and checkpoints already in this thread are kept, and nothing on disk is deleted.";

/** Stop and archive are not deletion, and the copy has to say so out loud. */
export const PRIME_RESUME_STOP_NOTE =
  "Stopping ends the current turn. The Prime Agent session and this thread's history are kept, and the session can be resumed.";
export const PRIME_RESUME_ARCHIVE_NOTE =
  "Archiving hides the thread. Nothing is deleted, and unarchiving brings the thread and its resume point back.";

const RETRY: PrimeResumeChoice = { kind: "retry", label: PRIME_RESUME_RETRY_LABEL };
const FORK: PrimeResumeChoice = { kind: "fork", label: PRIME_RESUME_FORK_LABEL };
const fresh = (discardCursor: boolean): PrimeResumeChoice => ({
  kind: "fresh",
  label: PRIME_RESUME_FRESH_LABEL,
  discardCursor,
  confirm: PRIME_RESUME_FRESH_CONFIRM,
});

/**
 * Failure reasons grouped by the recovery they actually permit. Codes are kept
 * distinct on the wire precisely so this table can exist.
 */
const CONFLICT_REASONS: ReadonlySet<PrimeResumeFailureReason> = new Set([
  "conflict",
  "unauthorized",
]);
const INCOMPATIBLE_REASONS: ReadonlySet<PrimeResumeFailureReason> = new Set([
  "incompatibleVersion",
  "unsupportedVersion",
]);
const FORK_REQUIRED_REASONS: ReadonlySet<PrimeResumeFailureReason> = new Set([
  "capabilityMismatch",
  "ownershipMismatch",
  "scopeMismatch",
  "instanceMismatch",
  "workspaceMismatch",
]);

/**
 * The coarse surface a client renders. `missing` is deliberately its own kind
 * and not a recovery: nothing was lost, so nothing must be recovered.
 */
export type PrimeResumeSurfaceKind =
  | "hidden"
  | "reconnecting"
  | "resumed"
  | "missing"
  | "conflict"
  | "incompatible"
  | "forkRequired"
  | "unavailable"
  | "stalled";

export type PrimeResumeSurface = {
  readonly kind: PrimeResumeSurfaceKind;
  readonly title: string;
  readonly detail: string;
  /**
   * Whether the composer must refuse to send. A thread whose resume outcome is
   * unknown or refused must not accept a prompt: that prompt is exactly what
   * would silently open a new session.
   */
  readonly composerBlocked: boolean;
  readonly choices: ReadonlyArray<PrimeResumeChoice>;
  /** Present only for a refusal, so a bug report can name the class of refusal. */
  readonly reason?: PrimeResumeFailureReason;
};

const hidden: PrimeResumeSurface = {
  kind: "hidden",
  title: "",
  detail: "",
  composerBlocked: false,
  choices: [],
};

const refusal = (
  kind: PrimeResumeSurfaceKind,
  reason: PrimeResumeFailureReason,
  title: string,
  detail: string,
  choices: ReadonlyArray<PrimeResumeChoice>,
): PrimeResumeSurface => ({ kind, title, detail, composerBlocked: true, choices, reason });

/** The refusal surface for one reason code. Never names a device or a path. */
export function primeResumeFailureSurface(reason: PrimeResumeFailureReason): PrimeResumeSurface {
  if (primeResumeAllowsFreshStart(reason))
    return {
      kind: "missing",
      title: "No earlier Prime Agent session",
      detail:
        "This thread has no durable Prime Agent session yet. Sending a message starts a new one.",
      composerBlocked: false,
      choices: [],
      reason,
    };
  if (CONFLICT_REASONS.has(reason))
    return refusal(
      "conflict",
      reason,
      "Another writer has this session",
      // Coarse by construction: the host tells us only that someone else is
      // authoritative, never who or where, and this copy may not imply more.
      "Another client is currently the writer for this Prime Agent session. This thread's history is intact and stays read-only until that writer finishes. Nothing here was lost.",
      // Retry first, because a conflict usually clears on its own once the
      // other writer finishes. Fork is offered too: a writer that never
      // finishes must not be a dead end, and forking takes nothing away from
      // whoever holds the session. A fresh start is deliberately not offered —
      // discarding the cursor while someone else is authoritative would fight
      // over a session this client cannot see the state of.
      [RETRY, FORK],
    );
  if (INCOMPATIBLE_REASONS.has(reason))
    return refusal(
      "incompatible",
      reason,
      "Prime Agent cannot reopen this session",
      "The installed Prime Agent cannot be trusted to reopen this exact session. The session was not replaced. Update Prime Agent and retry, fork this thread, or start a new session.",
      [RETRY, FORK, fresh(true)],
    );
  if (FORK_REQUIRED_REASONS.has(reason))
    return refusal(
      "forkRequired",
      reason,
      "This session can no longer be continued here",
      "The earlier Prime Agent session no longer matches this thread, so it was not reopened and it was not replaced. Fork this thread to keep going from its history, or start a new session.",
      [FORK, fresh(true)],
    );
  return refusal(
    "unavailable",
    reason,
    "Prime Agent could not reopen this session",
    "The exact Prime Agent session for this thread could not be recovered. It was not replaced with a new one, and this thread's messages and checkpoints are unchanged.",
    [RETRY, FORK, fresh(true)],
  );
}

/**
 * The reducer's model. `stalled` is a client-side fact, not a host claim: it
 * records that a published `reconnecting` never got its terminal follow-up
 * (a failed relaunch or an adopt race can end that way), so the UI offers
 * recovery instead of spinning forever.
 */
export type PrimeResumeModel = {
  readonly state: PrimeResumeState | undefined;
  readonly stalled: boolean;
  /** The choice this client dispatched and is waiting on. */
  readonly pending: PrimeResumeIntent | undefined;
};

export const initialPrimeResumeModel: PrimeResumeModel = {
  state: undefined,
  stalled: false,
  pending: undefined,
};

/** Session lifecycle facts the reducer needs to detect a missing follow-up. */
export type PrimeResumeSessionStatus =
  | "idle"
  | "starting"
  | "running"
  | "ready"
  | "interrupted"
  | "stopped"
  | "error";

export type PrimeResumeEvent =
  | { readonly type: "state"; readonly state: PrimeResumeState }
  | { readonly type: "choice"; readonly intent: PrimeResumeIntent }
  | { readonly type: "sessionStatus"; readonly status: PrimeResumeSessionStatus }
  | { readonly type: "disconnected" };

export function primeResumeReduce(
  model: PrimeResumeModel,
  event: PrimeResumeEvent,
): PrimeResumeModel {
  switch (event.type) {
    case "state":
      // A published state always wins: it is the host's answer, including the
      // answer to a choice this client made.
      return { state: event.state, stalled: false, pending: undefined };
    case "choice":
      // Retrying re-enters reconnecting locally so the composer stays shut
      // between the click and the host's answer. That answer always arrives:
      // a user-requested attempt publishes `reconnecting` and then its terminal
      // state, so even a refusal that repeats itself unchanged lands here as a
      // `state` event and clears `pending`.
      //
      // A fork is the exception, and deliberately not pending: it publishes no
      // resume state for *this* thread (it creates another one), so recording a
      // wait for an answer that will never come would leave this thread's
      // recovery buttons inert forever.
      return {
        state: event.intent.kind === "retry" ? { status: "reconnecting" } : model.state,
        stalled: false,
        pending: event.intent.kind === "fork" ? model.pending : event.intent,
      };
    case "sessionStatus":
      // Only a terminal session status can settle a reconnect that never got
      // one. `resumed`/`unavailable` are already terminal and are left alone.
      if (model.state?.status !== "reconnecting") return model;
      return event.status === "error" || event.status === "stopped"
        ? { ...model, stalled: true, pending: undefined }
        : model;
    case "disconnected":
      // A dropped client connection says nothing about the host's session, but
      // it does mean this client no longer knows. Truthful state is "unknown",
      // which reads as reconnecting, never as resumed.
      return model.state?.status === "resumed"
        ? { state: { status: "reconnecting" }, stalled: false, pending: undefined }
        : model;
  }
}

/**
 * The single surface decision every client renders.
 *
 * Hidden unless the provider is Prime Agent and the host actually published
 * something: a thread that never had a durable session must not flash recovery
 * UI it has no reason to show.
 */
export function primeResumeSurface(
  providerDriverKind: string | null | undefined,
  model: PrimeResumeModel,
): PrimeResumeSurface {
  if (providerDriverKind !== PRIME_RESUME_DRIVER_KIND) return hidden;
  const state = model.state;
  if (state === undefined) return hidden;
  if (state.status === "unavailable") return primeResumeFailureSurface(state.reason);
  if (state.status === "resumed")
    return {
      kind: "resumed",
      title:
        state.mode === "adopted"
          ? "Reconnected to the running Prime Agent session"
          : "Reopened the exact Prime Agent session",
      detail:
        state.mode === "adopted"
          ? "The session was still running and this thread is attached to it."
          : "The session was reopened from its durable record; the conversation continues from where it stopped.",
      composerBlocked: false,
      choices: [],
    };
  if (model.stalled)
    return {
      kind: "stalled",
      title: "Prime Agent did not report the outcome",
      detail:
        "Reconnecting to the durable Prime Agent session did not finish, and no new session was started in its place. Retry, fork this thread, or start a new session.",
      composerBlocked: true,
      // `fresh(true)`: the button says the earlier session is left behind, so
      // it has to actually stop this thread pointing at it. Offering a fresh
      // start that quietly ran a retry made the label a lie, and a cursor that
      // stalled once would stall again on the next attempt.
      choices: [RETRY, FORK, fresh(true)],
    };
  return {
    kind: "reconnecting",
    title: "Reconnecting to the Prime Agent session",
    detail:
      "Checking whether the exact earlier session can be reopened. Nothing is sent until this resolves.",
    composerBlocked: true,
    choices: [],
  };
}

/** The composer gate, so no surface has to re-derive it. */
export function primeResumeBlocksComposer(
  providerDriverKind: string | null | undefined,
  model: PrimeResumeModel,
): boolean {
  return primeResumeSurface(providerDriverKind, model).composerBlocked;
}

/**
 * The reason a blocked composer reports. One string for every client, so the
 * gate and the banner cannot disagree about why sending is paused.
 */
export const PRIME_RESUME_COMPOSER_BLOCKED_REASON = "Prime Agent resume unresolved";

/**
 * Where a chosen recovery is dispatched.
 *
 * Fork is deliberately not a resume command: forking a thread already exists
 * end to end and it leaves the refused session exactly where it is, so routing
 * it anywhere else would duplicate a durable operation. Retry and fresh are the
 * only two the host must arbitrate as resume, which is why the recover command
 * carries just those two.
 */
export function primeResumeRecoveryRoute(intent: PrimeResumeIntent):
  | { readonly kind: "fork" }
  | {
      readonly kind: "recover";
      readonly intent: "retry" | "fresh";
      readonly discardCursor: boolean;
    } {
  if (intent.kind === "fork") return { kind: "fork" };
  return intent.kind === "fresh"
    ? { kind: "recover", intent: "fresh", discardCursor: intent.discardCursor }
    : // A retry never discards anything: it re-runs the same validation, and a
      // refusal that survives it must survive it with the cursor intact.
      { kind: "recover", intent: "retry", discardCursor: false };
}

/**
 * Whether a dispatched choice is still waiting on the host's answer. Every
 * surface uses it to disable its own buttons, so one click cannot become two
 * forks or two discarded cursors.
 */
export function primeResumeAwaitingChoice(model: PrimeResumeModel): boolean {
  return model.pending !== undefined;
}

/** The intent a chosen recovery dispatches, or `undefined` if it is not offered. */
export function primeResumeIntentFor(
  surface: PrimeResumeSurface,
  kind: PrimeResumeChoiceKind,
): PrimeResumeIntent | undefined {
  const choice = surface.choices.find((entry) => entry.kind === kind);
  if (choice === undefined) return undefined;
  return choice.kind === "fresh"
    ? { kind: "fresh", discardCursor: choice.discardCursor }
    : { kind: choice.kind };
}

/** Lines every attached client derives from one published state. */
export function renderPrimeResume(
  providerDriverKind: string | null | undefined,
  model: PrimeResumeModel,
): ReadonlyArray<string> {
  const surface = primeResumeSurface(providerDriverKind, model);
  if (surface.kind === "hidden") return [];
  return [surface.title, surface.detail, ...surface.choices.map((choice) => choice.label)];
}
