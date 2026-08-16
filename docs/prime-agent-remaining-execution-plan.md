# Prime Agent remaining-work execution plan

_Created: 2026-08-16. Run: `prime-agent-perfect-integration-20260813`. Companion to `docs/implementation-plan.md` (milestone contracts) and `docs/prime-agent-integration-status.md` (live status)._

This plan operationalizes the remaining 13 milestones using the gated multi-agent
cycle from the `software-development` skill (garden.vps.hg.lab:
`/root/.prime/agent/skills/software-development/SKILL.md`), adapted to this
harness. Milestone scopes, acceptance criteria, artifacts, and verification
commands are NOT redefined here — they remain frozen in
`docs/implementation-plan.md`. This document defines execution order, role
routing, and the orchestration workflow.

## Current state

- 17 of 30 milestones merged to `main` at `c9659346`.
- PA-A02 repaired at `e52a7e0f` on
  `dev/prime-agent-perfect-integration-20260813/pa-a02`. Black-box product
  re-review: APPROVE. Code/security re-review: in flight. Merge happens only on
  dual approval of that exact SHA.

## Role routing (this harness)

The skill's RLM selectors are mapped to what is actually available here:

| Skill role                 | This harness                                                    | Notes                                                                                                                                                 |
| -------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Coordinator                | Main session (Fable)                                            | Owns merges, worktrees, ledger, user gates                                                                                                            |
| Implementer attempts 1–2   | Opus workflow agent directing `codex exec -m gpt-5.6-sol`       | Sol writes code given a clear, frozen direction; the Opus agent decomposes, prompts Sol, integrates, tests, commits                                   |
| Implementer escalation     | Opus workflow agent (may keep using Sol with tighter direction) | After 2 rejected rounds, stop and surface to the user                                                                                                 |
| Watcher                    | `codex exec -m gpt-5.6-luna`                                    | Runs after implementation: is asked to run the focused verification commands and return the outcome verbatim; its report ships with the review packet |
| Code/security reviewer     | Independent Opus workflow agent                                 | Same-SHA review; may consult Luna                                                                                                                     |
| Black-box product reviewer | Independent Opus workflow agent                                 | No source-diff review; behavior/tests/artifact only; no UI launches without permission                                                                |

Unavailability rule (from the skill): if `gpt-5.6-sol` or `gpt-5.6-luna` stop
resolving via Codex CLI, report it and fall back to Opus for that role — never
silently substitute a different provider while claiming otherwise.

## Standing constraints (unchanged)

- Dual approval on the same exact commit SHA; any new commit invalidates prior
  approvals; rejected/stale SHAs are never merged.
- One milestone per branch `dev/prime-agent-perfect-integration-20260813/<task-id>`,
  implemented in an isolated worktree.
- UI launches (browser/Electron/simulator), screenshots, video: permission-gated;
  absence is reported truthfully, never faked.
- Security boundaries from `docs/prime-agent-integration-status.md` §Desired
  feature apply to every milestone. The PA-M06 debt in `security-fidings.md`
  must not spread.
- Focused tests and typechecks only (AGENTS.md forbids repo-wide runs). Known
  pre-existing failures (ProviderCommandReactor concurrent-turn assertion, three
  web typecheck diagnostics, server typecheck OOM) are not blockers but must be
  re-confirmed as pre-existing whenever touched files overlap.

## Execution order

1. **PA-A02 gate (in flight).** Await the code/security re-review of
   `e52a7e0f`. On APPROVE: merge to `main`, remove worktree/branch, update the
   status doc. On REJECT: repair and repeat the same-SHA gate.
2. **PA-A02.1 — review-debt cleanup (small, new).** Batch the accepted
   non-blockers from both PA-A02 review rounds so they do not leak into A03:
   - runtime-action send button label reflects the actual selected mode (and
     no selection) instead of defaulting to "Send steering";
   - cancellation copy derived from `followUpCancel` instead of hard-coded;
   - web composer surfaces `primeSendDecision.reason` inline while typing
     (mobile parity);
   - mobile disabled runtime-action buttons get disabled styling;
   - `PrimeActionState.active` rendered by `renderPrimeQueue`;
   - artifact convergence assertion made falsifiable (derive client B's
     projection independently rather than from the same frozen array);
   - snapshot coalescing: drop byte-identical `session_action_update`
     persistence (plan's "coalesced updates" line);
   - crash-restart display path: surviving `running` rows with populated
     `action_state_json` must not show queued items for a dead provider
     session.
     Same dual-review gate as any milestone.
3. **PA-A03 → PA-A08** sequentially, each through the workflow below.
4. **Beta order: PA-B01, PA-B03, PA-B02, PA-B04, PA-B05, PA-B06.**
5. **Final audit** of all 30 milestones, security constraints, artifacts, and
   documentation graduation before declaring the integration complete.

## Orchestration workflow

Saved at `.claude/workflows/pa-milestone.js`; invoked once per milestone with
`args: { milestone: "PA-A03", baseSha: "<current main SHA>" }`.

Phases (mirrors the skill's task loop):

1. **Prepare + Implement** — one Opus agent in an isolated worktree: branch from
   the given base, read the frozen milestone contract, direct Sol
   (`codex exec -m gpt-5.6-sol`) for code authoring, add focused tests, build
   the runnable artifact, run the milestone's focused verification, commit, and
   return the exact SHA plus evidence.
2. **Watch** — Luna (`codex exec -m gpt-5.6-luna`) is asked to run the focused
   verification commands at that SHA and return the outcome; the verbatim
   report joins the review packet.
3. **Dual review** — two independent Opus agents in parallel on the exact SHA:
   code/security and black-box product. Either may consult Luna. Verdicts are
   APPROVE/REJECT with BLOCKER/NON-BLOCKER findings and evidence.
4. **Repair loop** — on any REJECT, a repair agent fixes blockers (escalating
   direction to Sol), commits a new SHA, and both reviews rerun. Maximum three
   rounds per invocation; the workflow then stops and reports the blocker to
   the coordinator instead of merging.
5. **Handoff** — the workflow never merges. It returns the ledger (SHAs,
   verdicts, evidence); the coordinator merges after verifying dual approval,
   runs the smallest post-merge proof, updates the status doc, and cleans up
   the worktree/branch.

Ledger columns per the skill: task, dependencies, branch/worktree, attempt,
implementer, commit, review A, review B, merge.
