// @effect-diagnostics nodeBuiltinImport:off
// Native request timeouts live on the same promise-based drain as the RPC
// client, which is why the wall-clock timer is a plain `setTimeout` here.
// @effect-diagnostics globalTimers:off
import * as NodeFSP from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  PROVIDER_SEND_TURN_MAX_TEXT_ATTACHMENT_BYTES,
  ProviderDriverKind,
  type PrimeAgentSettings,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderRuntimeOperation,
  type ProviderSession,
  type ProviderSessionStartInput,
  RuntimeTaskId,
  GoalId,
  HeartbeatId,
  RuntimeExtensionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { attachmentBelongsToThread, resolveAttachmentPath } from "../../attachmentStore.ts";

import {
  ProviderAdapterProcessError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { PrimeRpcClient } from "../prime/PrimeRpcClient.ts";
import { PrimeRpcForkMessagesResponse } from "../prime/PrimeRpcProtocol.ts";
import type { PrimeRpcForkMessage } from "../prime/PrimeRpcProtocol.ts";
import { spawnPrimeRpcTransport } from "../prime/PrimeRpcProcessTransport.ts";
import { primeHomeFingerprint, primeResourceLayout } from "../prime/PrimeResourceLayout.ts";
import {
  isPrimeOwnableHeartbeatId,
  primeThreadOwnershipRecord,
  readPrimeOwnedHeartbeatIds,
  recoverPrimeInstanceOwnership,
  writePrimeOwnership,
} from "../prime/PrimeOwnership.ts";
import { provePrimeProcess, stopProvenPrimeProcess } from "../prime/PrimeProcessOwnership.ts";
import { PrimeEventNormalizer } from "../prime/PrimeEventNormalizer.ts";
import {
  PRIME_COMPACT_COMMAND,
  PRIME_SESSION_STATS_COMMAND,
  normalizePrimeSessionStats,
} from "../prime/PrimeCompaction.ts";
import { PRIME_GET_COMMANDS_COMMAND, PrimeCommandCache } from "../prime/PrimeCommands.ts";
import {
  EMPTY_PRIME_SESSION_IDENTITY,
  primeForkDecision,
  primeForkRefusalMessage,
  primeRenameDecision,
  primeRenameRefusalMessage,
  primeSessionIdentity,
  primeSessionIdentityFingerprint,
  type PrimeSessionIdentity,
} from "../prime/PrimeFork.ts";
import {
  applyPrimeNotice,
  isBlockingPrimeUiRequest,
  primeRequestTimeoutMs,
  primeRequestTimeoutReason,
  type PrimeExtensionUiRequest,
  type PrimeNotice,
} from "../prime/PrimeExtensionUi.ts";
import {
  findOwnedPrimeAgent,
  isTerminalPrimeAgentStatus,
  primeAgentRoster,
  primeAgentRosterFingerprint,
  primeObservationDecision,
  primeObservationRefusalMessage,
  type PrimeAgentRosterEntry,
} from "../prime/PrimeObservation.ts";
import {
  EMPTY_PRIME_GOAL_BOARD,
  MAX_PRIME_HEARTBEATS,
  PRIME_GOAL_MUTATION_REFUSAL,
  primeGoalBoard,
  primeOwnedHeartbeats,
  primeGoalBoardFingerprint,
  primeHeartbeatCreateDecision,
  primeHeartbeatDecision,
  primeHeartbeatRefusalMessage,
  type PrimeGoalBoard,
  type PrimeNativeGoal,
  type PrimeNativeHeartbeat,
} from "../prime/PrimeGoalsHeartbeats.ts";

const PROVIDER = ProviderDriverKind.make("prime-agent");
const HANDSHAKE_TIMEOUT_MS = 5_000;
const MAX_PENDING_REQUESTS = 128;
const MAX_NATIVE_STRING = 4_096;
const MAX_SELECT_OPTIONS = 64;
const cleanNative = (value: string, fallback = ""): string => {
  const text = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text.slice(0, MAX_NATIVE_STRING) || fallback;
};
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const isProviderAdapterValidationError = Schema.is(ProviderAdapterValidationError);

type SessionContext = {
  readonly key: string;
  readonly session: ProviderSession;
  readonly client: PrimeRpcClient;
  readonly transport: ReturnType<typeof spawnPrimeRpcTransport>;
  selectedModel: { readonly provider: string; readonly modelId: string } | undefined;
  thinkingLevel: string | undefined;
  readonly normalizer: PrimeEventNormalizer;
  readonly commands: PrimeCommandCache;
  readonly ownershipPath: string;
  readonly processIdentity: { readonly pid: number; readonly startToken: string } | undefined;
  eventDrain: Promise<void> | undefined;
  readonly pendingRequests: Map<
    string,
    {
      readonly method: "select" | "confirm" | "input" | "editor";
      /** Canonical dialog this request was projected as, so cancellation can close it. */
      readonly kind: "request" | "user-input";
      readonly title: string;
      readonly options: ReadonlyArray<string>;
      readonly timeout: ReturnType<typeof setTimeout> | undefined;
      /**
       * A native response for this id is in flight. The request timeout can
       * fire during that round trip; answering it then would put a second
       * `extension_ui_response` on the wire for one correlation id and emit a
       * contradicting resolution, so the timeout only records itself here and
       * the responder applies it if its own attempt failed.
       */
      responding: boolean;
      timedOutReason: string | undefined;
    }
  >;
  /** Bounded transient status, insertion-ordered and replaced by key. */
  readonly notices: Map<string, PrimeNotice>;
  noticesFingerprint: string;
  /** Bounded root/subagent roster, exactly as the runtime last reported it. */
  agents: ReadonlyArray<PrimeAgentRosterEntry>;
  agentsFingerprint: string;
  /** Ids this environment holds an observation on; the roster is the authority on which are real. */
  readonly observedAgents: Set<string>;
  /** Last native goal snapshot, unfiltered; the board is derived from it. */
  nativeGoal: PrimeNativeGoal | undefined;
  /** Last native heartbeat store, including schedules T3 does not own. */
  nativeHeartbeats: ReadonlyArray<PrimeNativeHeartbeat>;
  /** Whether the runtime reports this session as resident because of a schedule. */
  resident: boolean;
  /** Ids of heartbeats this environment created. The only legal action targets. */
  readonly ownedHeartbeats: Set<string>;
  /**
   * Serializes heartbeat mutations for this session.
   *
   * Every heartbeat action decides against the owned set and then awaits the
   * runtime. Two concurrent creates would both pass a bound check taken before
   * their awaits and produce one more real schedule than the record can hold,
   * so the whole decide-act-persist sequence runs one at a time.
   */
  heartbeatMutations: Promise<void>;
  goalBoard: PrimeGoalBoard;
  goalBoardFingerprint: string;
  /** The name the runtime last reported for this session, if it has one. */
  sessionName: string | undefined;
  /** The runtime's last fork-message list, unfiltered; the card is derived from it. */
  forkMessages: ReadonlyArray<PrimeRpcForkMessage>;
  identityCard: PrimeSessionIdentity;
  identityFingerprint: string;
};
type PendingStart = { readonly key: string; readonly promise: Promise<ProviderSession> };

export interface PrimeAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environmentId: string;
  readonly home: string;
  readonly enabled: boolean;
  readonly environment?: NodeJS.ProcessEnv;
  readonly attachmentsDir?: string;
  readonly handshakeTimeoutMs?: number;
  readonly launch?: typeof spawnPrimeRpcTransport;
}

