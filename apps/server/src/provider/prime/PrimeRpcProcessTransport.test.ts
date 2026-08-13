import { assert, describe, it } from "@effect/vitest";
import { fileURLToPath } from "node:url";
import { PrimeRpcClient } from "./PrimeRpcClient.ts";
import { spawnPrimeRpcTransport } from "./PrimeRpcProcessTransport.ts";

const fixture = fileURLToPath(new URL("../../../integration/fixtures/prime-rpc/fake-prime-agent.mjs", import.meta.url));

describe("PrimeRpcProcessTransport", () => {
  it("drains adversarial child stdout while its bounded event queue is unread", async () => {
    const client = new PrimeRpcClient(
      spawnPrimeRpcTransport(process.execPath, [fixture, "--mode", "rpc", "--adversarial"]),
      { requestIdPrefix: "process", maxQueuedEvents: 1 },
    );
    const first = client.command({ type: "get_state" });
    const second = client.command({ type: "get_state" });
    assert.strictEqual((await first).id, "process-1");
    assert.strictEqual((await second).id, "process-2");
    assert.strictEqual(client.diagnostics().droppedEvents, 1);
    client.close();
  });
});
