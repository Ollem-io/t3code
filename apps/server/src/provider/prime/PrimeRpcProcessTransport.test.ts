import { assert, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import { PrimeRpcClient } from "./PrimeRpcClient.ts";
import { spawnPrimeRpcTransport } from "./PrimeRpcProcessTransport.ts";

const fixture = fileURLToPath(
  new URL("../../../integration/fixtures/prime-rpc/fake-prime-agent.mjs", import.meta.url),
);

describe("PrimeRpcProcessTransport", () => {
  it("fails closed without silently dropping when its bounded event queue is unread", async () => {
    const client = new PrimeRpcClient(
      spawnPrimeRpcTransport(process.execPath, [fixture, "--mode", "rpc", "--adversarial"]),
      { requestIdPrefix: "process", maxQueuedEvents: 1 },
    );
    const reason = async (request: Promise<unknown>) => {
      try {
        await request;
        return "resolved";
      } catch (error) {
        return error instanceof Error && "reason" in error ? error.reason : "unknown";
      }
    };
    const outcomes = await Promise.all([
      reason(client.command({ type: "get_state" })),
      reason(client.command({ type: "get_state" })),
    ]);
    assert.deepStrictEqual(outcomes, ["resolved", "protocol"]);
    assert.strictEqual(client.diagnostics().droppedEvents, 1);
    assert.strictEqual(client.diagnostics().closed, true);
    client.close();
  });
});

it("turns a real child stdin failure into terminal client write failure", async () => {
  const client = new PrimeRpcClient(
    spawnPrimeRpcTransport(process.execPath, [
      fixture,
      "--mode",
      "rpc",
      "--scenario",
      "write-failure",
    ]),
    { requestIdPrefix: "broken" },
  );
  const events = client.events();
  await events.next();
  const reason = async (request: Promise<unknown>) => {
    try {
      await request;
      return "resolved";
    } catch (error) {
      return error instanceof Error && "reason" in error ? error.reason : "unknown";
    }
  };
  const first = reason(client.command({ type: "get_state" }));
  const second = reason(client.command({ type: "abort" }));
  assert.deepStrictEqual(await Promise.all([first, second]), ["write", "write"]);
  assert.strictEqual(await reason(client.command({ type: "get_state" })), "write");
  assert.strictEqual(client.diagnostics().pendingRequests, 0);
});