const startKey = (input: ProviderSessionStartInput, cwd: string) =>
  JSON.stringify({
    cwd,
    runtimeMode: input.runtimeMode,
    provider: input.provider,
    providerInstanceId: input.providerInstanceId,
    model: input.modelSelection?.model,
    nativeIdentity: input.modelSelection?.nativeIdentity,
  });

const sanitizedEnvironment = (
  home: string,
  source: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv => {
  const result: NodeJS.ProcessEnv = {};
  const allowed = /^(?:PATH|PATHEXT|SystemRoot|WINDIR|ComSpec|LANG|LC_[A-Za-z0-9_]+)$/i;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && allowed.test(key)) result[key] = value;
  }
  return {
    ...result,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: `${home}/.config`,
    XDG_DATA_HOME: `${home}/.local/share`,
    XDG_STATE_HOME: `${home}/.local/state`,
    TMPDIR: `${home}/tmp`,
    TMP: `${home}/tmp`,
    TEMP: `${home}/tmp`,
  };
};

const resolvePrimeAttachmentPath = (
  attachmentsDir: string,
  threadId: ThreadId,
  attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
) =>
  attachmentBelongsToThread(attachment.id, threadId)
    ? (resolveAttachmentPath({ attachmentsDir, attachment }) ?? undefined)
    : undefined;

/**
 * Reads the fork-point list out of a native answer, or nothing at all.
 *
 * Returning `undefined` rather than throwing at the protocol boundary is the
 * point: naming and forking are optional, and a runtime that answers this probe
 * in a shape T3 does not recognize should lose the fork page, not the session.
 */
const decodePrimeForkMessages = (
  response: unknown,
): ReadonlyArray<PrimeRpcForkMessage> | undefined => {
  const decoded = Schema.decodeUnknownResult(PrimeRpcForkMessagesResponse)(response);
  return Result.isSuccess(decoded) ? decoded.success.data.messages : undefined;
};

