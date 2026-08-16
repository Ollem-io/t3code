import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as Schema from "effect/Schema";

/**
 * Source-derived PA-A05 extension UI transcript.
 *
 * A fixture extension exercises every representable extension UI method plus
 * the blocking dialogs. Every mapping and projection below is the *shipped*
 * implementation, imported and executed — never mirrored — so a regression in
 * the adapter mapper, the canonical contract, or the client projection fails
 * this transcript with it.
 *
 * Run: `node packages/contracts/fixtures/pa-a05-prime-extension-ui-transcript.mjs`
 */
const ROOT = new URL("../../../", import.meta.url);
const read = (relative) => NodeFS.readFileSync(new URL(relative, ROOT), "utf8");
const load = (relative) => import(new URL(relative, ROOT).href);

const {
  applyPrimeNotice,
  isBlockingPrimeUiRequest,
  primeRequestTimeoutMs,
  primeRequestTimeoutReason,
  MAX_PRIME_NOTICES,
} = await load("apps/server/src/provider/prime/PrimeExtensionUi.ts");
const { ProviderRuntimeEvent, reduceProviderSessionNoticeBoard } = await load(
  "packages/contracts/src/providerRuntime.ts",
);
const { visiblePrimeNotices, renderPrimeNotice, hasPrimeExtensionUi, primeNoticeFingerprint } =
  await load("apps/web/src/components/chat/primeExtensionUi.ts");

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);
const canonical = (type, payload, extra = {}) =>
  decodeRuntimeEvent({
    type,
    eventId: `pa-a05-${type}-${JSON.stringify(payload).length}-${Math.random().toString(36).slice(2, 8)}`,
    provider: "prime-agent",
    providerInstanceId: "prime-agent",
    threadId: "thread-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    payload,
    ...extra,
  });

/** The records a fixture extension emits over one turn. */
export const fixtureRequests = [
  {
    type: "extension_ui_request",
    id: "n-1",
    method: "notify",
    message: "Indexing failed",
    notifyType: "error",
  },
  {
    type: "extension_ui_request",
    id: "s-1",
    method: "setStatus",
    statusKey: "index",
    statusText: "Indexing 40%",
  },
  {
    type: "extension_ui_request",
    id: "s-2",
    method: "setStatus",
    statusKey: "index",
    statusText: "Indexing 90%",
  },
  {
    type: "extension_ui_request",
    id: "w-1",
    method: "setWidget",
    widgetKey: "tips",
    widgetLines: ["one", "two"],
  },
  { type: "extension_ui_request", id: "t-1", method: "setTitle", title: "Refactor pass" },
  { type: "extension_ui_request", id: "e-1", method: "set_editor_text", text: "npm test" },
  {
    type: "extension_ui_request",
    id: "sel-1",
    method: "select",
    title: "Pick",
    options: ["one", "two"],
  },
  {
    type: "extension_ui_request",
    id: "cfm-1",
    method: "confirm",
    title: "Approve",
    message: "Run it?",
  },
  { type: "extension_ui_request", id: "inp-1", method: "input", title: "Name", timeout: 1 },
  { type: "extension_ui_request", id: "edt-1", method: "editor", title: "Edit", prefill: "old" },
];

/** Runs the shipped mapper over a request list and returns the board array. */
export function mapNotices(requests, notices = new Map()) {
  for (const request of requests) {
    if (isBlockingPrimeUiRequest(request)) continue;
    applyPrimeNotice(notices, request);
  }
  return [...notices.values()];
}

/** The shipped canonical reducer, fed shipped-schema-decoded snapshots. */
export function projectBoard(boards) {
  return boards.reduce(
    (state, notices) =>
      reduceProviderSessionNoticeBoard(state, canonical("session.notices.updated", { notices })),
    undefined,
  );
}

function verifyDerivedFromSource() {
  const source = read("apps/server/src/provider/prime/PrimeExtensionUi.ts");
  if (!source.includes("export const applyPrimeNotice"))
    throw new Error("the shipped mapper moved; this transcript is no longer source-derived");
  const twin = read("apps/mobile/src/features/threads/primeExtensionUi.ts");
  if (twin !== read("apps/web/src/components/chat/primeExtensionUi.ts"))
    throw new Error("the web and mobile client projections drifted apart");
}

function verifyStatusMapping() {
  const board = mapNotices(fixtureRequests);
  const keys = board.map((notice) => notice.key);
  const expected = ["notification:error", "status:index", "widget:tips", "title", "editor-text"];
  if (JSON.stringify(keys) !== JSON.stringify(expected))
    throw new Error(`unexpected board keys: ${keys.join(", ")}`);
  // Replacement, never accumulation.
  if (board.find((notice) => notice.key === "status:index").text !== "Indexing 90%")
    throw new Error("a repeated status key did not replace the previous entry");
  // A blocking dialog never becomes status.
  if (board.some((notice) => notice.text === "Pick"))
    throw new Error("a dialog leaked onto the board");
  // Every projected board decodes against the canonical contract.
  const projected = projectBoard([board]);
  if (JSON.stringify(projected.notices) !== JSON.stringify(board))
    throw new Error("the canonical snapshot did not round-trip");
  return board;
}

