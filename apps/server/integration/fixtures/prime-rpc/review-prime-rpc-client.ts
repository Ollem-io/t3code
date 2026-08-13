#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalConsole:off
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PrimeRpcClient, PrimeRpcClientError } from "../../../src/provider/prime/PrimeRpcClient.ts";
import { spawnPrimeRpcTransport } from "../../../src/provider/prime/PrimeRpcProcessTransport.ts";

const sourceFake = fileURLToPath(new URL("./fake-prime-agent.mjs", import.meta.url));
const checks: string[] = [];
const check = (condition: unknown, label: string) => {
  if (!condition) throw new Error(label);
  checks.push(label);
};
const reject = async (promise: Promise<unknown>, reason: PrimeRpcClientError["reason"]) => {
  try {
    await promise;
    throw new Error(`expected ${reason}`);
  } catch (error) {
    check(error instanceof PrimeRpcClientError && error.reason === reason, `${reason} rejection`);
  }
};
let fake = sourceFake;
const clients: PrimeRpcClient[] = [];
const clientFor = (scenario: string, options = {}) => {
  const client = new PrimeRpcClient(
    spawnPrimeRpcTransport(process.execPath, [fake, "--mode", "rpc", "--scenario", scenario]),
    { requestIdPrefix: scenario.replaceAll("-", "_"), defaultTimeoutMs: 1000, ...options },
  );
  clients.push(client);
  return client;
};

const main = async () => {
  const isolated = await mkdtemp(join(tmpdir(), "pa-m03-artifact-"));
  fake = join(isolated, basename(sourceFake));
  await copyFile(sourceFake, fake);
  try {
    const concurrent = clientFor("reverse-two", { maxQueuedEvents: 1 });
    const first = concurrent.command({ type: "get_state" });
    const second = concurrent.command({ type: "get_state" });
    check(
      (await second).id?.endsWith("-2") && (await first).id?.endsWith("-1"),
      "interleaved concurrent correlation",
    );
    check(concurrent.diagnostics().droppedEvents === 1, "unread consumer does not block responses");

    const duplicate = clientFor("duplicate");
    await duplicate.command({ type: "get_state" });
    await duplicate.command({ type: "abort" });
    check(duplicate.diagnostics().duplicateResponses === 1, "duplicate successful id diagnostic");

    const mismatch = clientFor("mismatch");
    await reject(mismatch.command({ type: "get_state" }), "response-command");

    const late = clientFor("late-after-abort");
    const lateEvents = late.events();
    const controller = new AbortController();
    const cancelled = late.command({ type: "get_state" }, { signal: controller.signal });
    check(!(await lateEvents.next()).done, "late request accepted before abort");
    await lateEvents.return?.();
    controller.abort();
    await reject(cancelled, "aborted");
    await late.command({ type: "abort" });
    check(late.diagnostics().duplicateResponses === 1, "late-after-abort exact once");

    const timeout = clientFor("timeout", { defaultTimeoutMs: 1 });
    let timeoutRejects = 0;
    await reject(
      timeout.command({ type: "get_state" }).catch((error) => {
        timeoutRejects += 1;
        throw error;
      }),
      "timeout",
    );
    check(timeoutRejects === 1, "timeout exact once");

    const exiting = clientFor("exit", { maxStderrBytes: 8 });
    const exitA = exiting.command({ type: "get_state" });
    const exitB = exiting.command({ type: "abort" });
    await Promise.all([reject(exitA, "exit"), reject(exitB, "exit")]);
    check(
      exiting.diagnostics().stderrBytes <= 8 && exiting.diagnostics().stderrTruncated,
      "child exit fanout and bounded redacted stderr",
    );

    const corrupt = clientFor("corrupt");
    await reject(corrupt.command({ type: "get_state" }), "framing");

    const eofTransport = spawnPrimeRpcTransport(process.execPath, [
      fake,
      "--mode",
      "rpc",
      "--scenario",
      "eof-live",
    ]);
    let eofCloses = 0;
    const eof = new PrimeRpcClient(
      {
        ...eofTransport,
        close: () => {
          eofCloses += 1;
          return eofTransport.close?.();
        },
      },
      { requestIdPrefix: "eof" },
    );
    clients.push(eof);
    await reject(eof.command({ type: "get_state" }), "eof");
    eof.close();
    check(eofCloses === 1, "EOF fanout and transport close once");

    const writeFailure = clientFor("write-failure");
    await new Promise<void>(async (resolve) => {
      const events = writeFailure.events();
      for await (const event of events)
        if (event._tag === "unknown-event") {
          await events.return?.();
          resolve();
        }
    });
    const writeA = writeFailure.command({ type: "get_state" });
    const writeB = writeFailure.command({ type: "abort" });
    await Promise.all([reject(writeA, "write"), reject(writeB, "write")]);
    await reject(writeFailure.command({ type: "get_state" }), "write");
    check(writeFailure.diagnostics().pendingRequests === 0, "write failure fail-stop");

    const eventClient = clientFor("events");
    const iterator = eventClient.events();
    await eventClient.command({ type: "get_state" });
    check(
      !(await iterator.next()).done && !(await iterator.next()).done,
      "events delivered before close",
    );
    eventClient.close();
    check((await iterator.next()).done === true, "event close drain and iterator end");

    for (const label of checks) console.log(`PA-M03 ${label}: pass`);
    console.log(`PA-M03 source-derived client/process artifact: pass (${checks.length} checks)`);
  } finally {
    for (const client of clients) client.close();
    await rm(isolated, { recursive: true, force: true });
  }
};
await main().catch((error) => {
  console.error(`PA-M03 artifact: fail: ${error instanceof Error ? error.message : "unknown"}`);
  process.exitCode = 1;
});