export const makePrimeAdapter = (
  settings: PrimeAgentSettings,
  options: PrimeAdapterOptions,
): Effect.Effect<ProviderAdapterShape<ProviderAdapterError>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const launch = options.launch ?? spawnPrimeRpcTransport;
    const sessions = new Map<ThreadId, SessionContext>();
    const pending = new Map<ThreadId, PendingStart>();
    const runtimeEvents = yield* Queue.bounded<ProviderRuntimeEvent>(1_024);
    let closed = false;
    const offerEvents = async (events: ReadonlyArray<ProviderRuntimeEvent>) => {
      for (const event of events) await Effect.runPromise(Queue.offer(runtimeEvents, event));
    };
    /**
     * Publishes the board only when it actually changed. Extensions repeat the
     * same status string constantly; a byte-identical board must not cost a
     * canonical event, a projection write, or a client repaint.
     */
    /**
     * Sessions this adapter forked, waiting for the T3 thread they were made
     * for to open.
     *
     * A fork produces a Prime session immediately; the thread that owns it
     * starts moments later, in this same process. The handoff is therefore
     * process-local, bounded, and one-shot: it is spent by the first session
     * start for that thread and expires on its own, so a restart or an
     * abandoned fork degrades to a fresh session rather than to a stale
     * pointer. Nothing here is durable and nothing here is a resume cursor.
     */
    const forkHandoffs = new Map<
      string,
      { readonly sessionId: string; readonly expiresAt: number }
    >();
    const FORK_HANDOFF_TTL_MS = 600_000;
    const MAX_FORK_HANDOFFS = 8;
    const recordForkHandoff = async (threadId: string, sessionId: string) => {
      const now = await Effect.runPromise(Clock.currentTimeMillis);
      for (const [key, handoff] of forkHandoffs)
        if (handoff.expiresAt <= now) forkHandoffs.delete(key);
      // Bounded on purpose: an unbounded map of pointers to sessions nobody
      // opened is a slow leak. The oldest entry loses, and its thread simply
      // starts a fresh session.
      while (forkHandoffs.size >= MAX_FORK_HANDOFFS) {
        const oldest = forkHandoffs.keys().next();
        if (oldest.done) break;
        forkHandoffs.delete(oldest.value);
      }
      forkHandoffs.set(threadId, { sessionId, expiresAt: now + FORK_HANDOFF_TTL_MS });
    };
    const takeForkHandoff = async (threadId: string): Promise<string | undefined> => {
      const handoff = forkHandoffs.get(threadId);
      if (!handoff) return undefined;
      forkHandoffs.delete(threadId);
      const now = await Effect.runPromise(Clock.currentTimeMillis);
      return handoff.expiresAt > now ? handoff.sessionId : undefined;
    };
    const publishNotices = async (context: SessionContext) => {
      const notices = Array.from(context.notices.values());
      const fingerprint = JSON.stringify(notices);
      if (fingerprint === context.noticesFingerprint) return;
      context.noticesFingerprint = fingerprint;
      await offerEvents(context.normalizer.noticesSnapshot({ notices }));
    };
    /**
     * Publishes the roster only when it actually changed. A task store that
     * re-reports the same rows must not cost a canonical event, a projection
     * write, or a client repaint.
     */
    const publishAgents = async (context: SessionContext) => {
      const fingerprint = primeAgentRosterFingerprint(context.agents);
      if (fingerprint === context.agentsFingerprint) return;
      context.agentsFingerprint = fingerprint;
      await offerEvents(
        context.normalizer.agentsSnapshot({
          agents: context.agents.map((agent) => ({
            ...agent,
            agentId: RuntimeTaskId.make(agent.agentId),
          })),
        }),
      );
    };
    /**
     * Rebuilds the owned board and publishes it only when it actually changed.
     *
     * The board is derived, never accumulated: the native store plus the set of
     * ids this environment created produce it every time, so a schedule that
     * stopped being ours simply stops appearing.
     */
    const publishGoals = async (context: SessionContext) => {
      const board = primeGoalBoard({
        goal: context.nativeGoal,
        heartbeats: context.nativeHeartbeats,
        owned: context.ownedHeartbeats,
        resident: context.resident,
        owner: `T3 thread ${String(context.session.threadId)}`,
      });
      const fingerprint = primeGoalBoardFingerprint(board);
      if (fingerprint === context.goalBoardFingerprint) return;
      context.goalBoard = board;
      context.goalBoardFingerprint = fingerprint;
      await offerEvents(
        context.normalizer.goalsSnapshot({
          ...(board.goal
            ? { goal: { ...board.goal, goalId: GoalId.make(board.goal.goalId) } }
            : {}),
          heartbeats: board.heartbeats.map((heartbeat) => ({
            ...heartbeat,
            heartbeatId: HeartbeatId.make(heartbeat.heartbeatId),
          })),
          ...(board.resident ? { resident: board.resident } : {}),
        }),
      );
    };
    /**
     * Rebuilds the identity card and publishes it only when it changed.
     *
     * The card is derived, never accumulated: the runtime's current name plus
     * its current fork-message list produce it every time, so a fork point the
     * runtime stopped reporting simply stops being offered.
     */
    const publishIdentity = async (context: SessionContext) => {
      const card = primeSessionIdentity({
        ...(context.sessionName ? { name: context.sessionName } : {}),
        messages: context.forkMessages,
      });
      const fingerprint = primeSessionIdentityFingerprint(card);
      if (fingerprint === context.identityFingerprint) return;
      context.identityCard = card;
      context.identityFingerprint = fingerprint;
      await offerEvents(
        context.normalizer.identitySnapshot({
          ...(card.name ? { name: card.name } : {}),
          forkPoints: card.forkPoints.map((point) => ({
            ...point,
            forkPointId: RuntimeExtensionId.make(point.forkPointId),
          })),
          ...(card.truncated ? { truncated: true as const } : {}),
        }),
      );
    };
    /**
     * Re-reads the fork-point page from the runtime.
     *
     * Called once at session start and once per finished turn rather than
     * polled: a turn is exactly when new fork points appear, and a page that is
     * one turn stale would offer a choice the runtime no longer has.
     */
    const refreshForkPoints = async (context: SessionContext) => {
      const response = await context.client.command({ type: "get_fork_messages" });
      if (!response.success || response.command !== "get_fork_messages")
        throw new Error("get_fork_messages failed");
      // An answer this build cannot read leaves the page exactly as it was. The
      // alternative — failing the envelope closed, the way the heartbeat store
      // does — would cost the whole session over an optional probe.
      const messages = decodePrimeForkMessages({ ...response, command: "get_fork_messages" });
      if (!messages) throw new Error("get_fork_messages answered an unreadable shape");
      context.forkMessages = messages;
      await publishIdentity(context);
    };
    /**
     * Records the exact ids of the heartbeats this session owns.
     *
     * This is the whole ownership handle: cleanup later stops these ids and
     * nothing else, so a schedule made in the TUI or by another T3 thread is
     * untouchable even by a cleanup pass that runs over the same daemon.
     */
    /**
     * Runs one heartbeat mutation at a time for a session.
     *
     * Each mutation decides against the owned set, awaits the runtime, and then
     * rewrites the record. Interleaving two of them could create one more real
     * schedule than the eight-handle record can hold, and the surplus id would
     * be lost the moment the write refused it.
     */
    const serializeHeartbeat = <A>(context: SessionContext, run: () => Promise<A>): Promise<A> => {
      const next = context.heartbeatMutations.then(run, run);
      context.heartbeatMutations = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    };
    const persistHeartbeatOwnership = async (context: SessionContext) => {
      if (!context.processIdentity) return;
      await writePrimeOwnership(
        context.ownershipPath,
        primeThreadOwnershipRecord({
          environmentId: options.environmentId,
          instanceId: String(options.instanceId),
          threadId: String(context.session.threadId),
          process: context.processIdentity,
          ownedHeartbeatIds: context.ownedHeartbeats,
        }),
      );
    };
    /**
     * Resolves one pending dialog as cancelled. `answerNative` is false during
     * teardown, where the child is already gone and a response would be a lie
     * about a channel that no longer exists.
     */
    const dropPendingRequest = (context: SessionContext, id: string) => {
      const pending = context.pendingRequests.get(id);
      if (!pending) return undefined;
      context.pendingRequests.delete(id);
      if (pending.timeout !== undefined) clearTimeout(pending.timeout);
      return pending;
    };
    const cancelPendingRequest = async (
      context: SessionContext,
      id: string,
      reason: string,
      answerNative = true,
    ) => {
      const inFlight = context.pendingRequests.get(id);
      if (inFlight?.responding) {
        // A response is already on the wire for this id. Record the reason and
        // let the responder apply it only if its own attempt failed, so one
        // correlation id never receives two answers or two resolutions.
        inFlight.timedOutReason = reason;
        return;
      }
      const pending = dropPendingRequest(context, id);
      if (!pending) return;
      if (answerNative)
        await context.client
          .command({ type: "extension_ui_response", cancelled: true }, { requestId: id })
          .catch(() => undefined);
      await offerEvents(context.normalizer.cancelled(id, reason, pending.kind));
    };
    const cancelPendingDialogs = async (context: SessionContext, reason: string) => {
      for (const id of Array.from(context.pendingRequests.keys()))
        await cancelPendingRequest(context, id, reason, false);
    };
    /**
     * Honours a native request timeout, clamped by the shipped mapper so an
     * absurd value cannot produce a dialog nobody can answer or one that never
     * closes.
     */
    const armRequestTimeout = (context: SessionContext, id: string, timeout: unknown) => {
      const ms = primeRequestTimeoutMs(timeout);
      if (ms === undefined) return undefined;
      const handle = setTimeout(() => {
        void cancelPendingRequest(context, id, primeRequestTimeoutReason(ms));
      }, ms);
      // A pending dialog must never hold the process open on its own.
      handle.unref?.();
      return handle;
    };
    // Startup recovery is proof-before-action. The adapter has no authority to
    // guess identities; only transports that expose an exact identity may be
    // used for destructive cleanup below.
    const ownershipRoot = primeResourceLayout({
      home: options.home,
      environmentId: options.environmentId,
      instanceId: options.instanceId,
      threadId: "__startup__",
    }).root;
    yield* Effect.promise(() => NodeFSP.mkdir(ownershipRoot, { recursive: true, mode: 0o700 }));
    const recoveryActions = yield* Effect.promise(() =>
      recoverPrimeInstanceOwnership(
        ownershipRoot,
        { environmentId: options.environmentId, instanceId: String(options.instanceId) },
        {
          processMatches: provePrimeProcess,
          rpcSessionMatches: async () => false,
          daemonSessionMatches: async () => false,
        },
        {
          stopProcess: async (handle) => {
            if (!(await stopProvenPrimeProcess(handle)))
              throw new Error("process identity changed or unavailable");
          },
          // Platform storage owns filesystem deletion. Until an anchored native implementation is available,
          // retain records/resources while still safely stopping proven processes.
          removeOwnedResource: async () => "retained",
        },
      ),
    );
    for (const action of recoveryActions) {
      if (action.kind === "warning")
        yield* Effect.logWarning("prime.ownership.recovery-retained", {
          homeFingerprint: primeHomeFingerprint(options.home),
          reasonClass: "proof-or-storage-unavailable",
        });
    }

    const closeContext = async (context: SessionContext) => {
      context.client.close();
      await Promise.resolve(context.transport.close?.()).catch(() => undefined);
      await context.transport.terminal.catch(() => undefined);
      if (context.processIdentity) {
        // Heartbeat handles outlive the process on purpose: a resident
        // schedule that survives this session must stay exactly identified so
        // a later cleanup can stop ours and only ours.
        await writePrimeOwnership(
          context.ownershipPath,
          primeThreadOwnershipRecord({
            environmentId: options.environmentId,
            instanceId: String(options.instanceId),
            threadId: String(context.session.threadId),
            process: context.processIdentity,
            ownedHeartbeatIds: context.ownedHeartbeats,
            processStopped: true,
          }),
        ).catch(() => undefined);
      }
    };

    const startOwned = async (
      input: ProviderSessionStartInput,
      cwd: string,
      key: string,
      timestamp: string,
    ): Promise<ProviderSession> => {
      const layout = primeResourceLayout({
        home: options.home,
        environmentId: options.environmentId,
        instanceId: options.instanceId,
        threadId: input.threadId,
      });
      await NodeFSP.mkdir(layout.session, { recursive: true, mode: 0o700 });
      const env = sanitizedEnvironment(layout.instance, options.environment ?? process.env);
      await NodeFSP.mkdir(env.TMPDIR!, { recursive: true, mode: 0o700 });
      if (closed)
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Prime Agent adapter is closed.",
        });
      const transport = launch(
        settings.binaryPath,
        ["--mode", "rpc", "--session-dir", layout.session],
        { cwd, env },
      );
      const client = new PrimeRpcClient(transport, {
        defaultTimeoutMs: options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS,
        requestIdPrefix: "t3-prime-bootstrap",
      });
      const processIdentity = await transport.processIdentityReady?.catch(() => undefined);
      // A heartbeat this thread created outlives the session that made it, and
      // the ownership record is thread-scoped, so the handles recorded by the
      // previous session are rehydrated before this session replaces the
      // record. Writing `[]` here would erase the only exact ids that keep a
      // still-resident T3-created schedule listable, pausable, stoppable and
      // provable — the daemon would stay up with no reverse control anywhere.
      const rehydratedHeartbeatIds = [
        ...new Set(
          (await readPrimeOwnedHeartbeatIds(layout.ownership).catch(() => [])).filter(
            isPrimeOwnableHeartbeatId,
          ),
        ),
      ].slice(0, MAX_PRIME_HEARTBEATS);
      if (processIdentity) {
        await writePrimeOwnership(
          layout.ownership,
          primeThreadOwnershipRecord({
            environmentId: options.environmentId,
            instanceId: String(options.instanceId),
            threadId: String(input.threadId),
            process: processIdentity,
            ownedHeartbeatIds: rehydratedHeartbeatIds,
          }),
        );
      }
      try {
        const response = await client.command({ type: "get_state" });
        if (!response.success || response.command !== "get_state")
          throw new Error("get_state failed");
        if (closed) throw new Error("adapter closed during bootstrap");
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        const normalizer = new PrimeEventNormalizer(input.threadId, {
          providerInstanceId: options.instanceId,
        });
        const context: SessionContext = {
          key,
          session,
          client,
          transport,
          selectedModel: undefined,
          thinkingLevel: undefined,
          normalizer,
          commands: new PrimeCommandCache(),
          eventDrain: undefined,
          pendingRequests: new Map(),
          notices: new Map(),
          noticesFingerprint: "[]",
          agents: [],
          agentsFingerprint: "[]",
          observedAgents: new Set(),
          nativeGoal: undefined,
          nativeHeartbeats: [],
          resident: false,
          ownedHeartbeats: new Set(rehydratedHeartbeatIds),
          heartbeatMutations: Promise.resolve(),
          goalBoard: EMPTY_PRIME_GOAL_BOARD,
          goalBoardFingerprint: primeGoalBoardFingerprint(EMPTY_PRIME_GOAL_BOARD),
          sessionName: undefined,
          forkMessages: [],
          identityCard: EMPTY_PRIME_SESSION_IDENTITY,
          identityFingerprint: primeSessionIdentityFingerprint(EMPTY_PRIME_SESSION_IDENTITY),
          ownershipPath: layout.ownership,
          processIdentity,
        };
        sessions.set(input.threadId, context);
        context.eventDrain = (async () => {
          for await (const envelope of client.events()) {
            let canonicalEnvelope = true;
            // An extension UI record this build cannot decode never reaches
            // here: the strict transport fails the session closed, which is the
            // one behaviour that cannot leave a client waiting on a dialog it
            // will never be able to answer.
            if (envelope._tag === "known-event" && envelope.value.type === "task_update") {
              // The task store is current state, not transcript: a subagent's
              // work is projected onto its own roster row and never copied into
              // the thread timeline.
              canonicalEnvelope = false;
              context.agents = primeAgentRoster(envelope.value.tasks, context.observedAgents);
              // An observation cannot survive the agent it was attached to.
              for (const agentId of [...context.observedAgents]) {
                const agent = findOwnedPrimeAgent(context.agents, agentId);
                if (!agent || isTerminalPrimeAgentStatus(agent.status))
                  context.observedAgents.delete(agentId);
              }
              await publishAgents(context);
            } else if (envelope._tag === "known-event" && envelope.value.type === "goal_update") {
              // Goal state is a status board, not transcript, and it is
              // read-only: Prime reports progress and T3 shows it.
              canonicalEnvelope = false;
              context.nativeGoal = envelope.value.goal;
              await publishGoals(context);
            } else if (
              envelope._tag === "known-event" &&
              envelope.value.type === "heartbeat_update"
            ) {
              canonicalEnvelope = false;
              context.nativeHeartbeats = envelope.value.heartbeats;
              context.resident = envelope.value.resident === true;
              // Ownership cannot outlive the heartbeat it named. A schedule the
              // runtime no longer reports is dropped from the owned set, so a
              // stale id can never become a live action target again.
              const present = new Set(
                envelope.value.heartbeats.map((heartbeat) => heartbeat.heartbeatId),
              );
              for (const heartbeatId of [...context.ownedHeartbeats])
                if (!present.has(heartbeatId)) context.ownedHeartbeats.delete(heartbeatId);
              await publishGoals(context);
            } else if (
              envelope._tag === "known-event" &&
              envelope.value.type === "session_name_update"
            ) {
              // The session name is identity, not transcript. An absent name
              // means the session has none; T3 never keeps a name the runtime
              // dropped.
              canonicalEnvelope = false;
              context.sessionName = envelope.value.name;
              await publishIdentity(context);
            } else if (
              envelope._tag === "known-event" &&
              envelope.value.type === "extension_ui_request"
            ) {
              const request: PrimeExtensionUiRequest = envelope.value;
              if (!isBlockingPrimeUiRequest(request)) {
                // Fire-and-forget UI operations. They describe *now*, so they go
                // to the bounded transient board instead of the transcript, and
                // they are never answered: there is nothing to answer.
                canonicalEnvelope = false;
                applyPrimeNotice(context.notices, request);
                await publishNotices(context);
              } else if (context.pendingRequests.has(request.id)) {
                // A duplicate native correlation id is malformed protocol state: cancelling it could
                // accidentally resolve the original request. Fail this exact session closed instead.
                canonicalEnvelope = false;
                client.close();
                await Promise.resolve(transport.close?.()).catch(() => undefined);
                for (const event of normalizer.cancelled(
                  request.id,
                  "Prime Agent interactive request reused an active correlation id; the session was closed.",
                ))
                  await Effect.runPromise(Queue.offer(runtimeEvents, event));
              } else if (context.pendingRequests.size >= MAX_PENDING_REQUESTS) {
                canonicalEnvelope = false;
                await client
                  .command(
                    { type: "extension_ui_response", cancelled: true },
                    { requestId: request.id },
                  )
                  .catch(() => undefined);
                for (const event of normalizer.cancelled(
                  request.id,
                  "Prime Agent interactive request was cancelled because the request limit was reached.",
                ))
                  await Effect.runPromise(Queue.offer(runtimeEvents, event));
              } else {
                const nativeTimeout = "timeout" in request ? request.timeout : undefined;
                context.pendingRequests.set(request.id, {
                  method: request.method,
                  kind: request.method === "confirm" ? "request" : "user-input",
                  title: cleanNative(request.title, "Prime Agent request"),
                  options:
                    request.method === "select"
                      ? request.options
                          .slice(0, MAX_SELECT_OPTIONS)
                          .map((x) => cleanNative(x, "Option"))
                      : [],
                  timeout: armRequestTimeout(context, request.id, nativeTimeout),
                  responding: false,
                  timedOutReason: undefined,
                });
              }
            }
            for (const event of canonicalEnvelope ? normalizer.drain(envelope) : []) {
              await Effect.runPromise(Queue.offer(runtimeEvents, event));
            }
            // A finished turn is exactly when new fork points appear. Best
            // effort: a runtime that does not answer keeps the page it had
            // rather than losing the ones it already published.
            if (envelope._tag === "known-event" && envelope.value.type === "turn_end")
              await refreshForkPoints(context).catch(() => undefined);
          }
        })();
        void transport.terminal.then(async (terminal) => {
          if (sessions.get(input.threadId) !== context) return;
          await context.eventDrain;
          if (sessions.get(input.threadId) !== context) return;
          sessions.delete(input.threadId);
          // A dialog whose runtime just died is cancelled, not left pending: an
          // unanswerable modal on every attached client is the worst outcome.
          await cancelPendingDialogs(
            context,
            "Prime Agent interactive request was cancelled because the session ended.",
          );
          if (context.processIdentity)
            // The child can exit while a T3-created schedule keeps the daemon
            // resident. This record is the last write for this session — the
            // context is already removed from `sessions`, so closeContext will
            // never run — and dropping the handles here would leave the exact
            // resource we own permanently unidentifiable to cleanup.
            await writePrimeOwnership(
              context.ownershipPath,
              primeThreadOwnershipRecord({
                environmentId: options.environmentId,
                instanceId: String(options.instanceId),
                threadId: String(input.threadId),
                process: context.processIdentity,
                ownedHeartbeatIds: context.ownedHeartbeats,
                processStopped: true,
              }),
            ).catch(() => undefined);
          const graceful = terminal.kind === "exit" && terminal.code === 0;
          const reason =
            terminal.kind === "exit" && terminal.code !== null
              ? `Prime Agent exited with code ${terminal.code}.`
              : "Prime Agent RPC session exited.";
          const terminalEvents = graceful
            ? normalizer.finishGracefully(reason)
            : normalizer.stop(reason);
          for (const event of terminalEvents) {
            await Effect.runPromise(Queue.offer(runtimeEvents, event));
          }
        });
        // A fork this adapter made for this thread is adopted now, in the same
        // process that made it, by asking the runtime for a session whose
        // parent is that fork. It is spent whether or not it works: a pointer
        // that failed once must not be retried forever, and a thread whose
        // handoff expired simply starts fresh — truthfully, with an empty
        // identity card rather than an inherited one.
        const forkedParent = await takeForkHandoff(String(input.threadId));
        if (forkedParent !== undefined)
          await context.client
            .command({ type: "new_session", parentSession: forkedParent })
            .catch(() => undefined);
        // Discovery is best effort and never gates session readiness: a runtime
        // that does not answer `get_commands` simply offers no catalog, and the
        // capability-gated surfaces stay hidden.
        await discoverCommands(context).catch(() => undefined);
        // The identity card is read once at start for the same reason: a
        // runtime that does not answer offers no rename or fork controls
        // instead of empty ones that would fail.
        await refreshForkPoints(context).catch(() => undefined);
        // A handle carried over from a previous session is only half of the
        // reverse path: the board is derived from the native store, so without
        // a resync the rehydrated heartbeat stays invisible and untargetable
        // until the daemon happens to push an update. Reading the store once
        // also prunes handles whose schedule is genuinely gone, so the record
        // never keeps an id cleanup could not prove. Best effort, like
        // discovery: a runtime that does not answer leaves the board empty
        // rather than failing the session.
        if (rehydratedHeartbeatIds.length > 0)
          await heartbeatSnapshot(context, { type: "heartbeat_get" })
            .then(async () => {
              await persistHeartbeatOwnership(context);
              await publishGoals(context);
            })
            .catch(() => undefined);
        return session;
      } catch (cause) {
        client.close();
        transport.close?.();
        await transport.terminal.catch(() => undefined);
        throw new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: "Prime Agent RPC readiness handshake failed.",
          cause,
        });
      }
    };

    const validateStart = async (input: ProviderSessionStartInput) => {
      if (!options.enabled)
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Prime Agent is disabled.",
        });
      if (closed)
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Prime Agent adapter is closed.",
        });
      if (input.provider !== undefined && input.provider !== PROVIDER)
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Provider does not match prime-agent.",
        });
      if (input.providerInstanceId !== undefined && input.providerInstanceId !== options.instanceId)
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Provider instance does not match adapter.",
        });
      if (input.resumeCursor !== undefined)
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Prime Agent resume is unavailable until Beta.",
        });
      if (!input.cwd || !isAbsolute(input.cwd))
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "An absolute workspace cwd is required.",
        });
      const stat = await NodeFSP.stat(input.cwd).catch(() => undefined);
      if (!stat?.isDirectory())
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Workspace cwd must be an existing directory.",
        });
      return input.cwd;
    };

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      nowIso.pipe(
        Effect.flatMap((timestamp) =>
          Effect.tryPromise({
            try: async () => {
              const cwd = await validateStart(input);
              const key = startKey(input, cwd);
              const live = sessions.get(input.threadId);
              if (live) {
                if (live.key !== key)
                  throw new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "startSession",
                    issue: "Thread already has a different Prime session binding.",
                  });
                return live.session;
              }
              const inFlight = pending.get(input.threadId);
              if (inFlight) {
                if (inFlight.key !== key)
                  throw new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "startSession",
                    issue: "Thread has a conflicting pending Prime start.",
                  });
                return inFlight.promise;
              }
              const promise = startOwned(input, cwd, key, timestamp).finally(() => {
                if (pending.get(input.threadId)?.promise === promise)
                  pending.delete(input.threadId);
              });
              pending.set(input.threadId, { key, promise });
              return promise;
            },
            catch: (cause) =>
              cause instanceof ProviderAdapterValidationError ||
              cause instanceof ProviderAdapterProcessError
                ? cause
                : new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: "Prime Agent RPC process could not be started.",
                    cause,
                  }),
          }),
        ),
      );

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      Effect.tryPromise({
        try: async () => {
          await pending.get(threadId)?.promise.catch(() => undefined);
          const context = sessions.get(threadId);
          if (!context) return;
          sessions.delete(threadId);
          await closeContext(context);
          await context.eventDrain;
          await cancelPendingDialogs(
            context,
            "Prime Agent interactive request was cancelled because the session was stopped.",
          );
          for (const event of context.normalizer.stop("Prime Agent session was stopped.")) {
            await Effect.runPromise(Queue.offer(runtimeEvents, event));
          }
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: "Prime Agent RPC process did not stop cleanly.",
            cause,
          }),
      });

    const requireContext = (threadId: ThreadId): SessionContext => {
      const context = sessions.get(threadId);
      if (!context) throw new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      return context;
    };

    const expectSuccess = async (
      context: SessionContext,
      command: Parameters<PrimeRpcClient["command"]>[0],
      commandOptions?: Parameters<PrimeRpcClient["command"]>[1],
    ) => {
      const response = await context.client.command(command, commandOptions);
      if (!response.success || response.command !== command.type)
        throw new Error(`${command.type} failed`);
    };

    const commandData = async (
      context: SessionContext,
      command: Parameters<PrimeRpcClient["command"]>[0],
    ) => {
      const response = await context.client.command(command);
      if (!response.success || response.command !== command.type)
        throw new Error(`${command.type} failed`);
      return response.data;
    };

    /**
     * Runs one heartbeat command that answers with the store, and adopts that
     * answer as the session's native state.
     *
     * The response is the authority for both the schedules and residency: T3
     * never infers "still resident" from the fact that it once created a
     * heartbeat, because the reverse control has to point at something real.
     */
    const heartbeatSnapshot = async (
      context: SessionContext,
      command:
        | {
            readonly type: "heartbeat_create";
            readonly title: string;
            readonly intervalSeconds: number;
          }
        | { readonly type: "heartbeat_get" },
    ): Promise<{ readonly heartbeatId?: string }> => {
      const response = await context.client.command(command);
      if (!response.success || response.command !== command.type)
        throw new Error(`${command.type} failed`);
      const data = response.data as {
        readonly heartbeatId?: string;
        readonly heartbeats: ReadonlyArray<PrimeNativeHeartbeat>;
        readonly resident?: boolean;
      };
      context.nativeHeartbeats = data.heartbeats;
      context.resident = data.resident === true;
      // Same rule as the heartbeat_update event path: ownership cannot outlive
      // the heartbeat it named, so an id the store no longer reports is
      // dropped instead of being persisted as an unprovable handle that would
      // later stall the whole cleanup chain for this record.
      const reported = new Set(data.heartbeats.map((heartbeat) => heartbeat.heartbeatId));
      for (const heartbeatId of [...context.ownedHeartbeats])
        if (!reported.has(heartbeatId)) context.ownedHeartbeats.delete(heartbeatId);
      // An id the store does not also contain is not adopted: T3 would be
      // claiming ownership of something it cannot see, and could later stop a
      // schedule it never actually created.
      return data.heartbeatId !== undefined &&
        data.heartbeats.some((heartbeat) => heartbeat.heartbeatId === data.heartbeatId)
        ? { heartbeatId: data.heartbeatId }
        : {};
    };

    /**
     * Reads the authoritative command catalog and publishes it when it differs
     * from the last published one. Nothing is invoked here.
     */
    const discoverCommands = async (context: SessionContext): Promise<void> => {
      const data = await commandData(context, PRIME_GET_COMMANDS_COMMAND);
      for (const event of context.normalizer.commandsSnapshot(context.commands.apply(data)))
        await Effect.runPromise(Queue.offer(runtimeEvents, event));
    };

    const resolveTurnInput = async (input: ProviderSendTurnInput, context: SessionContext) => {
      if (!input.input && (input.attachments?.length ?? 0) === 0)
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "A prompt or attachment is required.",
        });
      if (!input.modelSelection || input.modelSelection.instanceId !== options.instanceId)
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "A Prime model selection for this instance is required.",
        });
      const modelsResponse = await context.client.command({ type: "get_available_models" });
      if (
        !modelsResponse.success ||
        modelsResponse.command !== "get_available_models" ||
        !modelsResponse.data ||
        typeof modelsResponse.data !== "object" ||
        !("models" in modelsResponse.data)
      ) {
        throw new Error("get_available_models failed");
      }
      const models = (
        modelsResponse.data as {
          models: ReadonlyArray<{
            id: string;
            provider: string;
            input: ReadonlyArray<"text" | "image">;
            thinkingLevelMap?: Readonly<Record<string, string | null>>;
          }>;
        }
      ).models;
      let identity = input.modelSelection.nativeIdentity;
      if (!identity) {
        const matching = models.filter((model) => model.id === input.modelSelection!.model);
        if (matching.length !== 1)
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Legacy model selection is unavailable or ambiguous; reselect the model.",
          });
        identity = { provider: matching[0]!.provider, modelId: matching[0]!.id };
      }
      const model = models.find(
        (candidate) =>
          candidate.provider === identity.provider && candidate.id === identity.modelId,
      );
      if (!model)
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Selected Prime model is unavailable; reselect the model.",
        });
      if (!model.input.includes("text"))
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Model '${input.modelSelection.model}' does not support text input.`,
        });
      const textParts = input.input ? [input.input] : [];
      const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      for (const attachment of input.attachments ?? []) {
        if (!options.attachmentsDir)
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Attachment '${attachment.name}' cannot be resolved.`,
          });
        const path = resolvePrimeAttachmentPath(options.attachmentsDir, input.threadId, attachment);
        if (!path)
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Attachment '${attachment.name}' has an invalid id.`,
          });
        const stat = await NodeFSP.stat(path).catch(() => undefined);
        const limit =
          attachment.type === "image"
            ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            : PROVIDER_SEND_TURN_MAX_TEXT_ATTACHMENT_BYTES;
        if (!stat?.isFile() || stat.size !== attachment.sizeBytes || stat.size > limit)
          throw new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Attachment '${attachment.name}' is missing, unreadable, or oversized.`,
          });
        const bytes = await NodeFSP.readFile(path);
        if (attachment.type === "image") {
          if (!model.input.includes("image"))
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: `Model '${input.modelSelection.model}' does not support image attachment '${attachment.name}'.`,
            });
          images.push({
            type: "image",
            data: bytes.toString("base64"),
            mimeType: attachment.mimeType,
          });
        } else {
          const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          textParts.push(
            `Attachment: ${attachment.name} (${attachment.mimeType})\n---\n${decoded}\n---`,
          );
        }
      }
      const thinking = input.modelSelection.options?.find(
        (option) => option.id === "thinkingLevel",
      )?.value;
      if (thinking !== undefined && typeof thinking !== "string")
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "Prime thinkingLevel must be a string.",
        });
      if (
        thinking !== undefined &&
        (!model.thinkingLevelMap ||
          !(thinking in model.thinkingLevelMap) ||
          model.thinkingLevelMap[thinking] === null)
      ) {
        throw new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `Thinking level '${thinking}' is unavailable for the selected model.`,
        });
      }
      return { identity, thinking, message: textParts.join("\n\n"), images };
    };

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.tryPromise({
        try: async () => {
          const context = requireContext(input.threadId);
          const resolved = await resolveTurnInput(input, context);
          if (
            !context.selectedModel ||
            context.selectedModel.provider !== resolved.identity.provider ||
            context.selectedModel.modelId !== resolved.identity.modelId
          ) {
            await expectSuccess(context, {
              type: "set_model",
              provider: resolved.identity.provider,
              modelId: resolved.identity.modelId,
            });
            context.selectedModel = resolved.identity;
            context.thinkingLevel = undefined;
          }
          if (resolved.thinking !== undefined && context.thinkingLevel !== resolved.thinking) {
            await expectSuccess(context, {
              type: "set_thinking_level",
              level: resolved.thinking as
                | "off"
                | "minimal"
                | "low"
                | "medium"
                | "high"
                | "xhigh"
                | "max",
            });
            context.thinkingLevel = resolved.thinking;
          }
          await expectSuccess(context, {
            type: "prompt",
            message: resolved.message,
            ...(resolved.images.length > 0 ? { images: resolved.images } : {}),
          });
          return { threadId: input.threadId, turnId: TurnId.make(randomUUID()) };
        },
        catch: (cause) =>
          cause instanceof ProviderAdapterValidationError ||
          cause instanceof ProviderAdapterSessionNotFoundError
            ? cause
            : new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Prime Agent turn input failed.",
                cause,
              }),
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.tryPromise({
        try: async () => {
          const context = requireContext(threadId);
          await expectSuccess(context, { type: "abort" });
          for (const event of context.normalizer.abort("Prime Agent turn was interrupted."))
            await Effect.runPromise(Queue.offer(runtimeEvents, event));
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: "Prime Agent interrupt failed.",
            cause,
          }),
      });

    // Prime 0.7.2 exposes only `{ type: "steer"|"follow_up", message, images? }`.
    // `session_action_update` supplies lane text/count but deliberately no action ids,
    // therefore follow-up cancellation remains false rather than guessing an RPC.
    const executeRuntimeOperation: NonNullable<
      ProviderAdapterShape<ProviderAdapterError>["executeRuntimeOperation"]
    > = (operation) =>
      Effect.tryPromise({
        try: async () => {
          const context = requireContext(operation.threadId);
          if (operation.type === "compaction.request") {
            await expectSuccess(context, PRIME_COMPACT_COMMAND);
            return;
          }
          if (operation.type === "command.discover") {
            // Explicit, bounded invalidation: the catalog is re-read once per
            // request, so a command added or deleted on the host converges
            // without any polling.
            context.commands.invalidate();
            await discoverCommands(context);
            return;
          }
          if (operation.type === "usage.snapshot.retry") {
            // "Retry" here re-reads the authoritative usage snapshot; it never
            // replays a model turn.
            const data = await commandData(context, PRIME_SESSION_STATS_COMMAND);
            for (const event of context.normalizer.usageSnapshot(normalizePrimeSessionStats(data)))
              await Effect.runPromise(Queue.offer(runtimeEvents, event));
            return;
          }
          if (operation.type === "task.observe" || operation.type === "task.unobserve") {
            const intent = operation.type === "task.observe" ? "observe" : "unobserve";
            const decision = primeObservationDecision(
              context.agents,
              String(operation.taskId),
              intent,
            );
            // Ownership is checked on every action, against the roster this
            // T3-owned session currently reports. An id that is not in it never
            // reaches the runtime, whichever client sent it.
            if (!decision.allowed)
              throw new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "executeRuntimeOperation",
                issue: primeObservationRefusalMessage(decision.reason),
              });
            await expectSuccess(context, { type: intent, taskId: decision.agent.agentId });
            if (intent === "observe") context.observedAgents.add(decision.agent.agentId);
            else context.observedAgents.delete(decision.agent.agentId);
            context.agents = context.agents.map((agent) =>
              agent.agentId === decision.agent.agentId
                ? { ...agent, observed: intent === "observe" }
                : agent,
            );
            await publishAgents(context);
            return;
          }
          if (operation.type.startsWith("goal."))
            // Prime 0.7.2 reports goal state and exposes no goal-change RPC.
            // Refusing with the reason stated beats aiming a "Cancel goal"
            // button at something that would do a different thing.
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "executeRuntimeOperation",
              issue: PRIME_GOAL_MUTATION_REFUSAL,
            });
          if (operation.type === "heartbeat.create")
            return serializeHeartbeat(context, async () => {
              const decision = primeHeartbeatCreateDecision(
                context.goalBoard,
                operation.intervalSeconds,
              );
              // The board can hold fewer rows than the owned set does — a row is
              // dropped when the runtime reports it with text or an interval T3
              // cannot state exactly — so the cap is also enforced against the
              // handles that actually get persisted. Otherwise a ninth handle
              // would make the ownership write throw after the heartbeat already
              // exists, losing the only id that could ever stop it.
              if (decision.allowed && context.ownedHeartbeats.size >= MAX_PRIME_HEARTBEATS)
                throw new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "executeRuntimeOperation",
                  issue: primeHeartbeatRefusalMessage("limit-reached"),
                });
              if (!decision.allowed)
                throw new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "executeRuntimeOperation",
                  issue: primeHeartbeatRefusalMessage(decision.reason),
                });
              // The runtime names the heartbeat it just made; that response is the
              // only way T3 learns an id is its own. A creation that answers
              // without one leaves the store untouched from T3's point of view
              // rather than adopting whatever appeared.
              const created = await heartbeatSnapshot(context, {
                type: "heartbeat_create",
                title: operation.title,
                intervalSeconds: operation.intervalSeconds,
              });
              // An id the ownership record could not hold is not adopted: the
              // write would throw after the heartbeat already exists, which is
              // the one outcome that leaves a real T3-created schedule running
              // with no handle at all.
              if (isPrimeOwnableHeartbeatId(created.heartbeatId)) {
                context.ownedHeartbeats.add(created.heartbeatId);
                // Adoption and rendering must agree: a schedule the runtime
                // created but reported back in a form the board cannot state
                // exactly (unbrandable id, out-of-range interval, blank title)
                // would be owned, resident, and unreachable by every reverse
                // control. Stop exactly that id and refuse the create. If even
                // the stop fails, the handle stays adopted so residency stays
                // disclosed and cleanup can still prove it by raw id.
                const renderable = primeOwnedHeartbeats(
                  context.nativeHeartbeats,
                  context.ownedHeartbeats,
                ).some((heartbeat) => heartbeat.heartbeatId === created.heartbeatId);
                if (!renderable) {
                  let stopped = true;
                  try {
                    await expectSuccess(context, {
                      type: "heartbeat_stop",
                      heartbeatId: created.heartbeatId,
                    });
                    context.ownedHeartbeats.delete(created.heartbeatId);
                    await heartbeatSnapshot(context, { type: "heartbeat_get" });
                  } catch {
                    // Handle retained on purpose; see comment above.
                    stopped = false;
                  }
                  await persistHeartbeatOwnership(context);
                  await publishGoals(context);
                  throw new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "executeRuntimeOperation",
                    issue: stopped
                      ? "Prime Agent created this schedule in a form T3 cannot represent exactly; it was not kept."
                      : "Prime Agent created this schedule in a form T3 cannot represent exactly, and stopping it failed: it is still running and is disclosed on the board.",
                  });
                }
              }
              await persistHeartbeatOwnership(context);
              await publishGoals(context);
            });
          if (
            operation.type === "heartbeat.pause" ||
            operation.type === "heartbeat.resume" ||
            operation.type === "heartbeat.delete" ||
            // Reversing a creation is deleting exactly that heartbeat.
            operation.type === "heartbeat.reverse"
          )
            return serializeHeartbeat(context, async () => {
              const intent =
                operation.type === "heartbeat.pause"
                  ? "pause"
                  : operation.type === "heartbeat.resume"
                    ? "resume"
                    : "delete";
              const decision = primeHeartbeatDecision(
                context.goalBoard,
                String(operation.heartbeatId),
                intent,
              );
              // Ownership is checked on every action against the board this
              // T3-owned session currently reports. A stale id, another thread's
              // schedule, and an id fished out of the daemon all stop here.
              // One exception: a handle T3 owns whose row the board cannot
              // render (the runtime drifted its interval or title out of the
              // representable range) stays directly actionable by its raw id —
              // pause/resume/delete need only the id, and rendering is a
              // display concern that must never cost the user the reverse
              // control of a schedule they created.
              const ownedHidden =
                !decision.allowed &&
                decision.reason === "unknown-heartbeat" &&
                context.ownedHeartbeats.has(String(operation.heartbeatId));
              if (!decision.allowed && !ownedHidden)
                throw new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "executeRuntimeOperation",
                  issue: primeHeartbeatRefusalMessage(decision.reason),
                });
              const heartbeatId = decision.allowed
                ? decision.heartbeat.heartbeatId
                : String(operation.heartbeatId);
              await expectSuccess(context, {
                type:
                  intent === "pause"
                    ? "heartbeat_pause"
                    : intent === "resume"
                      ? "heartbeat_resume"
                      : "heartbeat_stop",
                heartbeatId,
              });
              if (intent === "delete") context.ownedHeartbeats.delete(heartbeatId);
              // Re-read rather than assume: the runtime is the authority on what
              // the schedule now is, including whether the session is still
              // resident once the last owned heartbeat is gone.
              await heartbeatSnapshot(context, { type: "heartbeat_get" });
              await persistHeartbeatOwnership(context);
              await publishGoals(context);
            });
          if (operation.type === "thread.rename") {
            // T3 asks for exactly what the user typed or refuses. A name that
            // would be clamped is a different name, and silently renaming a
            // session to something else is worse than saying no.
            const decision = primeRenameDecision(operation.title);
            if (!decision.allowed)
              throw new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "executeRuntimeOperation",
                issue: primeRenameRefusalMessage(decision.reason),
              });
            await expectSuccess(context, { type: "set_session_name", name: decision.name });
            context.sessionName = decision.name;
            await publishIdentity(context);
            return;
          }
          if (operation.type === "thread.fork") {
            const forkPointId =
              operation.forkPointId === undefined ? undefined : String(operation.forkPointId);
            // The published page is the authorization list, exactly as the
            // heartbeat board is: a stale id from a client that rendered an
            // older page, and an id fished out of somewhere else, both stop
            // here without reaching the runtime.
            const decision = primeForkDecision(context.identityCard, forkPointId);
            if (!decision.allowed)
              throw new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "executeRuntimeOperation",
                issue: primeForkRefusalMessage(decision.reason),
              });
            const response = await context.client.command(
              decision.forkPoint
                ? { type: "fork" as const, messageId: decision.forkPoint.forkPointId }
                : { type: "clone" as const },
            );
            if (!response.success || (response.command !== "fork" && response.command !== "clone"))
              throw new Error("fork failed");
            const sessionId = (response.data as { readonly sessionId?: string }).sessionId;
            // The runtime names the session it just made; that answer is the
            // only way T3 learns which session the new thread should open. A
            // fork that answers without one fails rather than leaving the
            // caller to create a thread pointing at nothing.
            if (typeof sessionId !== "string" || sessionId.length === 0)
              throw new ProviderAdapterValidationError({
                provider: PROVIDER,
                operation: "executeRuntimeOperation",
                issue: "Prime Agent did not name the session it forked, so the fork was not kept.",
              });
            if (operation.forkThreadId !== undefined)
              await recordForkHandoff(String(operation.forkThreadId), sessionId);
            return;
          }
          if (operation.type !== "steer.add" && operation.type !== "follow-up.add")
            throw new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "executeRuntimeOperation",
              issue:
                "Prime Agent does not expose an exact native action command for this operation.",
            });
          await expectSuccess(context, {
            type: operation.type === "steer.add" ? "steer" : "follow_up",
            message: operation.text,
          });
        },
        catch: (cause) =>
          isProviderAdapterValidationError(cause)
            ? cause
            : new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: operation.threadId,
                detail: "Prime Agent runtime action failed.",
                cause,
              }),
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const context = requireContext(threadId);
          const id = String(requestId);
          const pending = context.pendingRequests.get(id);
          if (!pending || pending.method !== "confirm")
            throw new Error("Interactive request is not a confirmation.");
          // Two clients can answer the same dialog. The first answer owns the
          // correlation id; a second would be a second native response.
          if (pending.responding) throw new Error("Interactive request is already being answered.");
          const value = decision === "accept" || decision === "acceptForSession";
          pending.responding = true;
          try {
            await expectSuccess(
              context,
              value
                ? { type: "extension_ui_response", confirmed: true }
                : { type: "extension_ui_response", cancelled: true },
              { requestId: id },
            );
          } catch (cause) {
            pending.responding = false;
            // The dialog stays pending so the user can retry — unless the
            // timeout fired meanwhile, in which case it is closed truthfully.
            const timedOut = pending.timedOutReason;
            pending.timedOutReason = undefined;
            if (timedOut !== undefined) await cancelPendingRequest(context, id, timedOut);
            throw cause;
          }
          dropPendingRequest(context, id);
          for (const event of context.normalizer.resolved(id, "request", {
            decision: value ? decision : "cancel",
          }))
            await Effect.runPromise(Queue.offer(runtimeEvents, event));
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: "Prime Agent approval response failed.",
            cause,
          }),
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.tryPromise({
        try: async () => {
          const context = requireContext(threadId);
          const id = String(requestId);
          const pending = context.pendingRequests.get(id);
          if (!pending || pending.method === "confirm")
            throw new Error("Interactive request is not user input.");
          if (pending.responding) throw new Error("Interactive request is already being answered.");
          if (!Object.prototype.hasOwnProperty.call(answers, id))
            throw new Error("Prime Agent input response must name the request id.");
          const raw = answers[id];
          const value = Array.isArray(raw) ? raw[0] : raw;
          if (typeof value !== "string" || value.length > MAX_NATIVE_STRING)
            throw new Error("Prime Agent input response must be a bounded string.");
          const clean = cleanNative(value);
          if (pending.method === "select" && !pending.options.includes(clean))
            throw new Error("Prime Agent select answer is invalid.");
          pending.responding = true;
          try {
            await expectSuccess(
              context,
              { type: "extension_ui_response", value: clean },
              { requestId: id },
            );
          } catch (cause) {
            pending.responding = false;
            const timedOut = pending.timedOutReason;
            pending.timedOutReason = undefined;
            if (timedOut !== undefined) await cancelPendingRequest(context, id, timedOut);
            throw cause;
          }
          dropPendingRequest(context, id);
          for (const event of context.normalizer.resolved(id, "user-input", {
            answers: { [id]: clean },
          }))
            await Effect.runPromise(Queue.offer(runtimeEvents, event));
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId,
            detail: "Prime Agent user input response failed.",
            cause,
          }),
      });

    const unsupported = (operation: string) =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation,
          issue: "This operation belongs to a later Prime Agent milestone.",
        }),
      );

    const stopAll = () =>
      Effect.tryPromise({
        try: async () => {
          closed = true;
          await Promise.all(
            Array.from(pending.values(), (entry) => entry.promise.catch(() => undefined)),
          );
          const contexts = Array.from(sessions.values());
          sessions.clear();
          await Promise.all(contexts.map(closeContext));
          await Promise.all(contexts.map((context) => context.eventDrain));
          for (const context of contexts) {
            await cancelPendingDialogs(
              context,
              "Prime Agent interactive request was cancelled because the adapter was stopped.",
            );
            for (const event of context.normalizer.stop("Prime Agent adapter was stopped.")) {
              await Effect.runPromise(Queue.offer(runtimeEvents, event));
            }
          }
        },
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ThreadId.make("adapter"),
            detail: "Prime Agent adapter teardown failed.",
            cause,
          }),
      });

    const adapter: ProviderAdapterShape<ProviderAdapterError> = {
      provider: PROVIDER,
      // `get_state` is the bootstrap liveness probe. This adapter is pinned to the
      // declaration-verified 0.7.2 command baseline, whose exact `steer` and
      // `follow_up` commands are available after that probe; it never infers
      // cancellation from the enqueue acknowledgement.
      capabilities: {
        sessionModelSwitch: "in-session",
        conversationRollback: "unsupported",
        // `compact` and `get_session_stats` are declaration-verified 0.7.2
        // commands. Prime exposes no compaction-cancel RPC, so that flag stays
        // false rather than mapping cancellation onto the turn-wide `abort`.
        runtimeExtensions: {
          steer: true,
          followUps: true,
          followUpCancel: false,
          compaction: true,
          compactionCancel: false,
          usageAndRetry: true,
          // Discovery only. Prime 0.7.2 has no invoke RPC: an eligible command
          // is sent as an ordinary prompt, so `command.invoke` stays refused
          // rather than mapped onto a command that does not exist.
          commandDiscovery: true,
          // Typed extension dialogs plus the bounded transient status board.
          // Blocking methods are answered exactly; fire-and-forget methods are
          // displayed and never answered; anything else is safe-cancelled.
          interactions: true,
          // Root/subagent roster plus `observe`/`unobserve`. Prime 0.7.2 has no
          // per-agent cancel/pause/resume RPC, so those operations stay refused
          // rather than mapped onto the turn-wide `abort`.
          tasks: true,
          // Goal state plus T3-owned heartbeat create/pause/resume/delete.
          // Prime 0.7.2 has no goal-change RPC, so `goal.*` operations stay
          // refused rather than mapped onto something that does another thing.
          goals: true,
          // `set_session_name`, `get_fork_messages`, and `fork`/`clone`. The
          // fork is handed to the new thread inside this process; it is not a
          // durable resume cursor and never claims to be one.
          namingAndForking: true,
        },
      },
      startSession,
      sendTurn,
      interruptTurn,
      executeRuntimeOperation,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () => Effect.succeed(Array.from(sessions.values(), ({ session }) => session)),
      hasSession: (threadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId) =>
        sessions.has(threadId)
          ? unsupported("readThread")
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId })),
      rollbackThread: (threadId) =>
        sessions.has(threadId)
          ? unsupported("rollbackThread")
          : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId })),
      stopAll,
      streamEvents: Stream.fromQueue(runtimeEvents),
    };
    yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));
    return adapter;
  });
