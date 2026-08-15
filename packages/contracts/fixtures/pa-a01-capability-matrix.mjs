/**
 * PA-A01 capability matrix — standalone, dependency-free contract fixture.
 *
 * Copy this file alone and run `node pa-a01-capability-matrix.mjs`.  It is
 * intentionally plain JavaScript so compatibility review does not require a
 * workspace install.
 */
export const CAPABILITY_MATRIX = Object.freeze({
  "follow-up.add": "followUps",
  "follow-up.edit": "followUps",
  "follow-up.reorder": "followUps",
  "follow-up.cancel": "followUps",
  "follow-up.reverse": "followUps",
  "compaction.request": "compaction",
  "compaction.cancel": "compaction",
  "compaction.reverse": "compaction",
  "command.discover": "commandDiscovery",
  "command.invoke": "commandDiscovery",
  "skill.discover": "commandDiscovery",
  "skill.invoke": "commandDiscovery",
  "interaction.respond": "interactions",
  "interaction.cancel": "interactions",
  "task.observe": "tasks",
  "task.cancel": "tasks",
  "task.pause": "tasks",
  "task.resume": "tasks",
  "goal.create": "goals",
  "goal.update": "goals",
  "goal.delete": "goals",
  "goal.reverse": "goals",
  "heartbeat.create": "goals",
  "heartbeat.update": "goals",
  "heartbeat.pause": "goals",
  "heartbeat.resume": "goals",
  "heartbeat.delete": "goals",
  "heartbeat.reverse": "goals",
  "thread.rename": "namingAndForking",
  "thread.fork": "namingAndForking",
  "usage.snapshot.retry": "usageAndRetry",
});

export const CAPABILITIES = Object.freeze([
  "followUps",
  "compaction",
  "commandDiscovery",
  "interactions",
  "tasks",
  "goals",
  "namingAndForking",
  "usageAndRetry",
]);
export const LIFECYCLE_STATUSES = Object.freeze(["pending", "succeeded", "failed", "reversed"]);

export function capabilityForOperation(type) {
  const capability = CAPABILITY_MATRIX[type];
  if (capability === undefined)
    throw new TypeError(`Unsupported provider runtime operation: ${type}`);
  return capability;
}

export function supportsOperation(capabilities, type) {
  return capabilities?.[capabilityForOperation(type)] === true;
}

function check(condition, message) {
  if (!condition) throw new Error(`PA-A01 capability matrix: ${message}`);
}

export function verifyCapabilityMatrix() {
  const entries = Object.entries(CAPABILITY_MATRIX);
  check(entries.length === 31, `expected 31 operations, got ${entries.length}`);
  check(
    new Set(Object.values(CAPABILITY_MATRIX)).size === 8,
    "expected exactly eight capabilities",
  );
  check(CAPABILITIES.length === 8, "capability vocabulary must contain eight names");
  check(
    LIFECYCLE_STATUSES.join(",") === "pending,succeeded,failed,reversed",
    "lifecycle statuses changed",
  );
  for (const [type, capability] of entries) {
    check(CAPABILITIES.includes(capability), `${type} maps outside the capability vocabulary`);
    check(
      supportsOperation({ [capability]: true }, type),
      `${type} is not enabled by its own capability`,
    );
    check(
      !supportsOperation({}, type),
      `${type} is enabled by an old payload with missing capabilities`,
    );
  }
  // Every reversible family has its explicit reverse operation; every
  // current-state/action family remains separately named (no generic escape).
  for (const type of [
    "follow-up.reverse",
    "compaction.reverse",
    "goal.reverse",
    "heartbeat.reverse",
  ]) {
    check(type in CAPABILITY_MATRIX, `missing reverse operation ${type}`);
  }
  for (const type of [
    "follow-up.add",
    "compaction.request",
    "command.discover",
    "skill.discover",
    "interaction.respond",
    "task.observe",
    "goal.create",
    "heartbeat.create",
    "thread.rename",
    "usage.snapshot.retry",
  ])
    check(type in CAPABILITY_MATRIX, `missing current/action category ${type}`);
  for (const type of ["prime.raw", "native.invoke", "shell.run", "command.passthrough"]) {
    let rejected = false;
    try {
      capabilityForOperation(type);
    } catch {
      rejected = true;
    }
    check(rejected, `generic or provider-native passthrough accepted: ${type}`);
  }
  return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  verifyCapabilityMatrix();
  console.log("PA-A01 capability matrix verified (31 operations / 8 capabilities).");
}
