/**
 * Strict LF-delimited JSONL framing for the Prime Agent RPC transport.
 *
 * Framing stays byte-oriented until a complete line is available. In
 * particular, U+2028/U+2029 are ordinary UTF-8 data here, not delimiters.
 */
export const PRIME_RPC_MAX_RECORD_BYTES = 1024 * 1024;

export type PrimeRpcFramingFailureReason =
  | "eof-fragment"
  | "invalid-json"
  | "invalid-utf8"
  | "record-too-large"
  | "writer-value";

/** A transport-boundary error which deliberately never retains raw payloads. */
export class PrimeRpcFramingError extends Error {
  readonly _tag = "PrimeRpcFramingError";

  constructor(
    readonly reason: PrimeRpcFramingFailureReason,
    readonly byteLength?: number,
  ) {
    super(`Prime Agent RPC framing failed: ${reason}`);
  }
}

const findLineFeed = (bytes: Uint8Array, start: number): number => {
  for (let index = start; index < bytes.length; index += 1) {
    if (bytes[index] === 0x0a) return index;
  }
  return -1;
};

/**
 * A bounded, incremental JSONL decoder.
 *
 * `push` emits only records terminated by LF. A single CR immediately before
 * the LF is tolerated and removed; all other bytes are passed to UTF-8 and
 * JSON decoding unchanged. `finish` rejects a non-empty unterminated record.
 */
export class PrimeRpcJsonlParser {
  readonly #maxRecordBytes: number;
  #parts: Array<Uint8Array> = [];
  #partByteLength = 0;
  #finished = false;

  constructor(options: { readonly maxRecordBytes?: number } = {}) {
    this.#maxRecordBytes = options.maxRecordBytes ?? PRIME_RPC_MAX_RECORD_BYTES;
    if (!Number.isSafeInteger(this.#maxRecordBytes) || this.#maxRecordBytes < 1) {
      throw new RangeError("maxRecordBytes must be a positive safe integer");
    }
  }

  push(chunk: Uint8Array): Array<unknown> {
    if (this.#finished) throw new Error("Prime RPC JSONL parser is finished");

    const records: Array<unknown> = [];
    let start = 0;
    while (start < chunk.length) {
      const lineFeed = findLineFeed(chunk, start);
      if (lineFeed === -1) {
        this.#append(chunk.subarray(start));
        break;
      }

      this.#append(chunk.subarray(start, lineFeed));
      records.push(this.#decodeRecord());
      start = lineFeed + 1;
    }
    return records;
  }

  /** Reject an unterminated final fragment; a final LF is required. */
  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#partByteLength > 0) {
      const byteLength = this.#partByteLength;
      this.#clear();
      throw new PrimeRpcFramingError("eof-fragment", byteLength);
    }
  }

  #append(part: Uint8Array): void {
    if (part.length === 0) return;
    const byteLength = this.#partByteLength + part.length;
    if (byteLength > this.#maxRecordBytes) {
      this.#clear();
      this.#finished = true;
      throw new PrimeRpcFramingError("record-too-large", byteLength);
    }
    // Retain a copy: callers are allowed to reuse their input chunk after push.
    this.#parts.push(part.slice());
    this.#partByteLength = byteLength;
  }

  #decodeRecord(): unknown {
    const byteLength = this.#partByteLength;
    const record = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of this.#parts) {
      record.set(part, offset);
      offset += part.length;
    }
    this.#clear();

    const withoutTrailingCr = record.at(-1) === 0x0d ? record.subarray(0, -1) : record;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(withoutTrailingCr);
    } catch {
      throw new PrimeRpcFramingError("invalid-utf8", byteLength);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new PrimeRpcFramingError("invalid-json", byteLength);
    }
  }

  #clear(): void {
    this.#parts = [];
    this.#partByteLength = 0;
  }
}

/** Serialize one JSON value as exactly one LF-terminated UTF-8 JSONL record. */
export const encodePrimeRpcJsonlRecord = (value: unknown): Uint8Array => {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new PrimeRpcFramingError("writer-value");
  }
  if (json === undefined) throw new PrimeRpcFramingError("writer-value");
  return new TextEncoder().encode(`${json}\n`);
};
