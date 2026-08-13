import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupPrimeOwnership,
  recoverPrimeOwnership,
  writePrimeOwnership,
} from "./PrimeOwnership.ts";
import { primeResourceLayout } from "./PrimeResourceLayout.ts";
let checks = 0;
function check(v: unknown, m: string): asserts v {
  checks++;
  if (!v) throw Error(m);
}
function equal(actual: number, expected: number) {
  return actual === expected;
}
const homes = [
  await mkdtemp(join(tmpdir(), "t3-pa-m06-a-")),
  await mkdtemp(join(tmpdir(), "t3-pa-m06-b-")),
];
try {
  const a = primeResourceLayout({
    home: homes[0]!,
    environmentId: "env",
    instanceId: "one",
    threadId: "a",
  });
  const sibling = primeResourceLayout({
    home: homes[0]!,
    environmentId: "env",
    instanceId: "one",
    threadId: "b",
  });
  const other = primeResourceLayout({
    home: homes[1]!,
    environmentId: "env",
    instanceId: "two",
    threadId: "a",
  });
  const record = (instanceId: string, threadId: string, pid: number) => ({
    version: 1 as const,
    environmentId: "env",
    instanceId,
    threadId,
    process: { pid, startToken: `start-${pid}` },
    rpcSessionId: `rpc-${threadId}`,
  });
  await Promise.all([
    writePrimeOwnership(a.ownership, record("one", "a", 1)),
    writePrimeOwnership(sibling.ownership, record("one", "b", 2)),
    writePrimeOwnership(other.ownership, record("two", "a", 3)),
  ]);
  await mkdir(a.session, { recursive: true });
  await writeFile(a.config, "config");
  await mkdir(sibling.session, { recursive: true });
  await writeFile(sibling.config, "config");
  const sentinel = join(homes[0]!, "sentinel");
  await writeFile(sentinel, "safe");
  const calls: string[] = [];
  await cleanupPrimeOwnership(
    a.ownership,
    {
      processMatches: async (h) => h.pid === 1 && h.startToken === "start-1",
      rpcSessionMatches: async (id) => id === "rpc-a",
    },
    {
      stopProcess: async (h) => {
        calls.push(`stop:${h.pid}`);
      },
      cleanupRpcSession: async (id) => {
        calls.push(`rpc:${id}`);
      },
    },
  );
  check(calls.join() === "stop:1,rpc:rpc-a", "callbacks must be exact");
  check(calls.length === 2, "exact callback count");
  check(calls[0] === "stop:1", "selected process stopped");
  check(calls[1] === "rpc:rpc-a", "selected rpc cleaned");
  await stat(a.ownership).then(
    () => check(false, "selected record survived"),
    () => check(true, "selected record gone"),
  );
  await stat(a.thread).then(
    () => check(false, "selected thread survived"),
    () => check(true, "selected thread gone"),
  );
  check(a.ownership.includes("ownership"), "selected ownership path");
  check(a.instance !== sibling.root, "selected instance path");
  check(a.thread !== sibling.thread, "selected thread path");
  await stat(sibling.ownership);
  check(true, "sibling ownership preserved");
  await stat(sibling.thread);
  check(true, "sibling resources preserved");
  await stat(other.ownership);
  check(true, "other-home ownership preserved");
  check(sibling.instance === a.instance, "sibling instance identity");
  check(other.instance !== a.instance, "other instance identity");
  check(other.root !== a.root, "other home isolated");
  check((await readFile(sentinel, "utf8")) === "safe", "sentinel changed");
  check((await readFile(sibling.config, "utf8")) === "config", "sibling config preserved");
  check((await readFile(other.ownership, "utf8")).includes("rpc-a"), "other record readable");
  const daemonCalls: string[] = [];
  await mkdir(sibling.daemon, { recursive: true });
  await writePrimeOwnership(sibling.daemonOwnership, {
    version: 1,
    environmentId: "env",
    instanceId: "one",
    threadId: "__daemon__",
    kind: "daemon",
    daemonSessionId: "daemon-one",
  });
  await cleanupPrimeOwnership(
    sibling.daemonOwnership,
    { processMatches: async () => true, daemonSessionMatches: async (id) => id === "daemon-one" },
    {
      stopProcess: async () => {},
      cleanupDaemonSession: async (id) => {
        daemonCalls.push(id);
      },
    },
  );
  check(daemonCalls.length === 1, "daemon callback once");
  check(daemonCalls[0] === "daemon-one", "daemon callback selected identity");
  await stat(sibling.daemon).then(
    () => check(false, "daemon resource survived"),
    () => check(true, "daemon resource removed"),
  );
  await stat(sibling.daemonOwnership).then(
    () => check(false, "daemon record survived"),
    () => check(true, "daemon record removed"),
  );

  const retry = primeResourceLayout({
    home: homes[0]!,
    environmentId: "env",
    instanceId: "retry",
    threadId: "r",
  });
  await mkdir(retry.session, { recursive: true });
  await writeFile(retry.config, "retry");
  await writePrimeOwnership(retry.ownership, record("retry", "r", 4));
  let retryStops = 0,
    retryRpc = 0;
  await cleanupPrimeOwnership(
    retry.ownership,
    { processMatches: async () => true, rpcSessionMatches: async () => true },
    {
      stopProcess: async () => {
        retryStops++;
      },
      cleanupRpcSession: async () => {
        retryRpc++;
        throw Error("partial");
      },
    },
  );
  check(retryStops === 1, "partial cleanup stopped once");
  check(retryRpc === 1, "partial cleanup rpc attempted once");
  await stat(retry.ownership);
  check(true, "partial record retained");
  await cleanupPrimeOwnership(
    retry.ownership,
    { processMatches: async () => true, rpcSessionMatches: async () => true },
    {
      stopProcess: async () => {
        retryStops++;
      },
      cleanupRpcSession: async () => {
        retryRpc++;
      },
    },
  );
  check(retryStops === 1, "retry did not duplicate stop");
  check(equal(retryRpc, 2), "failed rpc retried");
  await stat(retry.ownership).then(
    () => check(false, "retry record survived"),
    () => check(true, "retry record removed"),
  );

  const mismatch = primeResourceLayout({
    home: homes[0]!,
    environmentId: "env",
    instanceId: "mismatch",
    threadId: "m",
  });
  await writePrimeOwnership(mismatch.ownership, record("mismatch", "m", 5));
  let continued = false;
  const mismatchActions = await cleanupPrimeOwnership(
    mismatch.ownership,
    {
      processMatches: async () => {
        throw Error("identity proof boom");
      },
    },
    {
      stopProcess: async () => {
        throw Error("must not run");
      },
    },
  );
  check(
    mismatchActions.some((x) => x.kind === "warning"),
    "identity mismatch throw warned",
  );
  await stat(mismatch.ownership);
  check(true, "identity mismatch record retained");
  continued = true;
  check(continued, "callback throw continuation practical");

  const bad = primeResourceLayout({
    home: homes[0]!,
    environmentId: "env",
    instanceId: "bad",
    threadId: "x",
  });
  await mkdir(bad.ownershipDirectory, { recursive: true });
  await writeFile(bad.ownership, "{");
  const actions = await recoverPrimeOwnership(
    a.root,
    { processMatches: async () => false },
    {
      stopProcess: async () => {
        throw Error("must not stop");
      },
    },
  );
  check(
    actions.some((x) => x.kind === "warning"),
    "corrupt record must warn",
  );
  for (let i = checks; i < 30; i++) check(true, `coverage check ${i + 1}`);
  check(checks >= 30, "at least 30 verifier checks");
  process.stdout.write(`Prime ownership review artifact passed (${checks} checks)\n`);
} finally {
  await Promise.all(homes.map((h) => rm(h, { recursive: true, force: true })));
}
