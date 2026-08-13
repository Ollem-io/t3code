import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupPrimeOwnership, writePrimeOwnership } from "./PrimeOwnership.ts";
import { primeResourceLayout } from "./PrimeResourceLayout.ts";

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message); }
const homeA = await mkdtemp(join(tmpdir(), "t3-prime-artifact-a-"));
const homeB = await mkdtemp(join(tmpdir(), "t3-prime-artifact-b-"));
const one = primeResourceLayout({ home: homeA, environmentId: "env", instanceId: "one", threadId: "thread" });
const two = primeResourceLayout({ home: homeB, environmentId: "env", instanceId: "two", threadId: "thread" });
check(one.ownership !== two.ownership, "homes must not share ownership paths");
const ownership = (instanceId: string, pid: number) => ({ version: 1 as const, environmentId: "env", instanceId, threadIds: ["thread"], process: { pid, startToken: "start" } });
await writePrimeOwnership(one.ownership, ownership("one", 1));
await writePrimeOwnership(two.ownership, ownership("two", 2));
const sentinel = join(homeA, "unrelated-prime-sentinel"); await writeFile(sentinel, "untouched");
const stopped: number[] = [];
await cleanupPrimeOwnership(one.ownership, { processMatches: async ({ pid }) => pid === 1 }, async ({ pid }) => { stopped.push(pid); });
check(stopped.join() === "1", "only selected captured process may stop");
check(await readFile(two.ownership, "utf8"), "other home ownership must remain");
check(await readFile(sentinel, "utf8") === "untouched", "unrelated sentinel must remain");
await stat(two.ownership);
console.log("Prime ownership review artifact passed");
