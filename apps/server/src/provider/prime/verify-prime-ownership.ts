import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupPrimeOwnership,
  recoverPrimeOwnership,
  writePrimeOwnership,
} from "./PrimeOwnership.ts";
import { primeResourceLayout } from "./PrimeResourceLayout.ts";
const check = (v: unknown, m: string): asserts v => {
  if (!v) throw Error(m);
};
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
  await stat(sibling.ownership);
  await stat(other.ownership);
  check((await readFile(sentinel, "utf8")) === "safe", "sentinel changed");
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
  process.stdout.write("Prime ownership review artifact passed\n");
} finally {
  await Promise.all(homes.map((h) => rm(h, { recursive: true, force: true })));
}
