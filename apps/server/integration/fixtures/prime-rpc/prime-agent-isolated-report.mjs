#!/usr/bin/env node
/** PA-M16 isolated evidence runner: every child is owned, identified, and reaped. */
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const secretKeys = /(?:token|secret|key|password|authorization|cookie)/i;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const redact = (value) => (typeof value === "string" ? `[sha256:${digest(value)}]` : value);
const pathLabel = (value) => `[path-sha256:${digest(resolve(value))}]`;
const transcript = [];
// Keep exact PIDs for ownership checks and signalling, but never let one cross the
// artifact boundary. This conversion is deliberately applied at every transcript
// record boundary, not just to the final manifest projection.
const artifactField = ([key, value]) => {
  if (key === "pid") return ["pidHash", redact(String(value))];
  if (key === "startToken") return ["startTokenHash", redact(String(value))];
  return [key, secretKeys.test(key) || key === "path" ? redact(String(value)) : value];
};
const record = (kind, value = {}) =>
  transcript.push({ kind, ...Object.fromEntries(Object.entries(value).map(artifactField)) });
const artifactResource = ({ pid, startToken, ...resource }) => ({
  ...resource,
  // `pid` and `startToken` remain on the in-memory resource for exact lifecycle
  // proof/action. The report receives only deterministic SHA-256 identities.
  pidHash: redact(String(pid)),
  startTokenHash: redact(String(startToken)),
});
const assertSafeArtifact = (serialized, resources) => {
  if (/"pid"\s*:/.test(serialized))
    throw new Error("refusing to serialize a raw pid field in the artifact");
  for (const { pid } of resources)
    if (serialized.includes(String(pid)))
      throw new Error("refusing to serialize a spawned raw pid in the artifact");
};
const linuxStartToken = async (pid) => {
  if (platform() !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/)[19];
  } catch {
    return undefined;
  }
};
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const closeWithin = (closed, ms) =>
  Promise.race([closed.then(() => true), delay(ms).then(() => false)]);
const cleanEnvironment = (home) => ({
  PATH: process.env.PATH ?? "",
  LANG: process.env.LANG ?? "C",
  LC_ALL: process.env.LC_ALL ?? "C",
  NO_COLOR: "1",
  HOME: home,
  XDG_CONFIG_HOME: join(home, "xdg-config"),
  XDG_DATA_HOME: join(home, "xdg-data"),
  XDG_CACHE_HOME: join(home, "xdg-cache"),
  TMPDIR: join(home, "tmp"),
  T3CODE_HOME: join(home, "t3-home"),
});

