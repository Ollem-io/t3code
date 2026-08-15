#!/usr/bin/env node
/**
 * PA-M16 integration evidence runner. It has no package dependencies and never
 * reads an ambient Prime/T3 home or ambient credential/token variables.
 * Default: isolated installed-binary version + read-only RPC setup probe.
 * --fake: deterministic fixture end-to-end transcript proof.
 * --authenticated: separately permission-gated current-host smoke (never CI).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const secretKeys = /(?:token|secret|key|password|authorization|cookie)/i;
const digest = value => createHash("sha256").update(value).digest("hex");
const redact = value => typeof value === "string" ? `[sha256:${digest(value)}]` : value;
const pathLabel = value => `[path-sha256:${digest(resolve(value))}]`;
const transcript = [];
const record = (kind, value = {}) => transcript.push({ kind, ...Object.fromEntries(Object.entries(value).map(([k, v]) => [k, secretKeys.test(k) || k === "path" ? redact(String(v)) : v])) });
const startToken = async pid => {
  if (platform() !== "linux") return undefined;
  try { const stat = await readFile(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19]; } catch { return undefined; }
};
const cleanEnvironment = home => ({
  PATH: process.env.PATH ?? "", LANG: process.env.LANG ?? "C", LC_ALL: process.env.LC_ALL ?? "C",
  NO_COLOR: "1", HOME: home, XDG_CONFIG_HOME: join(home, "xdg-config"),
  XDG_DATA_HOME: join(home, "xdg-data"), XDG_CACHE_HOME: join(home, "xdg-cache"),
  TMPDIR: join(home, "tmp"), T3CODE_HOME: join(home, "t3-home"),
});
const run = async (command, args, options) => new Promise(resolveRun => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: "pipe" });
  const pid = child.pid;
  const result = { pid, startToken: undefined, code: null, stdout: "", stderr: "", error: undefined };
  void startToken(pid).then(token => { result.startToken = token; });
  child.stdout.on("data", data => { result.stdout += data; });
  child.stderr.on("data", data => { result.stderr += data; });
  child.on("error", error => { result.error = error.code ?? "spawn-error"; });
  const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 250).unref(); }, options.timeoutMs);
  child.on("close", code => { clearTimeout(timer); result.code = code; resolveRun(result); });
});
const rpcProbe = async (binary, env, workspace) => new Promise(resolveProbe => {
  const child = spawn(binary, ["--mode", "rpc"], { cwd: workspace, env, stdio: "pipe" });
  const manifest = { pid: child.pid, startToken: undefined, command: basename(binary), owned: true };
  let stdout = "", stderr = "", done = false; const seen = new Set();
  const finish = async outcome => {
    if (done) return; done = true;
    const current = await startToken(child.pid);
    if (manifest.startToken && current === manifest.startToken) child.kill("SIGTERM");
    record("rpc", { outcome, pid: manifest.pid, startToken: manifest.startToken ? digest(manifest.startToken) : "unavailable", stdoutHash: digest(stdout), stderrHash: digest(stderr) });
    resolveProbe({ outcome, manifest, stdoutHash: digest(stdout), stderrHash: digest(stderr) });
  };
  void startToken(child.pid).then(token => { manifest.startToken = token; });
  child.stdout.on("data", data => {
    stdout += data;
    for (const line of stdout.split("\n").slice(0, -1)) {
      try {
        const message = JSON.parse(line);
        if (message.type === "response" && !seen.has(message.id)) {
          seen.add(message.id);
          record("response", { command: message.command, success: message.success === true, dataHash: digest(JSON.stringify(message.data ?? null)) });
          if (seen.has("setup-state") && seen.has("setup-models")) void finish(message.success === true ? "handshake-complete" : "setup-required");
        }
      } catch { record("malformed-response"); }
    }
  });
  child.stderr.on("data", data => { stderr += data; });
  child.on("error", () => finish("spawn-failed"));
  child.on("close", () => finish("exited"));
  child.stdin.write(`${JSON.stringify({ id: "setup-state", type: "get_state" })}\n${JSON.stringify({ id: "setup-models", type: "get_available_models" })}\n`);
  setTimeout(() => finish("timeout"), 3_000).unref();
});
const fake = async (workspace, env) => {
  const binary = join(resolve(import.meta.dirname), "fake-prime-agent.mjs");
  const result = await rpcProbe(binary, env, workspace); // this proves framing/lifecycle; rich fixture report below
  const rich = await run(binary, ["--mode", "rpc", "--scenario", "mvp-e2e"], { cwd: workspace, env, timeoutMs: 200 });
  const kinds = rich.stdout.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line).type; } catch { return "malformed"; } });
  const required = ["agent_start", "turn_start", "message_update", "tool_execution_start", "extension_ui_request", "turn_end"];
  record("fake-e2e", { required: required.every(kind => kinds.includes(kind)), eventKindsHash: digest(JSON.stringify(kinds)), isolatedProbe: result.outcome });
  // Independent deterministic peers cover multi-thread ordering, cancellation/races, and crash.
  for (const scenario of ["reverse-two", "late-after-abort", "exit"]) {
    const race = await run(binary, ["--mode", "rpc", "--scenario", scenario], { cwd: workspace, env, timeoutMs: 150 });
    record("fake-race", { scenario, code: race.code, stdoutHash: digest(race.stdout), stderrHash: digest(race.stderr) });
  }
};
const authenticated = async () => {
  if (process.env.PRIME_AGENT_AUTHENTICATED_TEST !== "1" || process.env.PRIME_AGENT_AUTHENTICATED_PERMISSION !== "I_GRANT_READ_ONLY_SMOKE")
    return { status: "not-run", reason: "explicit env and permission are required" };
  // Deliberately only supports an explicit auth home, never guesses or borrows one.
  if (!process.env.PRIME_AGENT_AUTH_HOME) return { status: "not-run", reason: "PRIME_AGENT_AUTH_HOME must explicitly name the permitted read-only auth home" };
  return { status: "not-implemented", reason: "permission was supplied; reviewer must wire a provider-approved read-only auth mount before a cost-bearing turn" };
};
const main = async () => {
  const mode = process.argv.includes("--authenticated") ? "authenticated" : process.argv.includes("--fake") ? "fake" : "isolated";
  if (mode === "authenticated") { console.log(JSON.stringify({ lane: mode, ...(await authenticated()) })); return; }
  const root = await mkdtemp(join(tmpdir(), "t3-pa-m16-"));
  const home = join(root, "home"), workspace = join(root, "workspace"), config = join(home, "config"), session = join(home, "session"), daemon = join(home, "daemon");
  await Promise.all([home, workspace, config, session, daemon].map(path => mkdir(path, { recursive: true, mode: 0o700 })));
  await writeFile(join(workspace, ".t3-pa-m16-owned"), randomUUID(), { mode: 0o600 });
  const env = cleanEnvironment(home); const manifest = { root: pathLabel(root), home: pathLabel(home), workspace: pathLabel(workspace), config: pathLabel(config), session: pathLabel(session), daemon: pathLabel(daemon), environmentKeys: Object.keys(env).sort(), resources: [] };
  let result;
  try {
    if (mode === "fake") { await fake(workspace, env); result = { status: "passed", binary: "fake-prime-agent" }; }
    else {
      const binary = process.env.PRIME_AGENT_BINARY ?? "prime-agent";
      const version = await run(binary, ["--version"], { cwd: workspace, env, timeoutMs: 3_000 });
      record("version", { binary: basename(binary), code: version.code, outputHash: digest(version.stdout), stderrHash: digest(version.stderr), spawnError: version.error ?? null });
      if (version.error) result = { status: "setup-required", reason: "installed binary unavailable" };
      else { const probe = await rpcProbe(binary, env, workspace); result = { status: probe.outcome === "handshake-complete" ? "ready-candidate" : "setup-required", versionExit: version.code, probe: probe.outcome }; }
    }
  } finally {
    const before = await rm(root, { recursive: true, force: true }).then(() => "removed", () => "retained-warning");
    record("cleanup", { result: before, root: pathLabel(root) });
  }
  const canonical = transcript.map(({ kind, ...fields }) => ({ kind, ...fields }));
  console.log(JSON.stringify({ lane: mode, result, manifest, transcriptHash: digest(JSON.stringify(canonical)), transcript: canonical, redaction: "hash-only; raw paths, output, diagnostics, and secrets are omitted" }, null, 2));
};
await main();
