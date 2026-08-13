import { assert, describe, it } from "@effect/vitest";

import {
  encodePrimeRpcJsonlRecord,
  PrimeRpcFramingError,
  PrimeRpcJsonlParser,
} from "./PrimeRpcFraming.ts";

const utf8 = new TextEncoder();
const text = new TextDecoder();

const framingError = (run: () => unknown, reason: PrimeRpcFramingError["reason"]) => {
  assert.throws(run, (error: unknown) =>
    error instanceof PrimeRpcFramingError && error.reason === reason,
  );
};

describe("PrimeRpcJsonlParser", () => {
  it("parses single and multiple LF-delimited records", () => {
    const parser = new PrimeRpcJsonlParser();
    assert.deepStrictEqual(parser.push(utf8.encode('{"one":1}\n{"two":2}\n')), [
      { one: 1 },
      { two: 2 },
    ]);
    parser.finish();
  });

  it("handles every possible UTF-8 chunk boundary", () => {
    const bytes = utf8.encode('{"message":"🦀 café"}\n');
    const parser = new PrimeRpcJsonlParser();
    const values: Array<unknown> = [];
    for (const byte of bytes) values.push(...parser.push(Uint8Array.of(byte)));
    assert.deepStrictEqual(values, [{ message: "🦀 café" }]);
    parser.finish();
  });

  it("accepts CRLF but strips only one CR", () => {
    const parser = new PrimeRpcJsonlParser();
    assert.deepStrictEqual(parser.push(utf8.encode('{"ok":true}\r\n')), [{ ok: true }]);
    // The remaining CR is passed unchanged; JSON permits CR as trailing whitespace.
    assert.deepStrictEqual(parser.push(utf8.encode('{"ok":true}\r\r\n')), [{ ok: true }]);
    parser.finish();
  });

  it("treats Unicode line separators as JSON content rather than framing", () => {
    const parser = new PrimeRpcJsonlParser();
    assert.deepStrictEqual(parser.push(utf8.encode('{"text":"a b c"}\n')), [{ text: "a b c" }]);
    parser.finish();
  });

  it("makes invalid UTF-8 and JSON terminal without retaining record data", () => {
    const invalidUtf8 = new PrimeRpcJsonlParser();
    framingError(() => invalidUtf8.push(Uint8Array.of(0xff, 0x0a)), "invalid-utf8");
    assert.throws(() => invalidUtf8.push(utf8.encode('{"ok":true}\n')));
    invalidUtf8.finish();

    const invalidJson = new PrimeRpcJsonlParser();
    framingError(() => invalidJson.push(utf8.encode('{bad}\n{"ok":true}\n')), "invalid-json");
    assert.throws(() => invalidJson.push(utf8.encode('{"ok":true}\n')));
    invalidJson.finish();
  });

  it("caps total buffered bytes because it retains only the current record", () => {
    const parser = new PrimeRpcJsonlParser({ maxRecordBytes: 4 });
    assert.deepStrictEqual(parser.push(utf8.encode("12")), []);
    assert.deepStrictEqual(parser.push(utf8.encode("34")), []);
    framingError(() => parser.push(utf8.encode("5")), "record-too-large");
    assert.throws(() => parser.push(utf8.encode("\n")));
    parser.finish();
  });

  it("accepts a record at the exact configured byte limit", () => {
    const parser = new PrimeRpcJsonlParser({ maxRecordBytes: 2 });
    assert.deepStrictEqual(parser.push(utf8.encode("[]\n")), [[]]);
    parser.finish();
  });

  it("rejects empty lines and partial EOF fragments", () => {
    framingError(() => new PrimeRpcJsonlParser().push(utf8.encode("\n")), "invalid-json");
    const parser = new PrimeRpcJsonlParser();
    assert.deepStrictEqual(parser.push(utf8.encode('{"partial":true}')), []);
    framingError(() => parser.finish(), "eof-fragment");
    parser.finish(); // terminal finish is idempotent
    const complete = new PrimeRpcJsonlParser();
    complete.finish(); // successful finish is idempotent
    complete.finish();
  });
});

describe("encodePrimeRpcJsonlRecord", () => {
  it("writes exactly one atomic LF-terminated UTF-8 JSON record", () => {
    const bytes = encodePrimeRpcJsonlRecord({ text: "a b c" });
    assert.strictEqual(text.decode(bytes), '{"text":"a b c"}\n');
    assert.strictEqual(bytes.filter((byte) => byte === 0x0a).length, 1);
  });

  it("enforces the UTF-8 payload cap (excluding the LF)", () => {
    assert.strictEqual(text.decode(encodePrimeRpcJsonlRecord("é", { maxRecordBytes: 4 })), '"é"\n');
    framingError(() => encodePrimeRpcJsonlRecord("é", { maxRecordBytes: 3 }), "record-too-large");
  });

  it("rejects values JSON cannot represent as a record", () => {
    framingError(() => encodePrimeRpcJsonlRecord(undefined), "writer-value");
    const circular: { self?: unknown } = {};
    circular.self = circular;
    framingError(() => encodePrimeRpcJsonlRecord(circular), "writer-value");
  });
});
