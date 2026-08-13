import { assert, describe, it } from "@effect/vitest";
import { PrimeRpcClient, PrimeRpcClientError, type PrimeRpcTransport } from "./PrimeRpcClient.ts";

const utf8 = new TextEncoder();
class Channel implements AsyncIterable<Uint8Array> {
  #values: Uint8Array[] = [];
  #waiters: Array<(value: IteratorResult<Uint8Array>) => void> = [];
  #done = false;
  push(value: string | Uint8Array) {
    const bytes = typeof value === "string" ? utf8.encode(value) : value;
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value: bytes, done: false });
    else this.#values.push(bytes);
  }
  end() {
    this.#done = true;
    for (const waiter of this.#waiters.splice(0)) waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.#done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

function fixture() {
  const stdout = new Channel();
  const stderr = new Channel();
  const exit = deferred<number | null>();
  const writes: string[] = [];
  const transport: PrimeRpcTransport = {
    stdout,
    stderr,
    exited: exit.promise,
    write: async (record) => {
      writes.push(new TextDecoder().decode(record));
    },
  };
  return {
    client: new PrimeRpcClient(transport, {
      requestIdPrefix: "test",
      maxQueuedEvents: 2,
      maxStderrBytes: 4,
    }),
    stdout,
    stderr,
    exit,
    writes,
  };
}
const rejection = async (promise: Promise<unknown>, reason: PrimeRpcClientError["reason"]) => {
  try {
    await promise;
    return assert.fail("Expected rejection");
  } catch (error) {
    assert.instanceOf(error, PrimeRpcClientError);
    assert.strictEqual(error.reason, reason);
    return error;
  }
};

describe("PrimeRpcClient", () => {
  it("correlates interleaved chunked responses while asynchronously delivering events", async () => {
    const { client, stdout, writes } = fixture();
    const first = client.command({ type: "get_state" });
    const second = client.command({ type: "abort" });
    await flush();
    assert.deepStrictEqual(
      writes.map((line) => JSON.parse(line).id),
      ["test-1", "test-2"],
    );
    // Exercise records split across arbitrary process stdout chunks.
    stdout.push('{"type":"agent_start"}\n{"id":"test-2","type":"res');
    stdout.push('ponse","command":"abort","success":true}\n{"type":"turn_start"}\n');
    stdout.push('{"id":"test-1","type":"response","command":"get_state","success":true}\n');
    assert.strictEqual((await second).command, "abort");
    assert.strictEqual((await first).command, "get_state");
    const events = client.events();
    assert.strictEqual((await events.next()).value?._tag, "known-event");
    assert.strictEqual((await events.next()).value?._tag, "known-event");
  });

  it("settles each request once across timeout, cancellation, mismatch, late and duplicate responses", async () => {
    const { client, stdout } = fixture();
    await rejection(client.command({ type: "get_state" }, { timeoutMs: 10 }), "timeout");
    const controller = new AbortController();
    const aborted = client.command({ type: "abort" }, { signal: controller.signal });
    controller.abort();
    await rejection(aborted, "aborted");
    const mismatch = client.command({ type: "get_state" });
    await flush();
    stdout.push('{"id":"test-3","type":"response","command":"abort","success":true}\n');
    await rejection(mismatch, "response-command");
    // Responses for timed-out/cancelled/mismatched ids are diagnostics, never a second settlement.
    stdout.push(
      '{"id":"test-1","type":"response","command":"get_state","success":true}\n{"id":"test-2","type":"response","command":"abort","success":true}\n{"id":"test-3","type":"response","command":"get_state","success":true}\n',
    );
    await flush();
    assert.strictEqual(client.diagnostics().duplicateResponses, 3);
  });

  it("fans out EOF and child exit, bounds stderr, and never lets a slow event consumer stop stdout", async () => {
    const { client, stdout, stderr, exit } = fixture();
    const exitPending = client.command({ type: "get_state" });
    const eofPending = client.command({ type: "abort" });
    stderr.push("abcdef");
    stderr.end();
    stdout.push(
      '{"type":"agent_start"}\n{"type":"turn_start"}\n{"type":"message_start","message":{}}\n',
    );
    exit.resolve(17);
    await rejection(exitPending, "exit");
    await rejection(eofPending, "exit");
    await flush();
    assert.deepStrictEqual(client.diagnostics(), {
      pendingRequests: 0,
      closed: true,
      stderrBytes: 4,
      stderrTruncated: true,
      droppedEvents: 1,
      duplicateResponses: 0,
    });
    const { client: eofClient, stdout: eofStdout } = fixture();
    const pending = eofClient.command({ type: "get_state" });
    eofStdout.end();
    await rejection(pending, "eof");
  });
  it("fails all pending requests on malformed envelopes or a response without an id", async () => {
    const { client, stdout } = fixture();
    const pending = client.command({ type: "get_state" });
    stdout.push('{"type":"response","command":"get_state","success":true}\n');
    await rejection(pending, "protocol");
    const second = client.command({ type: "abort" });
    await rejection(second, "protocol");
    const { client: malformedClient, stdout: malformedStdout } = fixture();
    const malformed = malformedClient.command({ type: "get_state" });
    malformedStdout.push('{"type":"response","id":3}\n');
    await rejection(malformed, "protocol");
  });

  it("uses the configured record cap in both directions and detaches cancelled event readers", async () => {
    const stdout = new Channel();
    const stderr = new Channel();
    const exit = deferred<number | null>();
    const client = new PrimeRpcClient(
      { stdout, stderr, exited: exit.promise, write: async () => undefined },
      { maxRecordBytes: 50, requestIdPrefix: "cap" },
    );
    await rejection(client.command({ type: "prompt", message: "this cannot fit" }), "write");
    const events = client.events();
    const waiting = events.next();
    await events.return?.();
    stdout.push('{"type":"agent_start"}\n');
    await flush();
    // The cancelled waiter cannot steal this event from a later subscriber.
    const later = client.events();
    assert.strictEqual((await later.next()).value?._tag, "known-event");
    void waiting;
    const inbound = client.command({ type: "get_state" });
    stdout.push(`{"type":"x","padding":"${"x".repeat(130)}"}\n`);
    await rejection(inbound, "framing");
  });

  it("closes the owned transport exactly once and rejects a second live event subscription", async () => {
    const stdout = new Channel();
    const stderr = new Channel();
    const exit = deferred<number | null>();
    let closes = 0;
    const client = new PrimeRpcClient({
      stdout,
      stderr,
      exited: exit.promise,
      write: async () => undefined,
      close: () => {
        closes += 1;
      },
    });
    const events = client.events();
    assert.throws(() => client.events(), PrimeRpcClientError);
    stdout.push('{"type":"agent_start"}\n');
    assert.strictEqual((await events.next()).done, false);
    // Resolving next() does not release the iterator's lifetime subscription.
    assert.throws(() => client.events(), PrimeRpcClientError);
    stdout.push('{"type":"turn_start"}\n');
    await flush();
    client.close();
    client.close();
    assert.strictEqual(closes, 1);
    assert.strictEqual((await events.next()).done, false);
    assert.strictEqual((await events.next()).done, true);
  });

  it("lets an iterator created after close drain buffered events before completion", async () => {
    const { client, stdout } = fixture();
    stdout.push('{"type":"agent_start"}\n{"type":"turn_start"}\n');
    await flush();
    client.close();
    const events = client.events();
    assert.strictEqual((await events.next()).done, false);
    assert.strictEqual((await events.next()).done, false);
    assert.strictEqual((await events.next()).done, true);
  });

  it("skips queued requests cancelled before write and treats first write failure as terminal", async () => {
    const stdout = new Channel();
    const stderr = new Channel();
    const exit = deferred<number | null>();
    const firstWrite = deferred<void>();
    const writes: string[] = [];
    let closes = 0;
    const client = new PrimeRpcClient(
      {
        stdout,
        stderr,
        exited: exit.promise,
        write: async (record) => {
          const line = new TextDecoder().decode(record);
          writes.push(line);
          if (writes.length === 1) await firstWrite.promise;
          else throw new Error("controlled write failure");
        },
        close: () => {
          closes += 1;
        },
      },
      { requestIdPrefix: "queue" },
    );
    const first = client.command({ type: "get_state" });
    const controller = new AbortController();
    const cancelled = client.command({ type: "abort" }, { signal: controller.signal });
    const failing = client.command({ type: "get_state" });
    const gated = client.command({ type: "abort" });
    controller.abort();
    await rejection(cancelled, "aborted");
    firstWrite.resolve();
    await rejection(failing, "write");
    await rejection(first, "write");
    await rejection(gated, "write");
    assert.deepStrictEqual(
      writes.map((line) => JSON.parse(line).id),
      ["queue-1", "queue-3"],
    );
    assert.strictEqual(closes, 1);
    assert.strictEqual(client.diagnostics().pendingRequests, 0);
  });

  it("records a response arriving after abort once without resettling", async () => {
    const { client, stdout } = fixture();
    const controller = new AbortController();
    let rejects = 0;
    let resolves = 0;
    const request = client.command({ type: "get_state" }, { signal: controller.signal }).then(
      () => {
        resolves += 1;
      },
      (error) => {
        rejects += 1;
        throw error;
      },
    );
    controller.abort();
    await rejection(request, "aborted");
    stdout.push('{"id":"test-1","type":"response","command":"get_state","success":true}\n');
    await flush();
    assert.deepStrictEqual(
      { resolves, rejects, duplicates: client.diagnostics().duplicateResponses },
      { resolves: 0, rejects: 1, duplicates: 1 },
    );
  });
});
