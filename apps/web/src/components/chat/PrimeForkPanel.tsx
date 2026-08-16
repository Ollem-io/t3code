import { useState } from "react";

import {
  PRIME_FORK_TRUNCATED_NOTE,
  PRIME_FORK_WHOLE_SESSION_LABEL,
  primeForkDraftDecision,
  primeIdentityView,
  primeRenameDraftDecision,
  renderPrimeForkPoint,
  type PrimeNamingCapabilities,
  type PrimeSessionIdentityCard,
  type PrimeSessionLiveness,
} from "./primeFork";

export interface PrimeForkPanelProps {
  readonly providerName: string | null | undefined;
  readonly capabilities: PrimeNamingCapabilities | undefined;
  readonly card: PrimeSessionIdentityCard | undefined;
  /** Liveness fact, so a crashed session never offers controls that cannot work. */
  readonly session: PrimeSessionLiveness | undefined;
  readonly onRenameSession: (name: string) => void;
  readonly onForkSession: (forkPointId: string | undefined) => void;
}

/**
 * The session's name and the points it can be forked from.
 *
 * Renaming is always reversible by renaming again, so it needs no confirmation.
 * Forking is not: it makes a session and a thread, so the consequence is
 * disclosed and confirmed first, and cancelling the confirmation dispatches
 * nothing at all — which is what keeps a cancelled fork from leaving a
 * half-created thread behind.
 */
export function PrimeForkPanel(props: PrimeForkPanelProps) {
  const [name, setName] = useState("");
  const [forkPointId, setForkPointId] = useState<string | undefined>(undefined);
  const [confirming, setConfirming] = useState(false);
  const view = primeIdentityView(props.providerName, props.capabilities, props.card, props.session);
  if (view.kind === "hidden") return null;
  if (view.kind === "unavailable")
    return (
      <div
        className="px-2 py-1 text-xs text-muted-foreground"
        data-testid="prime-naming-unavailable"
      >
        {view.reason}
      </div>
    );

  const rename = primeRenameDraftDecision(props.card, props.session, props.capabilities, name);
  const fork = primeForkDraftDecision(props.card, props.session, props.capabilities, forkPointId);

  return (
    <div className="px-2 py-1 text-xs text-muted-foreground" data-testid="prime-session-identity">
      <div data-testid="prime-session-name">
        {view.name === undefined
          ? "This Prime Agent session has no name yet."
          : `Session name: ${view.name}`}
      </div>
      <div className="flex items-center gap-2" data-testid="prime-session-rename">
        <input
          aria-label="Session name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
        <button
          type="button"
          className="rounded-md border px-2 py-0.5 disabled:opacity-50"
          disabled={!rename.canRename}
          title={rename.canRename ? undefined : rename.reason}
          onClick={() => {
            if (!rename.canRename) return;
            props.onRenameSession(rename.name);
            setName("");
          }}
        >
          Rename session
        </button>
        {rename.canRename ? null : <span>{rename.reason}</span>}
      </div>
      <div className="flex flex-col gap-1" data-testid="prime-fork-points">
        <label>
          <input
            type="radio"
            name="prime-fork-point"
            aria-label={PRIME_FORK_WHOLE_SESSION_LABEL}
            checked={forkPointId === undefined}
            onChange={() => {
              setForkPointId(undefined);
              setConfirming(false);
            }}
          />
          <span>{PRIME_FORK_WHOLE_SESSION_LABEL}</span>
        </label>
        {view.forkPoints.map((point) => (
          <label key={point.forkPointId} data-testid="prime-fork-point">
            <input
              type="radio"
              name="prime-fork-point"
              aria-label={renderPrimeForkPoint(point)}
              checked={forkPointId === point.forkPointId}
              onChange={() => {
                setForkPointId(point.forkPointId);
                setConfirming(false);
              }}
            />
            <span>{renderPrimeForkPoint(point)}</span>
          </label>
        ))}
        {view.truncated ? (
          <span data-testid="prime-fork-truncated">{PRIME_FORK_TRUNCATED_NOTE}</span>
        ) : null}
      </div>
      <button
        type="button"
        className="rounded-md border px-2 py-0.5 disabled:opacity-50"
        disabled={!fork.canFork}
        title={fork.canFork ? undefined : fork.reason}
        onClick={() => {
          if (!fork.canFork) return;
          setConfirming(true);
        }}
      >
        Fork session
      </button>
      {fork.canFork ? null : <span>{fork.reason}</span>}
      {fork.canFork && confirming ? (
        <div data-testid="prime-fork-disclosure">
          <span>{fork.disclosure}</span>
          <button
            type="button"
            className="rounded-md border px-2 py-0.5"
            onClick={() => {
              setConfirming(false);
              props.onForkSession(forkPointId);
            }}
          >
            Fork into a new thread
          </button>
          <button
            type="button"
            className="rounded-md border px-2 py-0.5"
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}
