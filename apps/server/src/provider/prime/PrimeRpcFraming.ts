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
 * JSON decoding unchanged. There is only one incomplete record in memory, so
 * the total buffered bytes are exactly the current record bytes and are capped
 * by `maxRecordBytes`.
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
    if (this.#partByteLength > 0) {
      throw this.#fail("eof-fragment", this.#partByteLength);
    }
    this.#finished = true;
  }

  #append(part: Uint8Array): void {
    if (part.length === 0) return;
    const byteLength = this.#partByteLength + part.length;
    if (byteLength > this.#maxRecordBytes) {
      throw this.#fail("record-too-large", byteLength);
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
      throw this.#fail("invalid-utf8", byteLength);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw this.#fail("invalid-json", byteLength);
    }
  }

  /** Terminal failures clear retained bytes before exposing only redacted metadata. */
  #fail(reason: PrimeRpcFramingFailureReason, byteLength?: number): PrimeRpcFramingError {
    this.#clear();
    this.#finished = true;
    return new PrimeRpcFramingError(reason, byteLength);
  }

  #clear(): void {
    this.#parts = [];
    this.#partByteLength = 0;
  }
}

/**
 * Serialize one JSON value as exactly one LF-terminated UTF-8 JSONL record.
 *
 * `maxRecordBytes` limits the UTF-8 JSON payload, excluding the terminating
 * LF. JSON.stringify necessarily creates its complete string before framing
 * can enforce this limit; this function avoids an additional unbounded
 * `${"${json}"}\n` string by appending the LF to a bounded byte array.
 */
export const encodePrimeRpcJsonlRecord = (
  value: unknown,
  options: { readonly maxRecordBytes?: number } = {},
): Uint8Array => {
  const maxRecordBytes = options.maxRecordBytes ?? PRIME_RPC_MAX_RECORD_BYTES;
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw new RangeError("maxRecordBytes must be a positive safe integer");
  }

  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new PrimeRpcFramingError("writer-value");
  }
  if (json === undefined) throw new PrimeRpcFramingError("writer-value");

  const payload = new TextEncoder().encode(json);
  if (payload.length > maxRecordBytes) {
    throw new PrimeRpcFramingError("record-too-large", payload.length);
  }
  const record = new Uint8Array(payload.length + 1);
  record.set(payload);
  record[payload.length] = 0x0a;
  return record;
};
