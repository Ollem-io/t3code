import { useState } from "react";

import {
  PRIME_GOAL_READ_ONLY,
  PRIME_HEARTBEAT_OWNERSHIP_NOTE,
  primeGoalBoardView,
  primeHeartbeatControls,
  primeHeartbeatDraftDecision,
  renderPrimeGoal,
  renderPrimeHeartbeat,
  type PrimeGoalBoard,
  type PrimeGoalCapabilities,
  type PrimeHeartbeat,
  type PrimeSessionLiveness,
} from "./primeHeartbeat";

export interface PrimeHeartbeatPanelProps {
  readonly providerName: string | null | undefined;
  readonly capabilities: PrimeGoalCapabilities | undefined;
  readonly board: PrimeGoalBoard | undefined;
  /** Liveness fact, so a crashed session never offers controls that cannot work. */
  readonly session: PrimeSessionLiveness | undefined;
  readonly onCreateHeartbeat: (draft: {
    readonly title: string;
    readonly intervalSeconds: number;
  }) => void;
  readonly onHeartbeatAction: (
    heartbeat: PrimeHeartbeat,
    action: "heartbeat.pause" | "heartbeat.resume" | "heartbeat.delete",
  ) => void;
}

const DEFAULT_INTERVAL_SECONDS = 1_200;

/**
 * Goal state and T3-owned heartbeats for the current thread.
 *
 * Everything rendered here comes from the latest authoritative board, so every
 * attached client shows the same schedules and the same residency. Creation is
 * a two-step: the daemon consequence is disclosed and confirmed before any
 * command is dispatched, because a session that keeps running after the thread
 * is closed is not something to discover afterwards.
 */
export function PrimeHeartbeatPanel(props: PrimeHeartbeatPanelProps) {
  const [title, setTitle] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(DEFAULT_INTERVAL_SECONDS);
  const [confirming, setConfirming] = useState(false);
  const view = primeGoalBoardView(
    props.providerName,
    props.capabilities,
    props.board,
    props.session,
  );
  if (view.kind === "hidden") return null;
  if (view.kind === "unavailable")
    return (
      <div
        className="px-2 py-1 text-xs text-muted-foreground"
        data-testid="prime-heartbeats-unavailable"
      >
        {view.reason}
      </div>
    );

  const draft = primeHeartbeatDraftDecision(props.board, props.session, props.capabilities, {
    title,
    intervalSeconds,
  });

  return (
    <div className="px-2 py-1 text-xs text-muted-foreground" data-testid="prime-heartbeats">
      {view.goal === undefined ? null : (
        <div data-testid="prime-goal">
          <span>{renderPrimeGoal(view.goal)}</span>
          <span> {PRIME_GOAL_READ_ONLY}</span>
        </div>
      )}
      {view.resident === undefined ? null : (
        <div data-testid="prime-heartbeat-resident">
          {`Resident Prime Agent session owned by ${view.resident.owner}. Stopping the session ends only this T3-owned session.`}
        </div>
      )}
      {view.heartbeats.map((heartbeat) => (
        <div
          key={heartbeat.heartbeatId}
          className="flex items-center gap-2"
          data-testid="prime-heartbeat-row"
        >
          <span>{renderPrimeHeartbeat(heartbeat)}</span>
          {primeHeartbeatControls(heartbeat, props.session, props.capabilities).map((control) => (
            <button
              key={control.action}
              type="button"
              className="rounded-md border px-2 py-0.5 disabled:opacity-50"
              disabled={!control.enabled}
              title={control.reason}
              onClick={() => {
                props.onHeartbeatAction(heartbeat, control.action);
              }}
            >
              {control.label}
            </button>
          ))}
        </div>
      ))}
      <div>{PRIME_HEARTBEAT_OWNERSHIP_NOTE}</div>
      <div className="flex items-center gap-2" data-testid="prime-heartbeat-draft">
        <input
          aria-label="Heartbeat name"
          value={title}
          onChange={(event) => {
            setTitle(event.target.value);
            setConfirming(false);
          }}
        />
        <input
          aria-label="Heartbeat interval in minutes"
          type="number"
          value={Math.round(intervalSeconds / 60)}
          onChange={(event) => {
            setIntervalSeconds(Math.round(Number(event.target.value) * 60));
            setConfirming(false);
          }}
        />
        <button
          type="button"
          className="rounded-md border px-2 py-0.5 disabled:opacity-50"
          disabled={!draft.canCreate}
          title={draft.canCreate ? undefined : draft.reason}
          onClick={() => {
            if (!draft.canCreate) return;
            setConfirming(true);
          }}
        >
          Create heartbeat
        </button>
        {draft.canCreate ? null : <span>{draft.reason}</span>}
      </div>
      {draft.canCreate && confirming ? (
        <div data-testid="prime-heartbeat-disclosure">
          <span>{draft.disclosure}</span>
          <button
            type="button"
            className="rounded-md border px-2 py-0.5"
            onClick={() => {
              setConfirming(false);
              props.onCreateHeartbeat({ title: title.trim(), intervalSeconds });
              setTitle("");
            }}
          >
            Create and keep resident
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
