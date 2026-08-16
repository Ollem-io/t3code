export const meta = {
  name: "pa-milestone",
  description: "Gated implement → watch → dual-review cycle for one Prime Agent milestone",
  whenToUse:
    "Run one PA-* milestone through the software-development skill cycle: Opus implementer directing GPT-5.6 Sol, Luna test watcher, two independent Opus reviewers, same-SHA repair loop. Never merges; returns the ledger.",
  phases: [
    {
      title: "Implement",
      detail: "Opus agent in isolated worktree, Sol as directed coder",
      model: "opus",
    },
    { title: "Watch", detail: "Luna runs focused verification and reports outcome" },
    {
      title: "Review",
      detail: "independent code/security + black-box product reviews on the exact SHA",
      model: "opus",
    },
    {
      title: "Repair",
      detail: "blocker fixes and same-SHA re-review, max 3 rounds",
      model: "opus",
    },
  ],
};

// args: { milestone: 'PA-A03', baseSha: '<sha of main to branch from>' }
if (!args || typeof args.milestone !== "string" || typeof args.baseSha !== "string") {
  throw new Error("pa-milestone requires args {milestone, baseSha}");
}
const MILESTONE = args.milestone;
const BASE = args.baseSha;
const RUN = "prime-agent-perfect-integration-20260813";
const BRANCH = `dev/${RUN}/${MILESTONE.toLowerCase()}`;

const COMMON = `
Repository: /Users/dsmello/Code/brokenBotLabs/t3code. Read AGENTS.md first and obey it (focused tests only — never repo-wide runs; use ./node_modules/.bin/vp test run <files>).
The frozen milestone contract for ${MILESTONE} is its section in docs/implementation-plan.md; execution rules are in docs/prime-agent-remaining-execution-plan.md; live status in docs/prime-agent-integration-status.md.
Security constraints are hard requirements: no ACP fallback, no live auth mutation, bounded queues, no invented native IDs or fake cancellation, no secret/native queued text in logs/telemetry/activities/durable intents, proof-before-action cleanup of exact T3-owned resources only.
Baseline guidance — VERIFY, never assume: the server package typecheck is red at baseline (exits 1 with dozens of pre-existing diagnostics); the web typecheck has three known pre-existing diagnostics (attachment union, branded Prime driver index, readonly test mutation); the ProviderCommandReactor "serializes concurrent distinct turn starts" test and 9 EventNdjsonLogger tests fail at baseline. None of that excuses NEW diagnostics or failures: attribute every diagnostic/failure in files you touch (or caused via interface changes in untouched files) by reproducing at the base SHA in a detached worktree before classifying it pre-existing. Anything your milestone introduced is yours to fix.
NEVER launch browsers, Electron, or simulators — UI-launch permission is not granted; mark visual evidence as truthfully pending with exact launch instructions instead.
GPT-5.6 helpers are available via Codex CLI: \`codex exec -m gpt-5.6-sol --skip-git-repo-check -C <dir> "<prompt>"\` (strong coder — give it one bounded, fully-specified piece of work at a time and integrate its output yourself) and \`codex exec -m gpt-5.6-luna ...\` (watcher/judge). If a model fails to resolve, note it and continue with your own capabilities — never claim a model ran when it did not.
`;

const IMPLEMENT_SCHEMA = {
  type: "object",
  required: ["sha", "branch", "summary", "testEvidence", "artifact"],
  properties: {
    sha: { type: "string" },
    branch: { type: "string" },
    summary: { type: "string" },
    testEvidence: { type: "string" },
    artifact: { type: "string" },
    assumptions: { type: "array", items: { type: "string" } },
  },
};

const WATCH_SCHEMA = {
  type: "object",
  required: ["sha", "pass", "report"],
  properties: {
    sha: { type: "string" },
    pass: { type: "boolean" },
    report: { type: "string" },
  },
};

const REVIEW_SCHEMA = {
  type: "object",
  required: ["sha", "verdict", "findings"],
  properties: {
    sha: { type: "string" },
    verdict: { type: "string", enum: ["APPROVE", "REJECT"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "summary"],
        properties: {
          severity: { type: "string", enum: ["BLOCKER", "NON-BLOCKER"] },
          summary: { type: "string" },
          evidence: { type: "string" },
        },
      },
    },
  },
};

