#!/usr/bin/env node
/**
 * Portable PA-M02 JSONL framing conformance proof. Copy this file alone to a
 * fresh directory and run `node prime-rpc-jsonl-conformance.mjs`.
 * It deliberately uses only Node built-ins and does not read repository files.
 */
const MAX_RECORD_BYTES = 1024 * 1024;
class FramingError extends Error {
  constructor(reason, byteLength) { super(`Prime Agent RPC framing failed: ${reason}`); this.reason = reason; this.byteLength = byteLength; }
}
class Parser {
  #max; #parts = []; #length = 0; #finished = false;
  constructor({ maxRecordBytes = MAX_RECORD_BYTES } = {}) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new RangeError("maxRecordBytes must be a positive safe integer");
    this.#max = maxRecordBytes;
  }
  push(chunk, emit) {
    if (this.#finished) throw new Error("Prime RPC JSONL parser is finished");
    let start = 0;
    while (start < chunk.length) {
      let lf = start; while (lf < chunk.length && chunk[lf] !== 10) lf += 1;
      if (lf === chunk.length) { this.#append(chunk.subarray(start)); break; }
      this.#append(chunk.subarray(start, lf)); const record = this.#decode();
      try { emit(record); } catch (error) { this.#clear(); this.#finished = true; throw error; }
      start = lf + 1;
    }
  }
  finish() { if (this.#finished) return; if (this.#length) throw this.#fail("eof-fragment", this.#length); this.#finished = true; }
  #append(part) { if (!part.length) return; const length = this.#length + part.length; if (length > this.#max) throw this.#fail("record-too-large", length); this.#parts.push(part.slice()); this.#length = length; }
  #decode() {
    const length = this.#length, record = new Uint8Array(length); let offset = 0;
    for (const part of this.#parts) { record.set(part, offset); offset += part.length; }
    this.#clear(); const payload = record.at(-1) === 13 ? record.subarray(0, -1) : record;
    let text; try { text = new TextDecoder("utf-8", { fatal: true }).decode(payload); } catch { throw this.#fail("invalid-utf8", length); }
    try { return JSON.parse(text); } catch { throw this.#fail("invalid-json", length); }
  }
  #fail(reason, byteLength) { this.#clear(); this.#finished = true; return new FramingError(reason, byteLength); }
  #clear() { this.#parts = []; this.#length = 0; }
}
function encode(value, { maxRecordBytes = MAX_RECORD_BYTES } = {}) {
  if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) throw new RangeError("maxRecordBytes must be a positive safe integer");
  let json; try { json = JSON.stringify(value); } catch { throw new FramingError("writer-value"); }
  if (json === undefined) throw new FramingError("writer-value");
  const payload = new TextEncoder().encode(json);
  if (payload.length > maxRecordBytes) throw new FramingError("record-too-large", payload.length);
  const record = new Uint8Array(payload.length + 1); record.set(payload); record[payload.length] = 10; return record;
}
const utf8 = new TextEncoder(), text = new TextDecoder();
const equal = (actual, expected) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("unexpected result"); };
const reason = (run, expected) => { try { run(); } catch (error) { if (error instanceof FramingError && error.reason === expected) return; } throw new Error(`expected ${expected}`); };
const throws = (run) => { try { run(); } catch { return; } throw new Error("expected throw"); };
const push = (parser, bytes) => { const values = []; parser.push(bytes, (value) => values.push(value)); return values; };
const priorThenFailure = (bytes, expected, options = {}) => { const p = new Parser(options), values = []; reason(() => p.push(bytes, (value) => values.push(value)), expected); equal(values, expected === "record-too-large" ? [0] : [{ ok: 1 }]); throws(() => p.push(utf8.encode("3\n"), (value) => values.push(value))); if (values.length !== 1) throw new Error("later emission"); p.finish(); };
const cases = {
  "lf-single-and-multiple": () => { const p = new Parser(); equal(push(p, utf8.encode('{"one":1}\n{"two":2}\n')), [{ one: 1 }, { two: 2 }]); p.finish(); },
  "arbitrary-three-way-chunk-partitions": () => { const bytes = utf8.encode('{"message":"🦀 café"}\n'); for (let a = 0; a <= bytes.length; a++) for (let b = a; b <= bytes.length; b++) { const p = new Parser(), values = []; p.push(bytes.subarray(0, a), value => values.push(value)); p.push(bytes.subarray(a, b), value => values.push(value)); p.push(bytes.subarray(b), value => values.push(value)); equal(values, [{ message: "🦀 café" }]); p.finish(); } },
  "crlf-only-one-cr-stripped": () => { const p = new Parser(); equal(push(p, utf8.encode('{"ok":true}\r\n')), [{ ok: true }]); equal(push(p, utf8.encode('{"ok":true}\r\r\n')), [{ ok: true }]); p.finish(); },
  "unicode-line-separators-are-data": () => { const p = new Parser(); equal(push(p, utf8.encode('{"text":"a b c"}\n')), [{ text: "a b c" }]); p.finish(); },
  "empty-line-terminal-invalid-json": () => { const p = new Parser(); reason(() => p.push(utf8.encode("\n"), () => {}), "invalid-json"); throws(() => p.push(utf8.encode("0\n"), () => {})); p.finish(); },
  "valid-then-invalid-json-emits-prior": () => priorThenFailure(utf8.encode('{"ok":1}\n{bad}\n{"later":2}\n'), "invalid-json"),
  "valid-then-invalid-utf8-emits-prior": () => priorThenFailure(Uint8Array.from([...utf8.encode('{"ok":1}\n'), 255, 10, ...utf8.encode('{"later":2}\n')]), "invalid-utf8"),
  "valid-then-oversize-emits-prior": () => priorThenFailure(utf8.encode("0\n12345\n2\n"), "record-too-large", { maxRecordBytes: 4 }),
  "consumer-throw-is-terminal": () => { const p = new Parser(), error = new Error("consumer"); try { p.push(utf8.encode("1\n2\n"), () => { throw error; }); } catch (caught) { if (caught !== error) throw caught; } throws(() => p.push(utf8.encode("3\n"), () => {})); p.finish(); },
  "many-fragment-total-buffer-cap": () => { const p = new Parser({ maxRecordBytes: 64 }); for (let i = 0; i < 64; i++) p.push(Uint8Array.of(32), () => {}); reason(() => p.push(Uint8Array.of(32), () => {}), "record-too-large"); p.finish(); },
  "record-exact-cap": () => { const p = new Parser({ maxRecordBytes: 2 }); equal(push(p, utf8.encode("[]\n")), [[]]); p.finish(); },
  "eof-fragment-terminal-and-finish-idempotent": () => { const p = new Parser(); p.push(utf8.encode('{"partial":true}'), () => {}); reason(() => p.finish(), "eof-fragment"); p.finish(); const done = new Parser(); done.finish(); done.finish(); },
  "writer-lf-and-unicode-data": () => { const bytes = encode({ text: "a b c" }); if (text.decode(bytes) !== '{"text":"a b c"}\n' || bytes.filter((byte) => byte === 10).length !== 1) throw new Error("not one LF record"); },
  "writer-value-rejection": () => { reason(() => encode(undefined), "writer-value"); const circular = {}; circular.self = circular; reason(() => encode(circular), "writer-value"); },
  "writer-utf8-payload-cap-excludes-lf": () => { if (text.decode(encode("é", { maxRecordBytes: 4 })) !== '"é"\n') throw new Error("exact cap rejected"); reason(() => encode("é", { maxRecordBytes: 3 }), "record-too-large"); },
};
let failed = false;
for (const [name, run] of Object.entries(cases)) {
  try { run(); console.log(`${name} pass`); } catch { console.log(`${name} fail`); failed = true; }
}
process.exitCode = failed ? 1 : 0;
