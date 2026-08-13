// @effect-diagnostics nodeBuiltinImport:off
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
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
  let closed = false;
  let exitSettled = false;
  let settleExit!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => {
    settleExit = resolve;
  });
  const finishExit = (code: number | null) => {
    if (exitSettled) return;
    exitSettled = true;
    child.off("error", onChildError);
    child.off("exit", onExit);
    settleExit(code);
  };
  const onChildError = () => finishExit(null);
  const onExit = (code: number | null) => finishExit(code);
  child.once("error", onChildError);
  child.once("exit", onExit);

  // Stream errors are also surfaced to async iterators/write receipts. Keeping
  // listeners attached guarantees destroy/error races cannot become unhandled.
  const consumeStreamError = () => undefined;
  child.stdin.on("error", consumeStreamError);
  child.stdout.on("error", consumeStreamError);
  child.stderr.on("error", consumeStreamError);

  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited,
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
      if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
    },
  };
};
