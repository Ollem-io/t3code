import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import type { PrimeRpcTransport } from "./PrimeRpcClient.ts";

/** Adapts an already-approved executable invocation to the client transport.
 * Spawn policy, executable discovery, and canonical event mapping remain outside PA-M03.
 */
export const spawnPrimeRpcTransport = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio = {},
): PrimeRpcTransport => {
  const child: ChildProcessWithoutNullStreams = spawn(command, [...args], { ...options, stdio: "pipe" });
  let closed = false;
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    exited: new Promise((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(null));
    }),
    write: (record) => new Promise<void>((resolve, reject) => {
      if (closed || child.stdin.destroyed) { reject(new Error("Prime RPC stdin is closed")); return; }
      const accepted = child.stdin.write(record, (error) => error ? reject(error) : resolve());
      // The callback is the write completion receipt; drain is intentionally not
      // awaited separately because it can occur before this listener is attached.
      void accepted;
    }),
    close: () => {
      if (closed) return;
      closed = true;
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      if (!child.killed) child.kill();
    },
  };
};
