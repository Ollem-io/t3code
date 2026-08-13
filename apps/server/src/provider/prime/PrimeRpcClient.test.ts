import { assert, describe, it } from "@effect/vitest";
import { PrimeRpcClient, PrimeRpcClientError, type PrimeRpcTransport } from "./PrimeRpcClient.ts";

const utf8 = new TextEncoder();
class Channel implements AsyncIterable<Uint8Array> {
  #values: Uint8Array[] = [];
  #waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  #done = false;
  push(value: string | Uint8Array) { const bytes = typeof value === "string" ? utf8.encode(value) : value; const waiter = this.#waiters.shift(); if (waiter) waiter({ value: bytes, done: false }); else this.#values.push(bytes); }
  end() { this.#done = true; for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true }); }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> { return { next: () => { const value = this.#values.shift(); if (value) return Promise.resolve({ value, done: false }); if (this.#done) return Promise.resolve({ value: undefined, done: true }); return new Promise((resolve) => this.#waiters.push(resolve)); } }; }
}
const deferred = <A>() => { let resolve!: (value: A) => void; const promise = new Promise<A>((r) => { resolve = r; }); return { promise, resolve }; };
const flush = () => new Promise<void>((resolve) => queueMicrotask(resolve));

function fixture() {
  const stdout = new Channel(); const stderr = new Channel(); const exit = deferred<number | null>(); const writes: string[] = [];
  const transport: PrimeRpcTransport = { stdout, stderr, exited: exit.promise, write: async (record) => { writes.push(new TextDecoder().decode(record)); } };
  return { client: new PrimeRpcClient(transport, { requestIdPrefix: "test", maxQueuedEvents: 2, maxStderrBytes: 4 }), stdout, stderr, exit, writes };
}
const rejection = async (promise: Promise<unknown>, reason: PrimeRpcClientError["reason"]) => {
  try { await promise; return assert.fail("Expected rejection"); } catch (error) { assert.instanceOf(error, PrimeRpcClientError); assert.strictEqual(error.reason, reason); return error; }
};

describe("PrimeRpcClient", () => {
  it("correlates interleaved chunked responses while asynchronously delivering events", async () => {
    const { client, stdout, writes } = fixture();
    const first = client.command({ type: "get_state" });
    const second = client.command({ type: "abort" });
    await flush(); assert.deepStrictEqual(writes.map((line) => JSON.parse(line).id), ["test-1", "test-2"]);
    // Exercise records split across arbitrary process stdout chunks.
    stdout.push('{"type":"agent_start"}\n{"id":"test-2","type":"res');
    stdout.push('ponse","command":"abort","success":true}\n{"type":"turn_start"}\n');
    stdout.push('{"id":"test-1","type":"response","command":"get_state","success":true}\n');
    assert.strictEqual((await second).command, "abort"); assert.strictEqual((await first).command, "get_state");
    const events = client.events();
    assert.strictEqual((await events.next()).value?._tag, "known-event");
    assert.strictEqual((await events.next()).value?._tag, "known-event");
  });

  it("settles each request once across timeout, cancellation, mismatch, late and duplicate responses", async () => {
    const { client, stdout } = fixture();
    await rejection(client.command({ type: "get_state" }, { timeoutMs: 1 }), "timeout");
    const controller = new AbortController(); const aborted = client.command({ type: "abort" }, { signal: controller.signal }); controller.abort();
    await rejection(aborted, "aborted");
    const mismatch = client.command({ type: "get_state" }); await flush();
    stdout.push('{"id":"test-3","type":"response","command":"abort","success":true}\n');
    await rejection(mismatch, "response-command");
    // Responses for timed-out/cancelled/mismatched ids are diagnostics, never a second settlement.
    stdout.push('{"id":"test-1","type":"response","command":"get_state","success":true}\n{"id":"test-2","type":"response","command":"abort","success":true}\n{"id":"test-3","type":"response","command":"get_state","success":true}\n');
    await flush(); assert.strictEqual(client.diagnostics().duplicateResponses, 3);
  });

  it("fans out EOF and child exit, bounds stderr, and never lets a slow event consumer stop stdout", async () => {
    const { client, stdout, stderr, exit } = fixture();
    const exitPending = client.command({ type: "get_state" }); const eofPending = client.command({ type: "abort" });
    stderr.push("abcdef"); stderr.end();
    stdout.push('{"type":"agent_start"}\n{"type":"turn_start"}\n{"type":"message_start","message":{}}\n');
    exit.resolve(17); await rejection(exitPending, "exit"); await rejection(eofPending, "exit");
    await flush(); assert.deepStrictEqual(client.diagnostics(), { pendingRequests: 0, closed: true, stderr: "abcd", stderrTruncated: true, droppedEvents: 1, duplicateResponses: 0 });
    const { client: eofClient, stdout: eofStdout } = fixture(); const pending = eofClient.command({ type: "get_state" }); eofStdout.end(); await rejection(pending, "eof");
  });
});
