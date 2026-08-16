// @effect-diagnostics globalDateInEffect:off
import { readFile } from "node:fs/promises";
import { platform } from "node:os";
import { kill } from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import type { PrimeProcessHandle } from "./PrimeOwnership.ts";

/** Linux-only process incarnation proof. Any ambiguity is deliberately false. */
export const readPrimeProcessStartToken = async (pid: number): Promise<string | undefined> => {
  if (platform() !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    // comm is parenthesized and may itself contain spaces or ')'; use its final ')'.
    const close = text.lastIndexOf(")");
    if (close < 0) return undefined;
    const fields = text.slice(close + 1).trim().split(/\s+/);
    // fields starts at stat field 3 (state), starttime is field 22 => index 19.
    const token = fields[19];
    return token && /^\d+$/.test(token) ? token : undefined;
  } catch { return undefined; }
};

export const provePrimeProcess = async (handle: PrimeProcessHandle): Promise<boolean> => {
  const token = await readPrimeProcessStartToken(handle.pid);
  return token !== undefined && token === handle.startToken;
};

/** Stop only the proven incarnation. Rechecks before every signal and escalation. */
export const stopProvenPrimeProcess = async (
  handle: PrimeProcessHandle,
  options: { readonly pollMs?: number; readonly timeoutMs?: number } = {},
): Promise<boolean> => {
  if (!(await provePrimeProcess(handle))) return false;
  const pollMs = Math.max(5, options.pollMs ?? 25);
  const timeoutMs = Math.max(pollMs, options.timeoutMs ?? 1_000);
  const signalIfSame = async (signal: NodeJS.Signals) => {
    const token = await readPrimeProcessStartToken(handle.pid);
    if (token !== handle.startToken) return false;
    try { kill(handle.pid, signal); return true; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return code === "ESRCH" ? false : (() => { throw e; })();
    }
  };
  if (!(await signalIfSame("SIGTERM"))) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(pollMs);
    const token = await readPrimeProcessStartToken(handle.pid);
    if (token === undefined) return true;
    if (token !== handle.startToken) return false;
  }
  // Never escalate after an incarnation change or unreadable / ambiguous stat.
  return await signalIfSame("SIGKILL");
};
