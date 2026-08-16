import { useEffect, useReducer } from "react";

import {
  initialPrimeResumeModel,
  primeResumeReduce,
  type PrimeResumeIntent,
  type PrimeResumeModel,
  type PrimeResumeSessionStatus,
} from "@t3tools/client-runtime/prime-resume";
import type { PrimeResumeState } from "@t3tools/contracts";

/**
 * PA-B04 — drives the shared resume reducer from what this client actually
 * knows about the thread.
 *
 * The host's published state is authoritative and always wins. The two local
 * facts the host cannot publish are folded in here: a session that reached a
 * terminal status without ever answering a `reconnecting` (which is what makes
 * a spinner honest instead of eternal), and a dispatched choice that is still
 * in flight. Nothing in here invents a resume outcome.
 */
export function usePrimeResumeModel(input: {
  readonly threadId: string | null | undefined;
  readonly state: PrimeResumeState | undefined;
  readonly sessionStatus: PrimeResumeSessionStatus | undefined;
  readonly connected: boolean;
}): {
  readonly model: PrimeResumeModel;
  readonly noteChoice: (intent: PrimeResumeIntent) => void;
} {
  const [model, dispatch] = useReducer(primeResumeReduce, initialPrimeResumeModel);

  useEffect(() => {
    // Resume state is a per-thread fact: switching threads resets the model so
    // thread A's refusal can never block thread B's composer. The next effect
    // re-applies whatever state the new thread actually has.
    dispatch({ type: "thread" });
  }, [input.threadId]);

  useEffect(() => {
    if (input.state !== undefined) dispatch({ type: "state", state: input.state });
  }, [input.state, input.threadId]);

  useEffect(() => {
    if (input.sessionStatus !== undefined)
      dispatch({ type: "sessionStatus", status: input.sessionStatus });
  }, [input.sessionStatus]);

  useEffect(() => {
    // A dropped connection says nothing about the host's session, only that
    // this client stopped knowing. The reducer downgrades "resumed" to
    // "reconnecting" for exactly that reason.
    if (!input.connected) dispatch({ type: "disconnected" });
  }, [input.connected]);

  return {
    model,
    noteChoice: (intent) => {
      dispatch({ type: "choice", intent });
    },
  };
}
