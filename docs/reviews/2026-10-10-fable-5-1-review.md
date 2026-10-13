# Fable 5.1 review and evidence reconciliation

## Review provenance

- Model: `servtec/claude-fable-5-1`, independently dispatched read-only.
- Session: `ses_ed8445311ffeCufoKPe3N5uNAJ`.
- Range: `main...feat/vfeitoza`, base `269207e`, head `8447e81`.
- Returned coverage: **24 files reviewed, 0 skipped**.
- Reviewer ran typecheck and tests: **877 pass, 0 fail**. Reviewer did not run
  build or live-host verification.
- Original verdict: `safe_to_commit`, `pass_with_observations`, with 0 Blocking,
  2 Should fix, and 4 Nit. This is not approval of complete V2 compatibility.

## Reviewer file coverage

All reviewed: `README.md`, `docs/VALIDATION.md`, `index.ts`, `package.json`,
`rpc.ts`, `src/notify.ts`, `src/rpc.ts`, `src/tools/team-spawn.ts`,
`src/tools/team-tasks-add.ts`, `src/tui-context.ts`, `src/tui-view.ts`,
`src/tui.tsx`, `src/v2-client.ts`, `src/v2-setup.ts`,
`test/local-entrypoints.test.ts`, `test/purge-notifications.test.ts`,
`test/tools/team-spawn.test.ts`, `test/tools/team-tasks.test.ts`,
`test/tui-context.test.ts`, `test/tui-view.test.ts`, `test/v2-client.test.ts`,
`test/v2-setup.test.ts`, `tsconfig.json`, `tui.tsx`.

## Findings returned by Fable

| ID | Original grade | Location | Reviewer claim |
|---|---|---|---|
| SF-1 | Should fix | `src/v2-client.ts:130-138` | Skipping absent `permission.rules` leaves read-only agents without 9 team tools. Mocks do not prove effective host permissions. |
| SF-2 | Should fix | `src/v2-setup.ts:207`, `src/rpc.ts:70` | Returning `openTasks: []` for a non-team session enables session/team enumeration. |
| N-1 | Nit | `src/tools/team-tasks-add.ts:25-62` | Dependency validation and insertion lack a transaction; alleged concurrent-call TOCTOU. |
| N-2 | Nit | `src/tui-context.ts:37-39` | Default-location fallback can route to the wrong project when session/companion locations are missing; sidebar suppresses RPC errors. |
| N-3 | Nit | `src/tools/team-spawn.ts:450-451` | Explicit `worktree:false` does not produce the failure-isolation warning. |
| N-4 | Nit | `src/rpc.ts`, `src/tui.tsx` | Unbounded open-task descriptions/rows can overwhelm sidebar layout. |

The review called local entrypoints, TUI RPC location, open-task filtering,
dependency validation, and archived-team guards acceptable. It treated the
remaining worktree and permission problems as host limitations rather than
blocking the overall compatibility claim.

## Reconciliation with independently collected runtime evidence

This is evidence adjudication of the returned review, not a second model's
replacement code review. See `2026-10-10-v2-runtime-verification.md` for real
host requests, effects, terminal output, and explicit limits.

### SF-1 — asserted permission loss is not reproduced on this host

The host's actual permission-evaluation endpoint returned deny for edit/shell
and allow for all 9 member tools plus execute, after switching to explore and
plan. This contradicts the specific assertion of permission loss on tested
OpenCode 2.0.26; it does not establish tool visibility during inference or all
other V2 versions. Retain the need for integration coverage and correct the
unsupported blanket comments/warning. Do not introduce a permissive workaround
solely to satisfy this finding.

### SF-2 — claimed new enumeration vulnerability is not demonstrated

The earlier response already distinguished an active team through `team` and
`members`. The new empty array contains no team/task data and adds no distinct
team-existence signal to a `team:null` response. No concrete unauthorized actor,
authorization bypass, or additional disclosure was shown. Do not remove the
empty-list response as a security fix on this evidence alone.

### N-1 — proposed Promise concurrency trigger is not demonstrated

The shared tool body performs synchronous SQL and has no await between
validation and insertion, so Promise calls in the same JS process do not
interleave there. Cross-process mutation and partial batches on SQL errors
remain separate risks worth testing; a transaction may be appropriate, but
the review's described same-process reproduction is not established.

### N-2 and N-4 — retained follow-up risks

Fallback locality/error visibility and large-board density warrant explicit
tests and UX handling. The small-board terminal render passed; this does not
cover large descriptions/boards or missing location cache recovery.

### N-3 — intentional behavior, optional clarity improvement

Explicit `worktree:false` requests shared-directory operation. It is not itself
a failed isolation attempt. Reporting shared state more clearly can help, but
the lack of a failure warning is not proof of an error.

## Runtime issues missed or undergraded by the review

1. **Required correction:** the adapter's worktree create payload omits
   `projectID`; the real host returns 400. This is plugin contract mismatch,
   not proof of an absent host endpoint.
2. **Required correction:** the bundled host worktree strategy produces
   detached HEAD. The adapter falls back to a requested branch name for which
   no Git ref exists, undermining subsequent preserve/merge operations.
3. **Required correction:** archived/purged notification guards do not cancel
   already admitted host inbox items. A production-function archive/purge test
   removed Ensemble DB rows but left the original notification in the host
   queue. Repeated model redelivery was not exercised.
4. **Still unverified:** complete Ensemble spawn/worktree binding/merge flow,
   effective model inference/variant selection, and model-visible team tools.

## Consolidated verdict

The local plugin/TUI improvements are verified for their tested surfaces, but
**do not approve a 100% V2 compatibility claim or mandatory universal Ensemble
orchestration yet**. The real worktree mismatch and retained inbox notification
require corrections and regression/integration tests. Fable's original
`safe_to_commit` verdict must be read with those runtime limitations, not as a
release or universal-use approval. This session made no production-code fix,
push, PR, or shared-server restart.
