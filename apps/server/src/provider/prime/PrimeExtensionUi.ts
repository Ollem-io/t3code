import type { PrimeRpcKnownEvent } from "./PrimeRpcProtocol.ts";

/**
 * Extension UI mapping for Prime 0.7.2.
 *
 * Blocking methods (`select`, `confirm`, `input`, `editor`) stay in the adapter:
 * they own a live correlation id and a native response. Everything else is
 * fire-and-forget presentation, and that mapping lives here so the review
 * transcript can execute the shipped code instead of mirroring it.
 */
export type PrimeExtensionUiRequest = Extract<
  PrimeRpcKnownEvent,
  { readonly type: "extension_ui_request" }
>;

export type PrimeNotice = {
  readonly key: string;
  readonly kind: "notification" | "status" | "widget" | "title" | "editor-text";
  readonly severity: "info" | "warning" | "error";
  readonly text: string;
  readonly lines?: ReadonlyArray<string>;
};

/**
 * The canonical contract caps the board at eight entries with 256-character
 * text and four 160-character widget lines; these clamps truncate an oversized
 * native string here rather than letting it be rejected downstream.
 */
export const MAX_PRIME_NOTICES = 8;
export const MAX_PRIME_NOTICE_TEXT = 256;
export const MAX_PRIME_NOTICE_LINES = 4;
export const MAX_PRIME_NOTICE_LINE = 160;
export const MAX_PRIME_NOTICE_KEY = 64;
/**
 * Native request timeouts are read as milliseconds and clamped: a runtime that
 * asks for a one-millisecond dialog cannot make a remote answer impossible, and
 * one that asks for a day cannot pin a dialog open forever.
 */
export const MIN_PRIME_REQUEST_TIMEOUT_MS = 1_000;
export const MAX_PRIME_REQUEST_TIMEOUT_MS = 600_000;

/** Native status text is display-only: control characters out, then clamp. */
export const boundedPrimeNoticeText = (value: string | undefined, limit: number): string =>
  typeof value === "string"
    ? value
        .replace(/[\u0000-\u001f\u007f]/g, " ")
        .trim()
        .slice(0, limit)
        .trim()
    : "";

/** The four methods that open a dialog and owe the runtime an exact response. */
export type PrimeBlockingUiRequest = Extract<
  PrimeExtensionUiRequest,
  { readonly method: "select" | "confirm" | "input" | "editor" }
>;
export const isBlockingPrimeUiRequest = (
  request: PrimeExtensionUiRequest,
): request is PrimeBlockingUiRequest =>
  request.method === "select" ||
  request.method === "confirm" ||
  request.method === "input" ||
  request.method === "editor";

/**
 * Maps one fire-and-forget operation onto a board entry.
 *
 * Every operation is keyed so a repeat replaces rather than accumulates, and an
 * operation that clears its own content (empty status text, no widget lines)
 * yields `undefined` — that is the runtime's own "dismiss". Notifications are
 * keyed by severity so a chatty info stream cannot bury an error, and
 * `set_editor_text` becomes a suggestion rather than a silent rewrite of every
 * attached client's composer.
 */
export const primeNoticeFor = (
  request: PrimeExtensionUiRequest,
): { readonly key: string; readonly notice: PrimeNotice | undefined } | undefined => {
  switch (request.method) {
    case "notify": {
      const severity = request.notifyType ?? "info";
      const key = `notification:${severity}`;
      const text = boundedPrimeNoticeText(request.message, MAX_PRIME_NOTICE_TEXT);
      return { key, notice: text ? { key, kind: "notification", severity, text } : undefined };
    }
    case "setStatus": {
      const statusKey = boundedPrimeNoticeText(request.statusKey, MAX_PRIME_NOTICE_KEY) || "status";
      const key = `status:${statusKey}`;
      const text = boundedPrimeNoticeText(request.statusText, MAX_PRIME_NOTICE_TEXT);
      return { key, notice: text ? { key, kind: "status", severity: "info", text } : undefined };
    }
    case "setWidget": {
      const widgetKey = boundedPrimeNoticeText(request.widgetKey, MAX_PRIME_NOTICE_KEY) || "widget";
      const key = `widget:${widgetKey}`;
      const lines = (request.widgetLines ?? [])
        .map((line) => boundedPrimeNoticeText(line, MAX_PRIME_NOTICE_LINE))
        .filter((line) => line.length > 0)
        .slice(0, MAX_PRIME_NOTICE_LINES);
      const first = lines[0];
      return {
        key,
        notice:
          first === undefined
            ? undefined
            : { key, kind: "widget", severity: "info", text: first, lines },
      };
    }
    case "setTitle": {
      const key = "title";
      const text = boundedPrimeNoticeText(request.title, MAX_PRIME_NOTICE_TEXT);
      return { key, notice: text ? { key, kind: "title", severity: "info", text } : undefined };
    }
    case "set_editor_text": {
      const key = "editor-text";
      const text = boundedPrimeNoticeText(request.text, MAX_PRIME_NOTICE_TEXT);
      return {
        key,
        notice: text ? { key, kind: "editor-text", severity: "info", text } : undefined,
      };
    }
    default:
      return undefined;
  }
};

/**
 * Applies one operation to a bounded, insertion-ordered board. Replacement moves
 * the entry to the end, so the oldest entry is what an overflow drops.
 */
export const applyPrimeNotice = (
  notices: Map<string, PrimeNotice>,
  request: PrimeExtensionUiRequest,
): Map<string, PrimeNotice> => {
  const mapped = primeNoticeFor(request);
  if (!mapped) return notices;
  notices.delete(mapped.key);
  if (mapped.notice) notices.set(mapped.key, mapped.notice);
  while (notices.size > MAX_PRIME_NOTICES) {
    const oldest = notices.keys().next();
    if (oldest.done) break;
    notices.delete(oldest.value);
  }
  return notices;
};

/** Clamped native timeout in milliseconds, or `undefined` when absent/invalid. */
export const primeRequestTimeoutMs = (timeout: unknown): number | undefined => {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return undefined;
  return Math.min(
    Math.max(Math.round(timeout), MIN_PRIME_REQUEST_TIMEOUT_MS),
    MAX_PRIME_REQUEST_TIMEOUT_MS,
  );
};

export const primeRequestTimeoutReason = (ms: number): string =>
  `Prime Agent interactive request timed out after ${Math.round(ms / 1_000)}s and was cancelled.`;
