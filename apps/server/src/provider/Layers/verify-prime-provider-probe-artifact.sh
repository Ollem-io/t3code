#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
artifact=apps/server/src/provider/Layers/prime-provider-probe-artifact.mjs
root="$(mktemp -d "${TMPDIR:-/tmp}/t3-prime-probe-verify.XXXXXX")"
trap 'rm -rf "$root"' EXIT

make_fake() {
  local name="$1" scenario="$2" version="$3" target="$root/$1.mjs" marker="$root/$1.marker.json"
  node - "$target" "$marker" "$scenario" "$version" <<'NODE'
const fs = require("node:fs");
const [target, marker, scenario, version] = process.argv.slice(2);
const source = `#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const marker = ${JSON.stringify(marker)};
const scenario = ${JSON.stringify(scenario)};
const version = ${JSON.stringify(version)};
const append = (value) => {
  let values = [];
  try { values = JSON.parse(readFileSync(marker, "utf8")); } catch {}
  values.push(value);
  writeFileSync(marker, JSON.stringify(values));
};
const sessionIndex = process.argv.indexOf("--session-dir");
const session = sessionIndex < 0 ? null : process.argv[sessionIndex + 1];
append({
  phase: process.argv.includes("--version") ? "version" : "rpc",
  argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME,
  userprofile: process.env.USERPROFILE, xdgConfig: process.env.XDG_CONFIG_HOME,
  xdgData: process.env.XDG_DATA_HOME, xdgState: process.env.XDG_STATE_HOME,
  tmpdir: process.env.TMPDIR, tmp: process.env.TMP, temp: process.env.TEMP,
  session,
  forbidden: {
    openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY,
    secret: process.env.SECRET_TOKEN, prime: process.env.PRIME_AGENT_TOKEN,
  },
});
if (process.argv.includes("--version")) {
  process.stdout.write(\`prime-agent \${version}\n\`);
  process.exit(0);
}
if (session) mkdirSync(session, { recursive: true });
if (scenario === "zero-delayed") {
  const keepAlive = setInterval(() => {}, 1000);
  process.on("SIGTERM", () => setTimeout(() => {
    clearInterval(keepAlive);
    append({ phase: "exit", rootExistedAtExit: existsSync(process.cwd()), sessionExistedAtExit: existsSync(session) });
    process.exit(0);
  }, 50));
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const command = JSON.parse(line);
  if (scenario === "malformed") return process.stdout.write("{bad-json}\\n");
  if (scenario === "runtime") return process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: false, error: "internal failure" }) + "\\n");
  if (scenario === "setup") return process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: false, error: "setup required" }) + "\\n");
  const models = scenario === "zero-delayed" ? [] : [{ id: "model-a", name: "Model A", api: "api", provider: "prime", baseUrl: "https://example.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 }];
  const data = command.type === "get_available_models" ? { models } : { state: "idle" };
  process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\\n");
});
`;
fs.writeFileSync(target, source, { mode: 0o755 });
NODE
}

make_fake ready ready 0.7.2
make_fake incompatible ready 0.7.1
make_fake setup setup 0.7.2
make_fake runtime runtime 0.7.2
make_fake malformed malformed 0.7.2
make_fake advisory ready 0.8.0
make_fake zero zero-delayed 0.7.2

assert_isolation() {
  local marker="$1" expect_rpc="$2"
  node - "$marker" "$expect_rpc" <<'NODE'
const fs = require("node:fs");
const values = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const version = values.find((v) => v.phase === "version");
const rpc = values.find((v) => v.phase === "rpc");
if (!version || (process.argv[3] === "yes" && !rpc)) throw new Error("required observations are missing");
for (const value of [version, ...(rpc ? [rpc] : [])]) {
  if (!value.cwd.includes("t3-prime-probe-") || value.home !== value.cwd + "/home") throw new Error("non-disposable cwd/home");
  if (value.userprofile !== value.home || value.xdgConfig !== value.home + "/.config" || value.xdgData !== value.home + "/.local/share" || value.xdgState !== value.home + "/.local/state") throw new Error("non-isolated home paths");
  if (value.tmpdir !== value.home || value.tmp !== value.home || value.temp !== value.home) throw new Error("non-isolated temporary paths");
  if (Object.values(value.forbidden).some((entry) => entry !== undefined)) throw new Error("secret leaked");
}
if (JSON.stringify(version.argv) !== JSON.stringify(["--version"])) throw new Error("unexpected version invocation");
if (rpc && (!rpc.argv.includes("--mode") || !rpc.argv.includes("rpc") || !rpc.session?.startsWith(rpc.home + "/userdata/prime/v1/environments/") || !rpc.session.endsWith("/session"))) throw new Error("unexpected RPC/session invocation");
const observed = rpc ?? version;
if (fs.existsSync(observed.cwd) || fs.existsSync(observed.home) || (rpc && fs.existsSync(rpc.session))) throw new Error("probe resources survived artifact exit");
NODE
}

assert_run() {
  local name="$1" expected="$2" output stderr marker="$root/$1.marker.json"
  rm -f "$marker"
  output="$(env -u NO_COLOR -u FORCE_COLOR OPENAI_API_KEY=x ANTHROPIC_API_KEY=x SECRET_TOKEN=x PRIME_AGENT_TOKEN=x PRIME_AGENT_BIN="$root/$name.mjs" node "$artifact" 2>"$root/stderr")"
  stderr="$(cat "$root/stderr")"
  [[ -z "$stderr" ]]
  [[ "$(printf '%s\n' "$output" | wc -l)" -eq 1 ]]
  node -e 'const value=JSON.parse(process.argv[1]); if(value.readiness!==process.argv[2] || typeof value.modelCount!=="number") process.exit(1)' "$output" "$expected"
  [[ "$name" == incompatible ]] && assert_isolation "$marker" no || assert_isolation "$marker" yes
}

for _ in 1 2 3 4 5; do
  assert_run ready ready
  assert_run incompatible incompatible
  assert_run setup setup-required
  assert_run runtime runtime-error
  assert_run malformed runtime-error
  assert_run advisory advisory
  assert_run zero setup-required
 done

rm -f "$root/stderr"
output="$(env -u PRIME_AGENT_BIN -u NO_COLOR -u FORCE_COLOR PRIME_AGENT_ENABLED=0 node "$artifact" 2>"$root/stderr")"
[[ ! -s "$root/stderr" ]]
[[ "$(printf '%s\n' "$output" | wc -l)" -eq 1 ]]
node -e 'const v=JSON.parse(process.argv[1]); if(v.version!==null || v.compatibility!=="unknown" || v.readiness!=="disabled" || v.modelCount!==0) process.exit(1)' "$output"
printf 'source-free artifact matrix: 36/36 passed\n'