// This is deliberately PID + Linux start-time based.  A PID alone is never sufficient
// authority to signal a process, and no process is ever selected by command/name.
const launch = async (command, args, { cwd, env, resources, label }) => {
  const child = spawn(command, args, { cwd, env, stdio: "pipe" });
  const resource = {
    kind: "process",
    label,
    pid: child.pid,
    startToken: "unavailable",
    lifecycle: "started",
    signals: [],
  };
  resources.push(resource);
  let stdout = "",
    stderr = "",
    spawnError;
  child.stdout.on("data", (data) => {
    stdout += data;
  });
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  child.on("error", (error) => {
    spawnError = error.code ?? "spawn-error";
  });
  const closed = new Promise((resolveClose) =>
    child.on("close", (code, signal) => {
      resource.lifecycle = "closed";
      resource.exitCode = code;
      resource.exitSignal = signal;
      resolveClose();
    }),
  );
  const token = await linuxStartToken(child.pid);
  resource.startToken = token ?? "unavailable";
  // A rapid natural exit needs no signal.  A still-running process without its exact
  // start token is intentionally left alone and causes cleanup to retain its root.
  const signal = async (name) => {
    const current = await linuxStartToken(child.pid);
    if (!token || current !== token) {
      resource.lifecycle = "identity-unverified";
      resource.identity = current ? "changed" : "unavailable";
      return false;
    }
    const sent = child.kill(name);
    resource.signals.push(name);
    return sent;
  };
  const stop = async () => {
    if (await closeWithin(closed, 120)) return true;
    if (!(await signal("SIGTERM"))) return false;
    if (await closeWithin(closed, 300)) return true;
    if (!(await signal("SIGKILL"))) return false;
    if (await closeWithin(closed, 500)) return true;
    resource.lifecycle = "termination-timeout";
    return false;
  };
  return {
    child,
    resource,
    closed,
    stop,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get spawnError() {
      return spawnError;
    },
  };
};
const run = async (command, args, options) => {
  const managed = await launch(command, args, { ...options, label: `run:${basename(command)}` });
  managed.child.stdin.end();
  await closeWithin(managed.closed, options.timeoutMs);
  const stopped = await managed.stop();
  return {
    code: managed.resource.exitCode,
    stdout: managed.stdout,
    stderr: managed.stderr,
    error: managed.spawnError,
    stopped,
  };
};
const rpcProbe = async (binary, env, workspace, resources, scenario) => {
  const managed = await launch(
    binary,
    ["--mode", "rpc", ...(scenario ? ["--scenario", scenario] : [])],
    { cwd: workspace, env, resources, label: `rpc:${basename(binary)}` },
  );
  let parsed = "",
    outcome = "timeout",
    stdinEnded = false;
  const seen = new Set();
  const consume = () => {
    const lines = parsed.split("\n");
    parsed = lines.pop();
    for (const line of lines)
      try {
        const message = JSON.parse(line);
        if (message.type === "response" && !seen.has(message.id)) {
          seen.add(message.id);
          record("response", {
            command: message.command,
            success: message.success === true,
            dataHash: digest(JSON.stringify(message.data ?? null)),
          });
        }
      } catch {
        record("malformed-response");
      }
  };
  managed.child.stdout.on("data", (data) => {
    parsed += data;
    consume();
  });
  managed.child.stdin.write(
    `${JSON.stringify({ id: "setup-state", type: "get_state" })}\n${JSON.stringify({ id: "setup-models", type: "get_available_models" })}\n`,
  );
  const deadline = Date.now() + 3_000;
  while (!seen.has("setup-state") || !seen.has("setup-models")) {
    if (await closeWithin(managed.closed, 15)) {
      outcome = "exited";
      break;
    }
    if (Date.now() >= deadline) break;
  }
  if (seen.has("setup-state") && seen.has("setup-models")) {
    outcome = "handshake-complete";
    managed.child.stdin.end();
    stdinEnded = true;
  }
  // A valid response is not completion: after ending stdin, exact child close is required.
  const closed = await closeWithin(managed.closed, 250);
  const stopped = closed || (await managed.stop());
  if (!stopped) outcome = "cleanup-failed";
  record("rpc", {
    outcome,
    pid: managed.resource.pid,
    startToken: managed.resource.startToken,
    stdinEnded,
    lifecycle: managed.resource.lifecycle,
    stdoutHash: digest(managed.stdout),
    stderrHash: digest(managed.stderr),
  });
  return { outcome, stopped };
};
const fake = async (workspace, env, resources) => {
  const binary = join(resolve(import.meta.dirname), "fake-prime-agent.mjs");
  const result = await rpcProbe(binary, env, workspace, resources, "linger");
  const rich = await run(binary, ["--mode", "rpc", "--scenario", "mvp-e2e"], {
    cwd: workspace,
    env,
    timeoutMs: 200,
    resources,
  });
  const kinds = rich.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line).type;
      } catch {
        return "malformed";
      }
    });
  const required = [
    "agent_start",
    "turn_start",
    "message_update",
    "tool_execution_start",
    "extension_ui_request",
    "turn_end",
  ];
  record("fake-e2e", {
    required: required.every((kind) => kinds.includes(kind)),
    eventKindsHash: digest(JSON.stringify(kinds)),
    isolatedProbe: result.outcome,
    stopped: result.stopped && rich.stopped,
  });
  for (const scenario of ["reverse-two", "late-after-abort", "exit"]) {
    const race = await run(binary, ["--mode", "rpc", "--scenario", scenario], {
      cwd: workspace,
      env,
      timeoutMs: 150,
      resources,
    });
    record("fake-race", {
      scenario,
      code: race.code,
      stopped: race.stopped,
      stdoutHash: digest(race.stdout),
      stderrHash: digest(race.stderr),
    });
  }
  return result.stopped && rich.stopped;
};
const authenticated = async () => {
  if (
    process.env.PRIME_AGENT_AUTHENTICATED_TEST !== "1" ||
    process.env.PRIME_AGENT_AUTHENTICATED_PERMISSION !== "I_GRANT_READ_ONLY_SMOKE"
  )
    return { status: "not-run", reason: "explicit env and permission are required" };
  if (!process.env.PRIME_AGENT_AUTH_HOME)
    return {
      status: "not-run",
      reason: "PRIME_AGENT_AUTH_HOME must explicitly name the permitted read-only auth home",
    };
  return {
    status: "not-implemented",
    reason:
      "permission was supplied; reviewer must wire a provider-approved read-only auth mount before a cost-bearing turn",
  };
};
const main = async () => {
  const mode = process.argv.includes("--authenticated")
    ? "authenticated"
    : process.argv.includes("--fake")
      ? "fake"
      : "isolated";
  if (mode === "authenticated") {
    console.log(JSON.stringify({ lane: mode, ...(await authenticated()) }));
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "t3-pa-m16-"));
  const home = join(root, "home"),
    workspace = join(root, "workspace"),
    config = join(home, "config"),
    session = join(home, "session"),
    daemon = join(home, "daemon");
  await Promise.all(
    [home, workspace, config, session, daemon].map((path) =>
      mkdir(path, { recursive: true, mode: 0o700 }),
    ),
  );
  await writeFile(join(workspace, ".t3-pa-m16-owned"), randomUUID(), { mode: 0o600 });
  const env = cleanEnvironment(home),
    resources = [];
  // `resources` intentionally retains raw PID/start-token values while running.
  // Its report projection is built only after cleanup, once lifecycle is final.
  const manifest = {
    root: pathLabel(root),
    directories: [root, home, workspace, config, session, daemon].map(pathLabel),
    environmentKeys: Object.keys(env).sort(),
  };
  let result;
  try {
    if (mode === "fake")
      result = {
        status: (await fake(workspace, env, resources)) ? "passed" : "cleanup-failed",
        binary: "fake-prime-agent",
      };
    else {
      const binary = process.env.PRIME_AGENT_BINARY ?? "prime-agent";
      const version = await run(binary, ["--version"], {
        cwd: workspace,
        env,
        timeoutMs: 3_000,
        resources,
      });
      record("version", {
        binary: basename(binary),
        code: version.code,
        outputHash: digest(version.stdout),
        stderrHash: digest(version.stderr),
        spawnError: version.error ?? null,
        stopped: version.stopped,
      });
      if (!version.stopped)
        result = { status: "cleanup-failed", reason: "version child was not safely reaped" };
      else if (version.error)
        result = { status: "setup-required", reason: "installed binary unavailable" };
      else {
        const probe = await rpcProbe(binary, env, workspace, resources);
        result = {
          status:
            probe.stopped && probe.outcome === "handshake-complete"
              ? "ready-candidate"
              : "setup-required",
          versionExit: version.code,
          probe: probe.outcome,
        };
      }
    }
  } finally {
    const safe = resources.every((resource) => resource.lifecycle === "closed");
    const cleanup = safe
      ? await rm(root, { recursive: true, force: true }).then(
          () => "removed",
          () => "retained-failed",
        )
      : "retained-failed";
    record("cleanup", { result: cleanup, root: pathLabel(root), resourcesClosed: safe });
    if (cleanup !== "removed")
      result = { status: "cleanup-failed", reason: "owned resources were not safely reaped" };
  }
  const canonical = transcript.map(({ kind, ...fields }) => ({ kind, ...fields }));
  const artifact = {
    lane: mode,
    result,
    manifest: { ...manifest, resources: resources.map(artifactResource) },
    transcriptHash: digest(JSON.stringify(canonical)),
    transcript: canonical,
    redaction:
      "hash-only; raw paths, output, diagnostics, secrets, PIDs, and start tokens are omitted",
  };
  // JSON.stringify is the sole report serialization boundary. Validate the complete
  // transitive payload immediately before emitting it, rather than trusting callers
  // to remember to redact newly-added nested fields.
  const serialized = JSON.stringify(artifact, null, 2);
  assertSafeArtifact(serialized, resources);
  console.log(serialized);
};
await main();
