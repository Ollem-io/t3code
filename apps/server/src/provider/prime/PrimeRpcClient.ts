// @effect-diagnostics globalTimers:off
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

/** Session-local streams owned by one Prime RPC child process. */
export type PrimeRpcTransportTerminal =
  | { readonly kind: "exit"; readonly code: number | null }
  | { readonly kind: "eof" };

export interface PrimeRpcTransport {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  /** Authoritative lifecycle classification for the transport owner. */
  readonly terminal: Promise<PrimeRpcTransportTerminal>;
  /** Resolves only after the complete record was accepted by the stream. */
  readonly write: (record: Uint8Array) => Promise<void>;
  /** Cancels only resources owned by this transport. */
  readonly close?: () => void | Promise<void>;
}

export type PrimeRpcClientFailureReason =
  | "timeout"
  | "aborted"
  | "write"
  | "eof"
  | "exit"
  | "framing"
  | "protocol"
  | "response-command"
  | "duplicate-response";

/** Bounded metadata only: errors never retain RPC records, stderr, or thrown values. */
export class PrimeRpcClientError extends Error {
  readonly _tag = "PrimeRpcClientError";
  readonly reason: PrimeRpcClientFailureReason;
  readonly details: Readonly<Record<string, string | number | boolean | null>>;
  constructor(
    reason: PrimeRpcClientFailureReason,
    details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(`Prime Agent RPC client failed: ${reason}`);
    this.reason = reason;
    this.details = details;
  }
}

export interface PrimeRpcDiagnosticMetadata {
  readonly pendingRequests: number;
  readonly closed: boolean;
  readonly stderrBytes: number;
  readonly stderrTruncated: boolean;
  readonly droppedEvents: number;
  readonly duplicateResponses: number;
}

