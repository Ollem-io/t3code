#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
artifact=apps/server/src/provider/Layers/prime-provider-probe-artifact.mjs
fixture=apps/server/integration/fixtures/prime-rpc/fake-prime-provider.mjs
root="$(mktemp -d "${TMPDIR:-/tmp}/t3-prime-probe-verify.XXXXXX")"
trap 'rm -rf "$root"' EXIT
make_fake() {
  local name="$1"
  local scenario="$2"
  local version="$3"
  local target="$root/$name.mjs"
  sed \
    -e "s/const scenario = process.env.T3_TEST_PRIME_SCENARIO ?? \"ready\";/const scenario = \"$scenario\";/" \
    -e "s/process.env.T3_TEST_PRIME_VERSION ?? \"0.7.2\"/\"$version\"/" \
    "$fixture" > "$target"
  chmod +x "$target"
}
make_fake ready ready 0.7.2
make_fake incompatible ready 0.7.1
make_fake setup setup 0.7.2
make_fake runtime runtime-failure 0.7.2
make_fake malformed malformed 0.7.2
make_fake advisory ready 0.8.0
assert_run() {
  local name="$1" expected="$2" output before after
  before="$(env | sort)"
  output="$(PRIME_AGENT_BIN="$root/$name.mjs" node "$artifact")"
  after="$(env | sort)"
  [[ "$before" == "$after" ]]
  [[ "$output" == *\"readiness\":\"$expected\"* ]]
  [[ "$(printf '%s\n' "$output" | wc -l)" -eq 1 ]]
  node -e 'const value=JSON.parse(process.argv[1]); if (typeof value.modelCount !== "number") process.exit(1)' "$output"
}
for _ in 1 2 3 4 5; do
  assert_run ready ready
  assert_run incompatible incompatible
  assert_run setup setup-required
  assert_run runtime runtime-error
  assert_run malformed runtime-error
  assert_run advisory advisory
done
printf 'source-free artifact matrix: 30/30 passed\n'
