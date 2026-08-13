import {
  encodePrimeRpcJsonlRecord,
  PRIME_RPC_MAX_RECORD_BYTES,
  PrimeRpcFramingError,
  PrimeRpcJsonlParser,
} from "./PrimeRpcFraming.ts";
import {
  decodePrimeRpcEnvelope,
  type PrimeRpcCommand,
  type PrimeRpcEnvelope,
  type PrimeRpcResponse,
} from "./PrimeRpcProtocol.ts";

/** Session-local streams owned by a Prime RPC child process. `close` cancels owned readers. */
export interface PrimeRpcTransport {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number | null>;
  /** Resolves only after the transport accepted the complete record. */
  readonly write: (record: Uint8Array) => Promise<void>;
  /** Optional process adapter cleanup; invoked exactly once when this client closes. */
  readonly close?: () => void | Promise<void>;
}

export type PrimeRpcClientFailureReason =
  | "timeout" | "aborted" | "write" | "eof" | "exit" | "framing"
  | "protocol" | "response-command" | "duplicate-response";

/** Error metadata is bounded and never contains raw RPC records or stderr. */
export class PrimeRpcClientError extends Error {
  readonly _tag = "PrimeRpcClientError";
  constructor(
    readonly reason: PrimeRpcClientFailureReason,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) { super(`Prime Agent RPC client failed: ${reason}`); }
}

export interface PrimeRpcDiagnosticMetadata {
  readonly pendingRequests: number;
  readonly closed: boolean;
  /** stderr is intentionally redacted; only its bounded accounting is exposed. */
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
  readonly droppedEvents: number;
  readonly duplicateResponses: number;
}

type CommandWithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
export type PrimeRpcOutboundCommand = CommandWithoutId<PrimeRpcCommand>;
export interface PrimeRpcCommandOptions { readonly timeoutMs?: number; readonly signal?: AbortSignal; }
export interface PrimeRpcClientOptions {
  readonly requestIdPrefix?: string;
  /** Finite positive timeout used unless a command supplies its own. */
  readonly defaultTimeoutMs?: number;
  readonly maxStderrBytes?: number;
  readonly maxQueuedEvents?: number;
  /** The same UTF-8 payload cap applies to incoming and outgoing records. */
  readonly maxRecordBytes?: number;
}
interface Pending {
  readonly command: string;
  readonly resolve: (response: PrimeRpcResponse) => void;
  readonly reject: (error: PrimeRpcClientError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}
const DEFAULT_STDERR_BYTES = 16 * 1024;
const DEFAULT_QUEUED_EVENTS = 256;
const DEFAULT_TIMEOUT_MS = 30_000;
const safeInteger = (value: number, minimum: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${name} must be a ${minimum === 0 ? "non-negative" : "positive"} safe integer`);
  return value;
};

/**
 * Correlates Prime JSONL responses while continuously draining stdout. Events are
 * a single, bounded subscription: a slow (or absent) event reader can never
 * backpressure response draining. Closing drains events and ends its iterator.
 */
export class PrimeRpcClient {
  readonly #transport: PrimeRpcTransport;
  readonly #prefix: string;
  readonly #defaultTimeoutMs: number;
  readonly #maxStderrBytes: number;
  readonly #maxQueuedEvents: number;
  readonly #maxRecordBytes: number;
  readonly #parser: PrimeRpcJsonlParser;
  readonly #pending = new Map<string, Pending>();
  #nextRequest = 0;
  #closed = false;
  #stderrBytes = 0;
  #stderrTruncated = false;
  #events: PrimeRpcEnvelope[] = [];
  #eventWaiter: ((event: PrimeRpcEnvelope | undefined) => void) | undefined;
  #eventSubscription = false;
  #droppedEvents = 0;
  #duplicateResponses = 0;
  #writeTail: Promise<void> = Promise.resolve();
  #transportClosed = false;

  constructor(transport: PrimeRpcTransport, options: PrimeRpcClientOptions = {}) {
    this.#transport = transport;
    this.#prefix = options.requestIdPrefix ?? "prime-rpc";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.#prefix)) throw new RangeError("requestIdPrefix must be 1-64 safe identifier characters");
    this.#defaultTimeoutMs = safeInteger(options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, 1, "defaultTimeoutMs");
    this.#maxStderrBytes = safeInteger(options.maxStderrBytes ?? DEFAULT_STDERR_BYTES, 0, "maxStderrBytes");
    this.#maxQueuedEvents = safeInteger(options.maxQueuedEvents ?? DEFAULT_QUEUED_EVENTS, 1, "maxQueuedEvents");
    this.#maxRecordBytes = safeInteger(options.maxRecordBytes ?? PRIME_RPC_MAX_RECORD_BYTES, 1, "maxRecordBytes");
    this.#parser = new PrimeRpcJsonlParser({ maxRecordBytes: this.#maxRecordBytes });
    void this.#drainStdout();
    void this.#drainStderr();
    void transport.exited.then((code) => this.#close("exit", { code })).catch(() => this.#close("exit", { code: null }));
  }

  command(command: PrimeRpcOutboundCommand, options: PrimeRpcCommandOptions = {}): Promise<PrimeRpcResponse> {
    if (this.#closed) return Promise.reject(new PrimeRpcClientError("exit"));
    const timeout = safeInteger(options.timeoutMs ?? this.#defaultTimeoutMs, 1, "timeoutMs");
    const id = `${this.#prefix}-${++this.#nextRequest}`;
    let record: Uint8Array;
    try { record = encodePrimeRpcJsonlRecord({ ...command, id } as PrimeRpcCommand, { maxRecordBytes: this.#maxRecordBytes }); }
    catch { return Promise.reject(new PrimeRpcClientError("write", { id, command: command.type })); }
    return new Promise<PrimeRpcResponse>((resolve, reject) => {
      const fail = (reason: PrimeRpcClientFailureReason) => this.#settleReject(id, new PrimeRpcClientError(reason, { id, command: command.type }));
      const abort = () => fail("aborted");
      const pending: Pending = { command: command.type, resolve, reject, timer: setTimeout(() => fail("timeout"), timeout), signal: options.signal, abort: options.signal === undefined ? undefined : abort };
      this.#pending.set(id, pending);
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener("abort", abort, { once: true });
      this.#writeTail = this.#writeTail.catch(() => undefined).then(() => this.#transport.write(record));
      void this.#writeTail.catch(() => fail("write"));
    });
  }

  /**
   * One subscription only. `return()` removes an unresolved waiter immediately;
   * closing drains queued events and makes current and future `next()` complete.
   */
  events(): AsyncIterableIterator<PrimeRpcEnvelope> {
    if (this.#eventSubscription) throw new PrimeRpcClientError("protocol", { eventSubscription: true });
    this.#eventSubscription = true;
    let returned = false;
    let waiter: ((event: PrimeRpcEnvelope | undefined) => void) | undefined;
    let finishWaiting: (() => void) | undefined;
    const detach = () => {
      if (this.#eventWaiter === waiter) this.#eventWaiter = undefined;
      waiter = undefined;
      this.#eventSubscription = false;
    };
    const cancelWaiting = () => { const finish = finishWaiting; finishWaiting = undefined; finish?.(); };
    return {
      [Symbol.asyncIterator]() { return this; },
      next: () => {
        if (returned || this.#closed) { detach(); return Promise.resolve({ value: undefined, done: true }); }
        const event = this.#events.shift();
        if (event !== undefined) return Promise.resolve({ value: event, done: false });
        return new Promise<IteratorResult<PrimeRpcEnvelope>>((resolve) => {
          finishWaiting = () => { detach(); resolve({ value: undefined, done: true }); };
          waiter = (value) => { finishWaiting = undefined; detach(); resolve(value === undefined ? { value: undefined, done: true } : { value, done: false }); };
          this.#eventWaiter = waiter;
        });
      },
      return: () => { returned = true; cancelWaiting(); detach(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }

  diagnostics(): PrimeRpcDiagnosticMetadata {
    return { pendingRequests: this.#pending.size, closed: this.#closed, stderrBytes: this.#stderrBytes, stderrTruncated: this.#stderrTruncated, droppedEvents: this.#droppedEvents, duplicateResponses: this.#duplicateResponses };
  }
  close(): void { this.#close("exit", { code: null }); }

  async #drainStdout(): Promise<void> {
    try {
      for await (const chunk of this.#transport.stdout) {
        this.#parser.push(chunk, (value) => this.#handleEnvelope(decodePrimeRpcEnvelope(value)));
        if (this.#closed) return;
      }
      this.#parser.finish();
      this.#close("eof", {});
    } catch (error) { this.#close(error instanceof PrimeRpcFramingError ? "framing" : "eof", {}); }
  }
  async #drainStderr(): Promise<void> {
    try { for await (const chunk of this.#transport.stderr) {
      const remaining = Math.max(0, this.#maxStderrBytes - this.#stderrBytes);
      const retained = Math.min(chunk.byteLength, remaining);
      this.#stderrBytes += retained;
      if (retained !== chunk.byteLength) this.#stderrTruncated = true;
    } } catch { this.#stderrTruncated = true; }
  }
  #handleEnvelope(envelope: PrimeRpcEnvelope): void {
    if (envelope._tag === "malformed") { this.#close("protocol", { envelope: envelope.error.envelopeClass }); return; }
    if (envelope._tag !== "response") { this.#offerEvent(envelope); return; }
    const id = envelope.value.id;
    if (id === undefined) { this.#close("protocol", { responseId: false }); return; }
    const pending = this.#pending.get(id);
    if (!pending) { this.#duplicateResponses += 1; return; }
    if (pending.command !== envelope.value.command) { this.#settleReject(id, new PrimeRpcClientError("response-command", { id, expected: pending.command, actual: envelope.value.command })); return; }
    this.#settleResolve(id, envelope.value);
  }
  #offerEvent(event: PrimeRpcEnvelope): void {
    if (this.#closed) return;
    const waiter = this.#eventWaiter; this.#eventWaiter = undefined;
    if (waiter) { waiter(event); return; }
    if (this.#events.length === this.#maxQueuedEvents) { this.#events.shift(); this.#droppedEvents += 1; }
    this.#events.push(event);
  }
  #settleResolve(id: string, response: PrimeRpcResponse): void { const pending = this.#pending.get(id); if (!pending) return; this.#clearPending(id, pending); pending.resolve(response); }
  #settleReject(id: string, error: PrimeRpcClientError): void { const pending = this.#pending.get(id); if (!pending) return; this.#clearPending(id, pending); pending.reject(error); }
  #clearPending(id: string, pending: Pending): void { this.#pending.delete(id); clearTimeout(pending.timer); if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort); }
  #close(reason: "eof" | "exit" | "framing" | "protocol", details: Readonly<Record<string, string | number | boolean | null>>): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id] of this.#pending) this.#settleReject(id, new PrimeRpcClientError(reason, details));
    this.#events = [];
    const waiter = this.#eventWaiter; this.#eventWaiter = undefined; waiter?.(undefined);
    if (!this.#transportClosed) { this.#transportClosed = true; void Promise.resolve(this.#transport.close?.()).catch(() => undefined); }
  }
}