type CommandWithoutId<T> = T extends unknown ? Omit<T, "id"> : never;
export type PrimeRpcOutboundCommand = CommandWithoutId<PrimeRpcCommand>;
export interface PrimeRpcCommandOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}
export interface PrimeRpcClientOptions {
  readonly requestIdPrefix?: string;
  readonly defaultTimeoutMs?: number;
  readonly maxStderrBytes?: number;
  readonly maxQueuedEvents?: number;
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
interface WriteJob {
  readonly id: string;
  readonly record: Uint8Array;
}
const DEFAULT_STDERR_BYTES = 16 * 1024;
const DEFAULT_QUEUED_EVENTS = 256;
const DEFAULT_TIMEOUT_MS = 30_000;
const safeInteger = (value: number, minimum: number, name: string) => {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(
      `${name} must be a ${minimum === 0 ? "non-negative" : "positive"} safe integer`,
    );
  return value;
};

/**
 * Correlates responses while continuously draining stdout. Writes are FIFO.
 * A queued job is re-checked immediately before write, so cancellation, timeout,
 * or close prevents it from reaching the pipe. Once a write starts it cannot be
 * undone; its late response is diagnostic-only. The transport owns lifecycle
 * classification: stdout completion waits for its authoritative terminal result,
 * so process exit ordering never depends on event-loop timing.
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
  #closeError: PrimeRpcClientError | undefined;

  constructor(transport: PrimeRpcTransport, options: PrimeRpcClientOptions = {}) {
    this.#transport = transport;
    this.#prefix = options.requestIdPrefix ?? "prime-rpc";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(this.#prefix))
      throw new RangeError("requestIdPrefix must be 1-64 safe identifier characters");
    this.#defaultTimeoutMs = safeInteger(
      options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      1,
      "defaultTimeoutMs",
    );
    this.#maxStderrBytes = safeInteger(
      options.maxStderrBytes ?? DEFAULT_STDERR_BYTES,
      0,
      "maxStderrBytes",
    );
    this.#maxQueuedEvents = safeInteger(
      options.maxQueuedEvents ?? DEFAULT_QUEUED_EVENTS,
      1,
      "maxQueuedEvents",
    );
    this.#maxRecordBytes = safeInteger(
      options.maxRecordBytes ?? PRIME_RPC_MAX_RECORD_BYTES,
      1,
      "maxRecordBytes",
    );
    this.#parser = new PrimeRpcJsonlParser({ maxRecordBytes: this.#maxRecordBytes });
    void this.#drainStdout();
    void this.#drainStderr();
    void transport.terminal.then(
      (terminal) => this.#closeTerminal(terminal),
      () => this.#close("exit", { code: null }),
    );
  }

  command(
    command: PrimeRpcOutboundCommand,
    options: PrimeRpcCommandOptions = {},
  ): Promise<PrimeRpcResponse> {
    if (this.#closed)
      return Promise.reject(this.#closeError ?? new PrimeRpcClientError("exit", { closed: true }));
    const timeout = safeInteger(options.timeoutMs ?? this.#defaultTimeoutMs, 1, "timeoutMs");
    const id = `${this.#prefix}-${++this.#nextRequest}`;
    let record: Uint8Array;
    try {
      record = encodePrimeRpcJsonlRecord({ ...command, id } as PrimeRpcCommand, {
        maxRecordBytes: this.#maxRecordBytes,
      });
    } catch {
      return Promise.reject(
        new PrimeRpcClientError("write", { id, command: command.type, phase: "encode" }),
      );
    }
    return new Promise<PrimeRpcResponse>((resolve, reject) => {
      const fail = (reason: "timeout" | "aborted") =>
        this.#settleReject(id, new PrimeRpcClientError(reason, { id, command: command.type }));
      const abort = () => fail("aborted");
      const pending: Pending = {
        command: command.type,
        resolve,
        reject,
        timer: setTimeout(() => fail("timeout"), timeout),
        signal: options.signal,
        abort: options.signal === undefined ? undefined : abort,
      };
      this.#pending.set(id, pending);
      if (options.signal?.aborted) {
        abort();
        return;
      }
      options.signal?.addEventListener("abort", abort, { once: true });
      this.#enqueueWrite({ id, record });
    });
  }

  /** One iterator owns the subscription for its full lifetime, until return or close. */
  events(): AsyncIterableIterator<PrimeRpcEnvelope> {
    if (this.#eventSubscription)
      throw new PrimeRpcClientError("protocol", { eventSubscription: true });
    this.#eventSubscription = true;
    let returned = false;
    let waiting = false;
    const release = () => {
      this.#eventSubscription = false;
    };
    const iterator: AsyncIterableIterator<PrimeRpcEnvelope> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: () => {
        if (returned) return Promise.resolve({ value: undefined, done: true });
        if (waiting)
          return Promise.reject(new PrimeRpcClientError("protocol", { concurrentEventNext: true }));
        const event = this.#events.shift();
        if (event !== undefined) return Promise.resolve({ value: event, done: false });
        if (this.#closed) {
          release();
          return Promise.resolve({ value: undefined, done: true });
        }
        waiting = true;
        return new Promise<IteratorResult<PrimeRpcEnvelope>>((resolve) => {
          this.#eventWaiter = (value) => {
            waiting = false;
            this.#eventWaiter = undefined;
            if (value === undefined && this.#events.length > 0) {
              resolve({ value: this.#events.shift()!, done: false });
              return;
            }
            if (value === undefined) release();
            resolve(
              value === undefined ? { value: undefined, done: true } : { value, done: false },
            );
          };
        });
      },
      return: () => {
        returned = true;
        const waiter = this.#eventWaiter;
        this.#eventWaiter = undefined;
        waiting = false;
        release();
        waiter?.(undefined);
        return Promise.resolve({ value: undefined, done: true });
      },
    };
    return iterator;
  }

  diagnostics(): PrimeRpcDiagnosticMetadata {
    return {
      pendingRequests: this.#pending.size,
      closed: this.#closed,
      stderrBytes: this.#stderrBytes,
      stderrTruncated: this.#stderrTruncated,
      droppedEvents: this.#droppedEvents,
      duplicateResponses: this.#duplicateResponses,
    };
  }
  close(): void {
    this.#close("exit", { code: null, requested: true });
  }

  #enqueueWrite(job: WriteJob): void {
    this.#writeTail = this.#writeTail.then(async () => {
      if (this.#closed || !this.#pending.has(job.id)) return;
      try {
        await this.#transport.write(job.record);
      } catch {
        this.#close("write", { id: job.id, phase: "transport" });
      }
    });
  }
  async #drainStdout(): Promise<void> {
    try {
      for await (const chunk of this.#transport.stdout) {
        this.#parser.push(chunk, (value) => this.#handleEnvelope(decodePrimeRpcEnvelope(value)));
        if (this.#closed) return;
      }
      this.#parser.finish();
      if (!this.#closed) this.#closeTerminal(await this.#transport.terminal);
    } catch (error) {
      if (error instanceof PrimeRpcFramingError) this.#close("framing", {});
      else {
        try {
          this.#closeTerminal(await this.#transport.terminal);
        } catch {
          this.#close("exit", { code: null });
        }
      }
    }
  }
  async #drainStderr(): Promise<void> {
    try {
      for await (const chunk of this.#transport.stderr) {
        const remaining = Math.max(0, this.#maxStderrBytes - this.#stderrBytes);
        const retained = Math.min(chunk.byteLength, remaining);
        this.#stderrBytes += retained;
        if (retained !== chunk.byteLength) this.#stderrTruncated = true;
      }
    } catch {
      this.#stderrTruncated = true;
    }
  }
  #closeTerminal(terminal: PrimeRpcTransportTerminal): void {
    if (terminal.kind === "exit") this.#close("exit", { code: terminal.code });
    else this.#close("eof", {});
  }
  #handleEnvelope(envelope: PrimeRpcEnvelope): void {
    if (envelope._tag === "malformed") {
      this.#close("protocol", { envelope: envelope.error.envelopeClass });
      return;
    }
    if (envelope._tag !== "response") {
      this.#offerEvent(envelope);
      return;
    }
    const id = envelope.value.id;
    if (id === undefined) {
      this.#close("protocol", { responseId: false });
      return;
    }
    const pending = this.#pending.get(id);
    if (!pending) {
      this.#duplicateResponses += 1;
      return;
    }
    if (pending.command !== envelope.value.command) {
      this.#settleReject(
        id,
        new PrimeRpcClientError("response-command", {
          id,
          expected: pending.command,
          actual: envelope.value.command,
        }),
      );
      return;
    }
    this.#settleResolve(id, envelope.value);
  }
  #offerEvent(event: PrimeRpcEnvelope): void {
    if (this.#closed) return;
    const waiter = this.#eventWaiter;
    if (waiter) {
      waiter(event);
      return;
    }
    if (this.#events.length === this.#maxQueuedEvents) {
      this.#droppedEvents += 1;
      this.#close("protocol", { eventOverflow: true, maxQueuedEvents: this.#maxQueuedEvents });
      return;
    }
    this.#events.push(event);
  }
  #settleResolve(id: string, response: PrimeRpcResponse): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#clearPending(id, pending);
    pending.resolve(response);
  }
  #settleReject(id: string, error: PrimeRpcClientError): void {
    const pending = this.#pending.get(id);
    if (!pending) return;
    this.#clearPending(id, pending);
    pending.reject(error);
  }
  #clearPending(id: string, pending: Pending): void {
    this.#pending.delete(id);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
  }
  #close(
    reason: "write" | "eof" | "exit" | "framing" | "protocol",
    details: Readonly<Record<string, string | number | boolean | null>>,
  ): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#closeError = new PrimeRpcClientError(reason, details);
    for (const [id] of this.#pending)
      this.#settleReject(id, new PrimeRpcClientError(reason, details));
    const waiter = this.#eventWaiter;
    this.#eventWaiter = undefined;
    waiter?.(undefined);
    if (!this.#transportClosed) {
      this.#transportClosed = true;
      void Promise.resolve(this.#transport.close?.()).catch(() => undefined);
    }
  }
}
