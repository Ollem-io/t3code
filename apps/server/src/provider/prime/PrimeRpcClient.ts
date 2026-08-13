import {
  encodePrimeRpcJsonlRecord,
  PrimeRpcFramingError,
  PrimeRpcJsonlParser,
} from "./PrimeRpcFraming.ts";
import {
  decodePrimeRpcEnvelope,
  type PrimeRpcCommand,
  type PrimeRpcEnvelope,
  type PrimeRpcResponse,
} from "./PrimeRpcProtocol.ts";

/** The session-local byte streams owned by a spawned Prime RPC process. */
export interface PrimeRpcTransport {
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly stderr: AsyncIterable<Uint8Array>;
  readonly exited: Promise<number | null>;
  /** Resolves only after the transport accepted the complete record. */
  readonly write: (record: Uint8Array) => Promise<void>;
}

export type PrimeRpcClientFailureReason =
  | "timeout"
  | "aborted"
  | "write"
  | "eof"
  | "exit"
  | "framing"
  | "response-command"
  | "duplicate-response";

/** Error metadata is deliberately bounded and never contains raw RPC records. */
export class PrimeRpcClientError extends Error {
  readonly _tag = "PrimeRpcClientError";
  constructor(
    readonly reason: PrimeRpcClientFailureReason,
    readonly details: Readonly<Record<string, string | number | boolean | null>> = {},
  ) {
    super(`Prime Agent RPC client failed: ${reason}`);
  }
}

export interface PrimeRpcDiagnosticMetadata {
  readonly pendingRequests: number;
  readonly closed: boolean;
  readonly stderr: string;
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
  readonly timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal: AbortSignal | undefined;
  readonly abort: (() => void) | undefined;
}

const DEFAULT_STDERR_BYTES = 16 * 1024;
const DEFAULT_QUEUED_EVENTS = 256;

/**
 * Correlates Prime's JSONL responses while continuously draining stdout.
 * Events are retained in a bounded ring, so a consumer which does not read
 * events cannot apply backpressure to the child process's stdout pipe.
 */