function verifyClearAndBound() {
  const notices = new Map();
  mapNotices([fixtureRequests[1]], notices);
  // The runtime clears its own status: that is its dismissal.
  mapNotices(
    [{ type: "extension_ui_request", id: "s-3", method: "setStatus", statusKey: "index" }],
    notices,
  );
  if (notices.size !== 0) throw new Error("a cleared status did not remove its entry");
  const flood = Array.from({ length: 40 }, (_, index) => ({
    type: "extension_ui_request",
    id: `f-${index}`,
    method: "setStatus",
    statusKey: `k${index}`,
    statusText: `line ${index}`,
  }));
  const bounded = mapNotices(flood, notices);
  if (bounded.length !== MAX_PRIME_NOTICES)
    throw new Error(`a chatty extension flooded the board: ${bounded.length}`);
  if (bounded.at(-1).text !== "line 39") throw new Error("the newest status was dropped");
  // Bounded here means bounded on the wire too: the canonical schema refuses more.
  let refused = false;
  try {
    canonical("session.notices.updated", {
      notices: [...bounded, { key: "extra", kind: "status", severity: "info", text: "over" }],
    });
  } catch {
    refused = true;
  }
  if (!refused) throw new Error("the canonical contract accepted an unbounded board");
  return bounded;
}

function verifyDialogs() {
  const blocking = fixtureRequests.filter((request) => isBlockingPrimeUiRequest(request));
  if (blocking.length !== 4) throw new Error("the four typed dialogs are not all blocking");
  const ms = primeRequestTimeoutMs(1);
  if (ms !== 1_000) throw new Error("a sub-second native timeout was not clamped");
  if (!primeRequestTimeoutReason(ms).includes("timed out after 1s"))
    throw new Error("the timeout reason does not state what happened");
  // Cancellation resolves the dialog rather than leaving it pending, and says
  // cancelled rather than implying an answer.
  const cancelled = canonical(
    "user-input.resolved",
    { answers: {}, cancelled: true, reason: primeRequestTimeoutReason(ms) },
    { requestId: "inp-1" },
  );
  if (cancelled.payload.cancelled !== true || Object.keys(cancelled.payload.answers).length !== 0)
    throw new Error("a cancelled dialog was not represented truthfully");
  const answered = canonical(
    "user-input.resolved",
    { answers: { "sel-1": "two" } },
    { requestId: "sel-1" },
  );
  if (answered.payload.cancelled !== undefined)
    throw new Error("an answered dialog claimed cancellation");
  return { cancelled, answered };
}

function verifyClients(board) {
  if (
    hasPrimeExtensionUi("prime-agent", {}) ||
    !hasPrimeExtensionUi("prime-agent", { interactions: true })
  )
    throw new Error("the client surface is not capability-gated");
  const live = { status: "running" };
  // Two clients derive their view independently from the same snapshot.
  const a = visiblePrimeNotices({ notices: board }, live, new Set()).map(renderPrimeNotice);
  const dismissed = new Set([primeNoticeFingerprint(board[0])]);
  const b = visiblePrimeNotices({ notices: board }, live, dismissed).map(renderPrimeNotice);
  if (a.length !== board.length || b.length !== board.length - 1)
    throw new Error("dismissal is not per viewer");
  if (JSON.stringify(a.slice(1)) !== JSON.stringify(b))
    throw new Error("two clients disagreed about the same snapshot");
  // Dismissal hides one exact message, not a key forever.
  const replaced = [{ ...board[0], text: `${board[0].text} (updated)` }];
  if (visiblePrimeNotices({ notices: replaced }, live, dismissed).length !== 1)
    throw new Error("a replacement was swallowed by an earlier dismissal");
  // A session that is no longer live shows nothing.
  if (visiblePrimeNotices({ notices: board }, { status: "stopped" }, new Set()).length !== 0)
    throw new Error("a dead session kept showing transient status");
  return { a, b };
}

function verifyFalsifiable() {
  // The board must be derived, not asserted: a mapper that ignored the clear
  // operation would have to fail `verifyClearAndBound`.
  const notices = new Map();
  mapNotices(
    [
      {
        type: "extension_ui_request",
        id: "x",
        method: "setStatus",
        statusKey: "k",
        statusText: "  ",
      },
    ],
    notices,
  );
  if (notices.size !== 0) throw new Error("blank status text produced a visible entry");
}

export function verifyTranscript() {
  verifyDerivedFromSource();
  const board = verifyStatusMapping();
  const bounded = verifyClearAndBound();
  const dialogs = verifyDialogs();
  const clients = verifyClients(board);
  verifyFalsifiable();
  return { board, bounded, dialogs, clients };
}

if (process.argv[1] !== undefined && NodeURL.fileURLToPath(import.meta.url) === process.argv[1]) {
  const { board, dialogs, clients } = verifyTranscript();
  for (const notice of board) console.log(renderPrimeNotice(notice));
  console.log(`dialog cancelled → ${dialogs.cancelled.payload.reason}`);
  console.log(
    `clients: A shows ${clients.a.length}, B shows ${clients.b.length} after one dismissal`,
  );
  console.log(
    "PA-A05 Prime extension UI transcript verified (source-derived, bounded and replaced status, no transcript flood, dialogs resolved or cancelled truthfully, dead sessions show nothing)",
  );
}
