import { assert, describe, it } from "@effect/vitest";

import {
  encodePrimeRpcJsonlRecord,
  PrimeRpcFramingError,
  PrimeRpcJsonlParser,
} from "./PrimeRpcFraming.ts";

const utf8 = new TextEncoder();
const text = new TextDecoder();
const push = (parser: PrimeRpcJsonlParser, bytes: Uint8Array): Array<unknown> => {
  const values: Array<unknown> = [];
  parser.push(bytes, (value) => values.push(value));
  return values;
};
const framingError = (run: () => unknown, reason: PrimeRpcFramingError["reason"]) => {
  assert.throws(run, (error: unknown) =>
    error instanceof PrimeRpcFramingError && error.reason === reason,
  );
};

describe("PrimeRpcJsonlParser", () => {
  it("parses single and multiple LF-delimited records", () => {
    const parser = new PrimeRpcJsonlParser();
    assert.deepStrictEqual(push(parser, utf8.encode('{"one":1}\n{"two":2}\n')), [{ one: 1 }, { two: 2 }]);
    parser.finish();
  });

  it("handles arbitrary chunk partitions including UTF-8 boundaries", () => {
    const bytes = utf8.encode('{"message":"🦀 café"}\n');
    for (let first = 0; first <= bytes.length; first += 1) {
      for (let second = first; second <= bytes.length; second += 1) {
        const parser = new PrimeRpcJsonlParser();
        const values: Array<unknown> = [];
        parser.push(bytes.subarray(0, first), (value) => values.push(value));
        parser.push(bytes.subarray(first, second), (value) => values.push(value));
        parser.push(bytes.subarray(second), (value) => values.push(value));
        assert.deepStrictEqual(values, [{ message: "🦀 café" }]);
        parser.finish();
      }
    }
  });

  it("accepts CRLF, strips only one CR, and treats Unicode separators as data", () => {
    const parser = new PrimeRpcJsonlParser();
    assert.deepStrictEqual(push(parser, utf8.encode('{"ok":true}\r\n')), [{ ok: true }]);
    assert.deepStrictEqual(push(parser, utf8.encode('{"ok":true}\r\r\n')), [{ ok: true }]);
    assert.deepStrictEqual(push(parser, utf8.encode('{"text":"a b c"}\n')), [{ text: "a b c" }]);
    parser.finish();
  });

  it("emits prior records before invalid JSON, invalid UTF-8, or oversize failures", () => {
    const cases: Array<[Uint8Array, PrimeRpcFramingError["reason"], number?]> = [
      [utf8.encode('{"ok":1}\n{bad}\n{"later":2}\n'), "invalid-json"],
      [Uint8Array.from([...utf8.encode('{"ok":1}\n'), 0xff, 0x0a, ...utf8.encode('{"later":2}\n')]), "invalid-utf8"],
      [utf8.encode('0\n12345\n2\n'), "record-too-large", 4],
    ];
    for (const [bytes, reason, maxRecordBytes] of cases) {
      const parser = new PrimeRpcJsonlParser(maxRecordBytes ? { maxRecordBytes } : {});
      const values: Array<unknown> = [];
      framingError(() => parser.push(bytes, (value) => values.push(value)), reason);
      assert.deepStrictEqual(values, reason === "record-too-large" ? [0] : [{ ok: 1 }]);
      assert.throws(() => parser.push(utf8.encode('3\n'), (value) => values.push(value)));
      assert.strictEqual(values.length, 1);
      parser.finish();
    }
  });

  it("makes a throwing consumer terminal without retaining or continuing", () => {
    const parser = new PrimeRpcJsonlParser();
    const consumerError = new Error("consumer stopped");
    assert.throws(() => parser.push(utf8.encode('1\n2\n'), () => { throw consumerError; }), (error) => error === consumerError);
    assert.throws(() => parser.push(utf8.encode('3\n'), () => undefined));
    parser.finish();
  });

  it("caps the total buffer across many small fragments", () => {
    const parser = new PrimeRpcJsonlParser({ maxRecordBytes: 64 });
    for (let index = 0; index < 64; index += 1) parser.push(Uint8Array.of(0x20), () => undefined);
    framingError(() => parser.push(Uint8Array.of(0x20), () => undefined), "record-too-large");
    assert.throws(() => parser.push(Uint8Array.of(0x0a), () => undefined));
    parser.finish();
  });

  it("accepts exact cap and rejects empty lines and partial EOF", () => {
    const exact = new PrimeRpcJsonlParser({ maxRecordBytes: 2 });
    assert.deepStrictEqual(push(exact, utf8.encode('[]\n')), [[]]); exact.finish();
    framingError(() => push(new PrimeRpcJsonlParser(), utf8.encode('\n')), "invalid-json");
    const partial = new PrimeRpcJsonlParser(); push(partial, utf8.encode('{"partial":true}'));
    framingError(() => partial.finish(), "eof-fragment"); partial.finish();
    const done = new PrimeRpcJsonlParser(); done.finish(); done.finish();
  });
});

describe("encodePrimeRpcJsonlRecord", () => {
  it("writes exactly one LF-terminated UTF-8 record and enforces its payload cap", () => {
    const bytes = encodePrimeRpcJsonlRecord({ text: "a b c" });
    assert.strictEqual(text.decode(bytes), '{"text":"a b c"}\n');
    assert.strictEqual(bytes.filter((byte) => byte === 0x0a).length, 1);
    assert.strictEqual(text.decode(encodePrimeRpcJsonlRecord("é", { maxRecordBytes: 4 })), '"é"\n');
    framingError(() => encodePrimeRpcJsonlRecord("é", { maxRecordBytes: 3 }), "record-too-large");
  });

  it("rejects values JSON cannot represent", () => {
    framingError(() => encodePrimeRpcJsonlRecord(undefined), "writer-value");
    const circular: { self?: unknown } = {}; circular.self = circular;
    framingError(() => encodePrimeRpcJsonlRecord(circular), "writer-value");
  });
});
