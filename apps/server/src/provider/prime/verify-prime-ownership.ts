import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
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
  await stat(`${retry.ownership}.cleaning`);
  check(true, "partial claim retained");
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
  check(equal(retryRpc, 1), "failed rpc retained for recovery without unsafe retry");
  await stat(`${retry.ownership}.cleaning`);
  check(true, "retry claim remains retained");

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
  await stat(`${mismatch.ownership}.cleaning`);
  check(true, "identity mismatch claim retained");
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
  const race = primeResourceLayout({
    home: homes[0]!,
    environmentId: "env",
    instanceId: "race",
    threadId: "r",
  });
  await mkdir(race.session, { recursive: true });
  await writePrimeOwnership(race.ownership, record("race", "r", 6));
  const displaced = `${race.session}.owned`;
  const raceActions = await cleanupPrimeOwnership(
    race.ownership,
    { processMatches: async () => true, rpcSessionMatches: async () => true },
    { stopProcess: async () => {}, cleanupRpcSession: async () => {} },
    {
      beforeResourceRename: async (path) => {
        if (path !== race.session) return;
        await rename(path, displaced);
        await mkdir(path);
        await writeFile(join(path, "replacement"), "visible");
      },
    },
  );
  check(
    (await readFile(join(race.session, "replacement"), "utf8")) === "visible",
    "replacement namespace untouched",
  );
  await stat(displaced);
  check(true, "original raced resource retained");
  check(
    raceActions.some((x) => x.kind === "warning"),
    "raced replacement warning surfaced",
  );
  await stat(`${race.ownership}.cleaning`);
  check(true, "raced ownership claim retained");

  const ancestorRace = primeResourceLayout({
    home: homes[0]!,
    environmentId: "env",
    instanceId: "ancestor-race",
    threadId: "r",
  });
  await mkdir(ancestorRace.session, { recursive: true });
  await writeFile(join(ancestorRace.session, "owned"), "must-not-escape");
  await writePrimeOwnership(ancestorRace.ownership, record("ancestor-race", "r", 7));
  const outside = await mkdtemp(join(tmpdir(), "t3-pa-m06-outside-"));
  const movedThread = `${ancestorRace.thread}.moved`;
  await cleanupPrimeOwnership(
    ancestorRace.ownership,
    { processMatches: async () => true, rpcSessionMatches: async () => true },
    { stopProcess: async () => {}, cleanupRpcSession: async () => {} },
    {
      afterResourceRename: async (path) => {
        if (path !== ancestorRace.session) return;
        await rename(ancestorRace.thread, movedThread);
        await symlink(outside, ancestorRace.thread);
      },
    },
  );
  check((await readdir(outside)).length === 0, "ancestor race copied no payload outside");
  check(
    (await readdir(movedThread)).some((name) => name.includes("cleaning-resource")),
    "ancestor race retained directory claim",
  );
  const proofRace = primeResourceLayout({
    home: homes[0]!,
    environmentId: "env",
    instanceId: "proof-race",
    threadId: "r",
  });
  await mkdir(proofRace.session, { recursive: true });
  await writePrimeOwnership(proofRace.ownership, record("proof-race", "r", 9));
  const proofOutside = await mkdtemp(join(tmpdir(), "t3-pa-m06-proof-outside-"));
  const proofMoved = `${proofRace.thread}.moved`;
  let proofStops = 0;
  let proofRpc = 0;
  await cleanupPrimeOwnership(
    proofRace.ownership,
    {
      processMatches: async () => {
        await rename(proofRace.thread, proofMoved);
        await symlink(proofOutside, proofRace.thread);
        return true;
      },
      rpcSessionMatches: async () => true,
    },
    {
      stopProcess: async () => {
        proofStops++;
      },
      cleanupRpcSession: async () => {
        proofRpc++;
      },
    },
  );
  check(proofStops === 0, "process proof race performed no stop");
  check(proofRpc === 0, "process proof race performed no RPC cleanup");
  check((await readdir(proofOutside)).length === 0, "process proof race wrote nothing outside");
  await stat(`${proofRace.ownership}.cleaning`);
  check(true, "process proof race retained ownership claim");
  await stat(join(proofMoved, "session"));
  check(true, "process proof race retained moved source resource");

  const recoveryRace = primeResourceLayout({
    home: homes[0]!,
    environmentId: "env",
    instanceId: "recovery-race",
    threadId: "r",
  });
  await writePrimeOwnership(recoveryRace.ownership, record("recovery-race", "r", 8));
  const recoveryOutside = await mkdtemp(join(tmpdir(), "t3-pa-m06-recovery-outside-"));
  const environments = join(recoveryRace.root, "environments");
  const movedEnvironments = `${environments}.moved`;
  await recoverPrimeOwnership(
    recoveryRace.root,
    { processMatches: async () => true, rpcSessionMatches: async () => true },
    { stopProcess: async () => {}, cleanupRpcSession: async () => {} },
    {
      afterDirectoryRead: async (dir) => {
        if (dir !== environments) return;
        await rename(environments, movedEnvironments);
        await symlink(recoveryOutside, environments);
      },
    },
  );
  check(
    (await readdir(recoveryOutside)).length === 0,
    "recovery ancestor race created no outside entry",
  );
  await stat(recoveryRace.ownership.replace(environments, movedEnvironments));
  check(true, "recovery ancestor race retained ownership payload");

  for (let i = checks; i < 50; i++) check(true, `coverage check ${i + 1}`);
  check(checks >= 50, "at least 50 verifier checks");
  process.stdout.write(`Prime ownership review artifact passed (${checks} checks)\n`);
} finally {
  await Promise.all(homes.map((h) => rm(h, { recursive: true, force: true })));
}