phase("Implement");
log(`Implementing ${MILESTONE} on ${BRANCH} from base ${BASE}`);
const impl = await agent(
  `${COMMON}
You are the implementer for milestone ${MILESTONE} (attempt 1).
1. You are in an isolated git worktree. Create/check out branch ${BRANCH} from ${BASE} (create it if absent; if it exists with prior commits, continue on it).
2. Implement ONLY ${MILESTONE} per its frozen contract in docs/implementation-plan.md: scope, exclusions, acceptance criteria, expected components, review artifact, focused verification, applicability lines. Prefer the smallest implementation that satisfies the contract and matches surrounding code style.
3. Use Sol (codex exec -m gpt-5.6-sol) for well-bounded code authoring where it helps; you own decomposition, integration, and correctness.
4. Add focused tests for every behavior change and build the milestone's source-derived runnable artifact.
5. Run the milestone's focused verification commands plus tests for files you touched. Fix failures you introduced.
6. Commit on ${BRANCH} (git commit; end the message with "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>") and push the branch to origin.
Return: exact commit sha, branch, summary of changes, verbatim test evidence, artifact path + how to run it, and any assumptions.`,
  {
    label: `implement:${MILESTONE}`,
    phase: "Implement",
    model: "opus",
    isolation: "worktree",
    schema: IMPLEMENT_SCHEMA,
  },
);
if (!impl) throw new Error("Implementer failed or was skipped");
log(`Implemented at ${impl.sha}`);

const watch = (sha) =>
  agent(
    `${COMMON}
You are the test watcher for ${MILESTONE} at exact SHA ${sha} on branch ${BRANCH}.
Work in an isolated worktree checked out at exactly ${sha} (verify with git rev-parse HEAD; if it does not match after fetch/checkout, report pass:false with reason "stale SHA").
Run the milestone's focused verification commands from docs/implementation-plan.md and the runnable artifact. Then hand your raw outputs to Luna for an independent outcome judgment: pipe a concise summary plus the verbatim tails of each command's output into \`codex exec -m gpt-5.6-luna --skip-git-repo-check -C <worktree> "<prompt asking: do these results show the focused verification passing, ignoring the documented pre-existing failures? answer PASS or FAIL with one-line reasons>"\`. If Luna is unavailable, judge yourself and say so.
Return pass=true only if everything required passes (documented pre-existing failures excluded). The report must contain the exact commands, result counts, and Luna's verbatim verdict.`,
    { label: `watch:${MILESTONE}`, phase: "Watch", isolation: "worktree", schema: WATCH_SCHEMA },
  );

const reviewPair = (sha) =>
  parallel([
    () =>
      agent(
        `${COMMON}
You are the independent code/security reviewer for ${MILESTONE} at exact SHA ${sha} on branch ${BRANCH}. Work in an isolated worktree at exactly that SHA (verify git rev-parse HEAD; mismatch = REJECT stale SHA).
Review the diff against its merge base with ${BASE} for correctness bugs and for every security constraint listed above. Run the focused tests yourself; do not take claims on trust. Verify no queued/steering or secret text can reach durable intents, activities, error details, logs, or telemetry, and that all IDs/cancellation semantics are native and truthful. You may consult Luna (codex exec -m gpt-5.6-luna) for a second opinion on suspicious findings.
Verdict APPROVE only with zero BLOCKERs. Every finding needs file:line and concrete failure evidence. Do not manufacture blockers from style.`,
        {
          label: `review:code-security`,
          phase: "Review",
          model: "opus",
          isolation: "worktree",
          schema: REVIEW_SCHEMA,
        },
      ),
    () =>
      agent(
        `${COMMON}
You are the independent black-box product reviewer for ${MILESTONE} at exact SHA ${sha} on branch ${BRANCH}. Work in an isolated worktree at exactly that SHA (verify git rev-parse HEAD; mismatch = REJECT stale SHA).
Judge observable behavior against the milestone's acceptance criteria and the user-facing promises in docs/implementation-plan.md — not code style. Run the runnable artifact and the behavior-level test suites; probe the edge cases the acceptance criteria imply (capability absent, lifecycle transitions, stale/late events, multi-client truthfulness). Do not review the source diff line-by-line; evaluate what the product does. No UI launches — record visual evidence as truthfully pending.
Verdict APPROVE only with zero BLOCKERs, each finding with reproducible evidence.`,
        {
          label: `review:black-box`,
          phase: "Review",
          model: "opus",
          isolation: "worktree",
          schema: REVIEW_SCHEMA,
        },
      ),
  ]);

