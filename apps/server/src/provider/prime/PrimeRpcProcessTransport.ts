// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// Native timer bounds exact-child SIGKILL escalation at the Node process boundary.
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { clearTimeout, setTimeout } from "node:timers";
import { readFile } from "node:fs/promises";
import type { PrimeRpcTransport } from "./PrimeRpcClient.ts";

/**
 * Adapts an already-approved invocation. Launch policy and executable discovery
 * remain outside PA-M03. Cleanup targets only the exact ChildProcess returned by
 * this spawn; it never searches for or kills processes by pattern.
 */
export const spawnPrimeRpcTransport = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {},
): PrimeRpcTransport => {
  const child: ChildProcessWithoutNullStreams = spawn(command, [...args], {
    ...options,
    stdio: "pipe",
  });
  const identity = { pid: child.pid!, startToken: "" };
  // Linux starttime is a stable incarnation token; absent platforms remain unprovable.
  const readStartToken = async () => {
    try {
      const stat = await readFile(`/proc/${child.pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      return stat.slice(close + 2).trim().split(/\s+/)[19] ?? "";
    } catch { return ""; }
  };
  const tokenPromise = readStartToken().then((token) => { identity.startToken = token; return token; });
  let closed = false;
  let terminalSettled = false;
  let observedExitCode: number | null = null;
  let observedSignal = false;
  let settleTerminal!: (terminal: { kind: "exit"; code: number | null }) => void;
  const terminal = new Promise<{ kind: "exit"; code: number | null }>((resolve) => {
    settleTerminal = resolve;
  });
  const finishTerminal = (code: number | null) => {
    if (terminalSettled) return;
    terminalSettled = true;
    child.off("error", onChildError);
    child.off("exit", onExit);
    child.off("close", onClose);
    settleTerminal({ kind: "exit", code });
  };
  const onChildError = () => finishTerminal(null);
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    observedExitCode = code;
    observedSignal = signal !== null;
  };
  const onClose = (code: number | null, signal: NodeJS.Signals | null) =>
    finishTerminal(code ?? (observedSignal || signal !== null ? null : observedExitCode));
  child.once("error", onChildError);
  child.once("exit", onExit);
  // `close` runs after stdio closes, so stdout EOF can never outrun process
  // termination classification. A live process that closes stdout remains live.
  child.once("close", onClose);

  // Stream errors are also surfaced to async iterators/write receipts. Keeping
  // listeners attached guarantees destroy/error races cannot become unhandled.
  const consumeStreamError = () => undefined;
  child.stdin.on("error", consumeStreamError);
  child.stdout.on("error", consumeStreamError);
  child.stderr.on("error", consumeStreamError);

  return {
    processIdentityReady: tokenPromise.then((token) => token ? { pid: identity.pid, startToken: token } : undefined),
    processIdentity: identity.startToken ? identity : undefined,
    stopExact: async (target) => {
      const token = await tokenPromise;
      if (!token || target.pid !== identity.pid || target.startToken !== token) throw new Error("child identity cannot be proven");
      if (!closed) { closed = true; child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); if (child.exitCode === null && child.signalCode === null) child.kill(); }
    },
    stdout: child.stdout,
    stderr: child.stderr,
    terminal,
    write: (record) =>
      new Promise<void>((resolve, reject) => {
        if (closed || child.stdin.destroyed || !child.stdin.writable) {
          reject(new Error("Prime RPC stdin is closed"));
          return;
        }
        let settled = false;
        const settle = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          child.stdin.off("error", onError);
          error ? reject(error) : resolve();
        };
        const onError = (error: Error) => settle(error);
        child.stdin.once("error", onError);
        try {
          child.stdin.write(record, (error) => settle(error));
        } catch (error) {
          settle(error instanceof Error ? error : new Error("Prime RPC write failed"));
        }
      }),
    close: () => {
      if (closed) return;
      closed = true;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (child.exitCode === null && child.signalCode === null && !child.killed) {
        child.kill();
        const escalation = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 1_000);
        escalation.unref?.();
        void terminal.finally(() => clearTimeout(escalation));
      }
    },
  };
};