export class PrimeRpcClient {
  readonly #transport: PrimeRpcTransport;
  readonly #prefix: string;
  readonly #defaultTimeoutMs: number | undefined;
  readonly #maxStderrBytes: number;
  readonly #maxQueuedEvents: number;
  readonly #parser: PrimeRpcJsonlParser;
  readonly #pending = new Map<string, Pending>();
  #nextRequest = 0;
  #closed = false;
  #stderr = "";
  #stderrBytes = 0;
  #stderrTruncated = false;
  #events: PrimeRpcEnvelope[] = [];
  #eventWaiters: Array<(event: PrimeRpcEnvelope | undefined) => void> = [];
  #droppedEvents = 0;
  #duplicateResponses = 0;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(transport: PrimeRpcTransport, options: PrimeRpcClientOptions = {}) {
    this.#transport = transport;
    this.#prefix = options.requestIdPrefix ?? "prime-rpc";
    this.#defaultTimeoutMs = options.defaultTimeoutMs;
    this.#maxStderrBytes = options.maxStderrBytes ?? DEFAULT_STDERR_BYTES;
    this.#maxQueuedEvents = options.maxQueuedEvents ?? DEFAULT_QUEUED_EVENTS;
    if (!Number.isSafeInteger(this.#maxStderrBytes) || this.#maxStderrBytes < 0) throw new RangeError("maxStderrBytes must be a non-negative safe integer");
    if (!Number.isSafeInteger(this.#maxQueuedEvents) || this.#maxQueuedEvents < 1) throw new RangeError("maxQueuedEvents must be a positive safe integer");
    this.#parser = new PrimeRpcJsonlParser({ maxRecordBytes: options.maxRecordBytes });
    void this.#drainStdout();
    void this.#drainStderr();
    void transport.exited.then((code) => this.#close("exit", { code })).catch(() => this.#close("exit", { code: null }));
  }

  /** Generates an opaque monotonic id, registers its waiter, then writes JSONL. */
  command(command: PrimeRpcOutboundCommand, options: PrimeRpcCommandOptions = {}): Promise<PrimeRpcResponse> {
    if (this.#closed) return Promise.reject(new PrimeRpcClientError("exit"));
    const id = `${this.#prefix}-${++this.#nextRequest}`;
    const request = { ...command, id } as PrimeRpcCommand;
    let record: Uint8Array;
    try {
      record = encodePrimeRpcJsonlRecord(request);
    } catch {
      return Promise.reject(new PrimeRpcClientError("write"));
    }
    return new Promise<PrimeRpcResponse>((resolve, reject) => {
      const fail = (reason: PrimeRpcClientFailureReason) => this.#settleReject(id, new PrimeRpcClientError(reason, { id, command: command.type }));
      const timeout = options.timeoutMs ?? this.#defaultTimeoutMs;
      const abort = () => fail("aborted");
      const pending: Pending = {
        command: command.type,
        resolve,
        reject,
        timer: timeout === undefined ? undefined : setTimeout(() => fail("timeout"), timeout),
        signal: options.signal,
        abort: options.signal === undefined ? undefined : abort,
      };
      this.#pending.set(id, pending);
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener("abort", abort, { once: true });
      // Writes are serialized to keep each JSONL record contiguous. stdout is
      // independently drained and therefore never waits for this chain.
      this.#writeTail = this.#writeTail.then(() => this.#transport.write(record));
      void this.#writeTail.catch(() => fail("write"));
    });
  }

  /** Bounded asynchronous event subscription. Unknown events are preserved. */
  async *events(): AsyncGenerator<PrimeRpcEnvelope> {
    while (true) {
      const event = this.#events.shift() ?? await new Promise<PrimeRpcEnvelope | undefined>((resolve) => this.#eventWaiters.push(resolve));
      if (event === undefined) return;
      yield event;
    }
  }

  diagnostics(): PrimeRpcDiagnosticMetadata {
    return { pendingRequests: this.#pending.size, closed: this.#closed, stderr: this.#stderr, stderrTruncated: this.#stderrTruncated, droppedEvents: this.#droppedEvents, duplicateResponses: this.#duplicateResponses };
  }

  close(): void { this.#close("exit", { code: null }); }

  async #drainStdout(): Promise<void> {
    try {
      for await (const chunk of this.#transport.stdout) this.#parser.push(chunk, (value) => this.#handleEnvelope(decodePrimeRpcEnvelope(value)));
      this.#parser.finish();
      this.#close("eof", {});
    } catch (error) {
      this.#close(error instanceof PrimeRpcFramingError ? "framing" : "eof", {});
    }
  }

  async #drainStderr(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of this.#transport.stderr) {
        const remaining = this.#maxStderrBytes - this.#stderrBytes;
        if (remaining <= 0) { this.#stderrTruncated = true; continue; }
        const kept = chunk.subarray(0, remaining);
        this.#stderr += decoder.decode(kept, { stream: true });
        this.#stderrBytes += kept.byteLength;
        if (kept.byteLength !== chunk.byteLength) this.#stderrTruncated = true;
      }
      if (this.#stderrBytes < this.#maxStderrBytes) this.#stderr += decoder.decode();
    } catch { this.#stderrTruncated = true; }
  }

  #handleEnvelope(envelope: PrimeRpcEnvelope): void {
    if (envelope._tag !== "response") { this.#offerEvent(envelope); return; }
    const id = envelope.value.id;
    if (id === undefined) { this.#offerEvent(envelope); return; }
    const pending = this.#pending.get(id);
    if (!pending) { this.#duplicateResponses += 1; return; }
    if (pending.command !== envelope.value.command) {
      this.#settleReject(id, new PrimeRpcClientError("response-command", { id, expected: pending.command, actual: envelope.value.command }));
      return;
    }
    this.#settleResolve(id, envelope.value);
  }

  #offerEvent(event: PrimeRpcEnvelope): void {
    const waiter = this.#eventWaiters.shift();
    if (waiter) { waiter(event); return; }
    if (this.#events.length === this.#maxQueuedEvents) { this.#events.shift(); this.#droppedEvents += 1; }
    this.#events.push(event);
  }

  #settleResolve(id: string, response: PrimeRpcResponse): void {
    const pending = this.#pending.get(id); if (!pending) return;
    this.#clearPending(id, pending); pending.resolve(response);
  }
  #settleReject(id: string, error: PrimeRpcClientError): void {
    const pending = this.#pending.get(id); if (!pending) return;
    this.#clearPending(id, pending); pending.reject(error);
  }
  #clearPending(id: string, pending: Pending): void {
    this.#pending.delete(id); if (pending.timer) clearTimeout(pending.timer);
    if (pending.signal && pending.abort) pending.signal.removeEventListener("abort", pending.abort);
  }
  #close(reason: "eof" | "exit" | "framing", details: Readonly<Record<string, string | number | boolean | null>>): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const [id, pending] of this.#pending) this.#settleReject(id, new PrimeRpcClientError(reason, details));
    for (const waiter of this.#eventWaiters.splice(0)) waiter(undefined);
  }
}
