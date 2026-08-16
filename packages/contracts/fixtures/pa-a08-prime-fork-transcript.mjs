import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

/**
 * Source-derived PA-A08 naming and forking transcript.
 *
 * One scripted Prime session is named, listed for fork points, and forked. Every
 * mapping below is the *shipped* one — the adapter mapper, the canonical
 * contract and its reducer, the capability gate, and the client projection are
 * imported and executed rather than mirrored, so a regression in any of them
 * fails this transcript with it.
 *
 * No live Prime Agent, no live session, and no host paths are involved.
 *
 * Run: `node packages/contracts/fixtures/pa-a08-prime-fork-transcript.mjs`
 */
const ROOT = new URL("../../../", import.meta.url);
const read = (relative) => NodeFS.readFileSync(new URL(relative, ROOT), "utf8");
const load = (relative) => import(new URL(relative, ROOT).href);

const {
  primeSessionIdentity,
  primeSessionIdentityFingerprint,
  primeForkDecision,
  primeForkRefusalMessage,
  primeRenameDecision,
  primeRenameRefusalMessage,
  MAX_PRIME_FORK_POINTS,
  MAX_PRIME_SESSION_NAME,
  PRIME_FORK_NOT_RESUME_DISCLOSURE,
} = await load("apps/server/src/provider/prime/PrimeFork.ts");
const { ProviderRuntimeEvent, reduceProviderSessionIdentityCard } = await load(
  "packages/contracts/src/providerRuntime.ts",
);
const { capabilityForRuntimeOperation, supportsRuntimeOperation } = await load(
  "packages/contracts/src/providerCapabilities.ts",
);
const {
  hasPrimeNaming,
  primeForkDraftDecision,
  primeRenameDraftDecision,
  renderPrimeForkOrigin,
  renderPrimeIdentityCard,
  PRIME_FORK_NOT_RESUME_NOTE,
} = await load("apps/web/src/components/chat/primeFork.ts");

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const canonical = (type, payload) =>
  decodeRuntimeEvent({
    type,
    eventId: `pa-a08-${type}-${JSON.stringify(payload).length}`,
    provider: "prime-agent",
    providerInstanceId: "prime-agent",
    threadId: "thread-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload,
  });

/**
 * The scripted `get_fork_messages` answer. It deliberately contains one id the
 * wire contract cannot brand and one blank preview, because both happen and
 * both must be handled without renaming anything.
 */
export const fixtureForkMessages = [
  { messageId: "msg-1", role: "user", preview: "Start the adapter" },
  { messageId: "msg-2", role: "assistant", preview: "Adapter drafted" },
  { messageId: "9-not-brandable", role: "user", preview: "Never offered" },
  { messageId: "msg-4", role: "user", preview: "   " },
];

/** Runs the shipped mapper over one native snapshot. */
export function mapIdentity(name, messages = fixtureForkMessages) {
  return primeSessionIdentity({ ...(name ? { name } : {}), messages });
}

function verifyDerivedFromSource() {
  if (!read("apps/server/src/provider/prime/PrimeFork.ts").includes("export const primeForkPoints"))
    throw new Error("the shipped mapper moved; this transcript is no longer source-derived");
  if (
    read("apps/mobile/src/features/threads/primeFork.ts") !==
    read("apps/web/src/components/chat/primeFork.ts")
  )
    throw new Error("the web and mobile client projections drifted apart");
  // The whole "no half-created thread" promise is one ordering in the reactor:
  // the thread is created after the provider confirms, never before.
  const reactor = read("apps/server/src/orchestration/Layers/ProviderCommandReactor.ts");
  const forked = reactor.indexOf("const forked = yield* providerService");
  const created = reactor.indexOf(
    'type: "thread.create",\n        commandId: yield* serverCommandId("provider-session-fork")',
  );
  if (forked < 0 || created < 0 || created < forked)
    throw new Error("the forked thread is no longer created after the provider confirms the fork");
}