const ledger = [];
let sha = impl.sha;
let approved = false;
const MAX_ROUNDS = 3;
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const watched = await watch(sha);
  if (!watched || !watched.pass) {
    ledger.push({ round, sha, watch: watched?.report ?? "watcher failed", reviews: null });
    log(`Round ${round}: watcher FAILED at ${sha}`);
  } else {
    log(`Round ${round}: watcher passed at ${sha}; starting dual review`);
    const [codeReview, productReview] = await reviewPair(sha);
    ledger.push({ round, sha, watch: watched.report, reviews: { codeReview, productReview } });
    const blockers = []
      .concat(codeReview?.findings ?? [], productReview?.findings ?? [])
      .filter((f) => f.severity === "BLOCKER");
    if (
      codeReview?.verdict === "APPROVE" &&
      productReview?.verdict === "APPROVE" &&
      blockers.length === 0
    ) {
      approved = true;
      log(`Round ${round}: dual APPROVE on ${sha}`);
      break;
    }
    log(`Round ${round}: REJECT with ${blockers.length} blocker(s)`);
    if (round === MAX_ROUNDS) break;
    const packet = JSON.stringify({ watcher: watched.report, codeReview, productReview }, null, 2);
    const repair = await agent(
      `${COMMON}
You are the repair implementer for ${MILESTONE} (round ${round + 1}). Branch ${BRANCH}, current SHA ${sha}. Work in an isolated worktree on that branch.
Fix every BLOCKER in this dual-review packet without weakening acceptance criteria; add a regression test per blocker. Address NON-BLOCKERs only when trivial and in-scope. Use Sol (codex exec -m gpt-5.6-sol) with tight direction — this is the escalation path, so specify exactly what must change and why.
Review packet:
${packet}
Re-run the focused verification, commit on ${BRANCH} (Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>), push, and return the new exact sha with evidence.`,
      {
        label: `repair:round${round + 1}`,
        phase: "Repair",
        model: "opus",
        isolation: "worktree",
        schema: IMPLEMENT_SCHEMA,
      },
    );
    if (!repair) throw new Error(`Repair round ${round + 1} failed`);
    sha = repair.sha;
    continue;
  }
  // Watcher failure path: send it back to a repair agent too.
  if (round === MAX_ROUNDS) break;
  const repair = await agent(
    `${COMMON}
You are the repair implementer for ${MILESTONE}. Branch ${BRANCH}, current SHA ${sha}. Work in an isolated worktree on that branch.
The test watcher reported failure. Reproduce, fix, re-run the focused verification, commit (Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>), push, and return the new exact sha with evidence.
Watcher report:
${ledger[ledger.length - 1].watch}`,
    {
      label: `repair:watch-fail`,
      phase: "Repair",
      model: "opus",
      isolation: "worktree",
      schema: IMPLEMENT_SCHEMA,
    },
  );
  if (!repair) throw new Error("Repair after watcher failure failed");
  sha = repair.sha;
}

return {
  milestone: MILESTONE,
  branch: BRANCH,
  finalSha: sha,
  dualApproved: approved,
  mergeInstruction: approved
    ? `Coordinator: verify both APPROVE verdicts reference ${sha}, merge ${BRANCH} into main, run the smallest post-merge proof, update docs/prime-agent-integration-status.md, then remove worktree/branch.`
    : `NOT approved after ${ledger.length} round(s). Do not merge. Surface the remaining blockers to the user.`,
  ledger,
};