/** Identity mapping: exact ids, labels rather than transcript, stable numbering. */
function verifyIdentity() {
  const card = mapIdentity("Migration work");
  const ids = card.forkPoints.map((point) => point.forkPointId).join(",");
  if (ids !== "msg-1,msg-2,msg-4")
    throw new Error("a fork point T3 cannot name exactly was offered anyway");
  if (card.forkPoints[2].index !== 3)
    throw new Error("dropping an unrepresentable point renumbered the rest");
  if (card.forkPoints[2].label !== "User message 4")
    throw new Error("a point with no usable preview lost its label");
  if (card.name !== "Migration work") throw new Error("the session name was not carried exactly");
  // A name the runtime never reported is never invented.
  if (mapIdentity(undefined).name !== undefined)
    throw new Error("a session with no name was given one");
  // Byte-identical snapshots publish nothing new.
  if (
    primeSessionIdentityFingerprint(card) !==
    primeSessionIdentityFingerprint(mapIdentity("Migration work"))
  )
    throw new Error("an unchanged snapshot produced a different card");
  return card;
}

/** The page is bounded, says so, and keeps the most recent choices. */
function verifyBounds() {
  const flood = Array.from({ length: 64 }, (_unused, index) => ({
    messageId: `msg-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    preview: `Message ${index}`,
  }));
  const card = mapIdentity("Long run", flood);
  if (card.forkPoints.length !== MAX_PRIME_FORK_POINTS)
    throw new Error("the fork-point page is not bounded");
  if (card.truncated !== true) throw new Error("a truncated page did not say so");
  if (card.forkPoints.at(-1).forkPointId !== "msg-63")
    throw new Error("the page dropped the most recent fork points");
  let refused = false;
  try {
    canonical("session.identity.updated", {
      forkPoints: [
        ...card.forkPoints,
        { forkPointId: "extra", label: "x", role: "user", index: 99 },
      ],
    });
  } catch {
    refused = true;
  }
  if (!refused) throw new Error("the canonical contract accepted an unbounded page");
  // Message bodies never cross the boundary: a long preview is clamped, and the
  // clamp is visible in the published label.
  const long = mapIdentity(undefined, [
    { messageId: "msg-long", role: "user", preview: "x".repeat(400) },
  ]);
  if (long.forkPoints[0].label.length > 120)
    throw new Error("an unbounded preview reached the published card");
}

/** Rename asks for exactly what was typed, or refuses and says why. */
function verifyRename() {
  const ok = primeRenameDecision("  Review pass  ");
  if (!ok.allowed || ok.name !== "Review pass")
    throw new Error("a legal rename was refused or altered");
  for (const name of ["", "   ", "x".repeat(MAX_PRIME_SESSION_NAME + 1)]) {
    const refusal = primeRenameDecision(name);
    if (refusal.allowed) throw new Error("a name T3 cannot set exactly was accepted");
    if (!primeRenameRefusalMessage(refusal.reason).includes("session name"))
      throw new Error("the refusal does not say what happened");
  }
}

/** Forking targets a point this session offers, or the whole session. */
function verifyForkDecision(card) {
  const whole = primeForkDecision(card, undefined);
  if (!whole.allowed || whole.forkPoint !== undefined)
    throw new Error("the whole-session clone is not offered");
  const point = primeForkDecision(card, "msg-2");
  if (!point.allowed || point.forkPoint.forkPointId !== "msg-2")
    throw new Error("an offered fork point was refused");
  for (const [id, reason] of [
    ["9-not-brandable", "unknown-fork-point"],
    ["msg-gone", "unknown-fork-point"],
  ]) {
    const refusal = primeForkDecision(card, id);
    if (refusal.allowed || refusal.reason !== reason)
      throw new Error(`a fork point this session never offered was accepted: ${id}`);
    if (primeForkRefusalMessage(refusal.reason).length === 0)
      throw new Error("the refusal does not say what happened");
  }
  const empty = primeForkDecision({ forkPoints: [] }, "msg-2");
  if (empty.allowed || empty.reason !== "no-fork-points")
    throw new Error("a session with no fork points accepted one");
}

function verifyCapabilityGate() {
  for (const type of ["thread.rename", "thread.fork"]) {
    if (capabilityForRuntimeOperation({ type }) !== "namingAndForking")
      throw new Error(`${type} is not gated by the namingAndForking capability`);
    if (
      supportsRuntimeOperation({}, { type }) ||
      supportsRuntimeOperation({ goals: true }, { type }) ||
      !supportsRuntimeOperation({ namingAndForking: true }, { type })
    )
      throw new Error(`${type} is not capability-gated`);
  }
  // Naming and forking are a live-session feature; nothing here is a resume
  // cursor, and both the adapter and the clients say so in the same words.
  if (PRIME_FORK_NOT_RESUME_DISCLOSURE !== PRIME_FORK_NOT_RESUME_NOTE)
    throw new Error("the host and the clients disclose different things about forking");
  if (!PRIME_FORK_NOT_RESUME_DISCLOSURE.includes("not durable resume"))
    throw new Error("forking is not disclosed as something other than resume");
}

/** Two clients derive their view independently from one broadcast. */
function verifyClients(card) {
  if (
    hasPrimeNaming("prime-agent", {}) ||
    !hasPrimeNaming("prime-agent", { namingAndForking: true })
  )
    throw new Error("the client surface is not capability-gated");
  const capabilities = { namingAndForking: true };
  const broadcast = [canonical("session.identity.updated", card)];
  const project = (events) =>
    renderPrimeIdentityCard(events.reduce(reduceProviderSessionIdentityCard, undefined), {
      status: "running",
    });
  const a = project(broadcast);
  const b = project(broadcast);
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error("two clients disagreed about the same snapshot");
  // Falsifiability: a client that drops the snapshot must be detectable, or the
  // convergence check above proves nothing.
  if (JSON.stringify(project([])) === JSON.stringify(a))
    throw new Error("the convergence check cannot fail, so it proves nothing");
  // A session that is no longer live shows nothing and offers no control.
  if (renderPrimeIdentityCard(card, { status: "stopped" }).length !== 0)
    throw new Error("a dead session kept offering its identity");
  if (primeForkDraftDecision(card, { status: "stopped" }, capabilities, undefined).canFork)
    throw new Error("a dead session still offered a fork");
  const draft = primeForkDraftDecision(card, { status: "running" }, capabilities, "msg-2");
  if (!draft.canFork || draft.disclosure !== PRIME_FORK_NOT_RESUME_NOTE)
    throw new Error("forking was offered without its disclosure");
  // Renaming again is its own reverse, so it is always reachable.
  if (
    !primeRenameDraftDecision(card, { status: "running" }, capabilities, "Another name").canRename
  )
    throw new Error("a renamed session could not be renamed again");
  // Ancestry is a thread record and stays readable with no session at all.
  const origin = renderPrimeForkOrigin({
    threadId: "thread-1",
    forkPointLabel: "Adapter drafted",
    checkpointId: "checkpoint-9",
    forkedAt: "2026-01-01T00:00:00.000Z",
  });
  if (!origin.includes("Adapter drafted") || !origin.includes("checkpoint-9"))
    throw new Error("fork ancestry does not state where the fork came from");
  return { a, disclosure: draft.disclosure, origin };
}

function verifyProjection(card) {
  const projected = reduceProviderSessionIdentityCard(
    undefined,
    canonical("session.identity.updated", card),
  );
  if (JSON.stringify(projected.forkPoints) !== JSON.stringify(card.forkPoints))
    throw new Error("the canonical snapshot did not round-trip");
  const cleared = reduceProviderSessionIdentityCard(
    projected,
    canonical("session.exited", { reason: "exited" }),
  );
  if (cleared.forkPoints.length !== 0 || cleared.name !== undefined)
    throw new Error("an exited session kept its identity card");
  return projected;
}

export function verifyTranscript() {
  verifyDerivedFromSource();
  const card = verifyIdentity();
  verifyBounds();
  verifyRename();
  verifyForkDecision(card);
  verifyCapabilityGate();
  const clients = verifyClients(card);
  const projected = verifyProjection(card);
  return { card, clients, projected };
}

if (process.argv[1] !== undefined && NodeURL.fileURLToPath(import.meta.url) === process.argv[1]) {
  const { clients } = verifyTranscript();
  for (const line of clients.a) console.log(line);
  console.log(`confirmation copy: ${clients.disclosure}`);
  console.log(`forked thread ancestry: ${clients.origin}`);
  console.log(
    "PA-A08 Prime naming and forking transcript verified (source-derived, exact ids only, labels never transcript, bounded and truncation-disclosed fork page, rename asks for exactly what was typed, fork gated on its own capability, two-client convergence falsifiable, ancestry readable without Prime, dead sessions offer nothing)",
  );
}
