# V2 runtime contract verification

## Scope and environment

Requested alongside a Fable 5.1 adversarial review of `main...feat/vfeitoza`
at `8447e81`. OpenCode host `2.0.26` was queried on a separate loopback server
with isolated HOME/XDG directories and databases. The user's active service,
configuration, teams, and worktrees were not stopped, restarted, or modified.
Tests used the real host APIs, not the older SDK's structural mocks.

Evidence stays outside the repository under `/tmp/opencode/ensemble-load-proof`:
`runtime-contract-checks.json`, `runtime-worktree-checks.json`,
`runtime-all-member-permissions.json`. Scripts are
`ensemble-runtime-check.py` and `ensemble-worktree-check.py` under
`/tmp/opencode`. The scratch server remains running; no server termination was
authorized. Temporary session model IDs were not used for inference.

## Results

### Permission enforcement — works for this host

Created a temporary session with the same read-only permission shape used by
Ensemble: deny `edit`/`shell`, allow the 9 member tools and `execute`.
Switched to `explore` and `plan`, then called the host's
`session.permission.create` evaluation endpoint for every action.

- `edit`, `shell`: **deny**, for both agents.
- `team_message`, `team_broadcast`, `team_tasks_list`, `team_tasks_add`,
  `team_tasks_complete`, `team_claim`, `team_results`, `team_status`,
  `team_view`, `execute`: **allow**, for both agents.
- `PATCH /api/session/{id}` with the same permission rules returned 204;
  subsequent evaluations retained the intended effects.

These are server-evaluated decisions, not permission-array echoes. The current
comment/warning asserting that absence of `permission.rules` necessarily loses
agent team tools is not supported on this tested runtime. This does not prove
behavior on all V2 releases or visibility of tools in an actual model request.

### Worktree operations — plugin adapter does not meet the host contract

- `POST /api/worktree` with the adapter's `{name}` payload returned HTTP 400:
  `Missing key at ["projectID"]`.
- Adding the actual scratch project ID returned HTTP 200 and created a real
  Git worktree. The bundled host strategy produced **detached HEAD**:
  `git branch --show-current` was empty.
- There was no Git ref named after the requested worktree. Therefore the
  adapter's `branch = gitBranch(directory) ?? name` is not a valid proof of a
  branch available for preservation or merge.
- Creating a host session with `location.directory` equal to the real worktree
  returned that same location on session readback. Direct API directory binding
  works; this does not validate Ensemble's workspace bridge.

**Verdict:** `does_not` for current Ensemble worktree API mapping.

### Model selection — stored selection verified, inference not verified

`switchModel` accepted provider/model/variant and `session.get` returned all
three fields. No provider request was made. This verifies host persistence only,
not the model used by an Ensemble spawn or variant transport in its adapter.

### Notifications and interruption — inbox survives interrupt

A synthetic notification was submitted with queue delivery and `resume:false`.
The inbox list contained it. Interrupting with `resume:false` did **not** remove
the notification or the host's plan-mode reminder from the inbox.

Thus an empty Ensemble message table after purge does not prove there are no
previously queued host notifications. The `notifyLead` guard prevents new
notifications for archived teams; it does not cancel already admitted inbox
items. The full reported ghost-notification reproduction is not proven fixed.

The production `executeTeamCreate`, `executeTeamMessage`, `executeTeamResults`,
and `executeTeamCleanup` functions were also exercised against the scratch DB,
with deliveries routed to the real host inbox and inference disabled.
The message persisted and results returned its content. After archive and
confirmed purge, `team_message` was empty but the same `[System: New team
message from worker]` inbox item remained. Evidence:
`runtime-lifecycle-check.log`, produced by `ensemble-lifecycle-check.ts`.
This proves stale queued notification retention, not repeated model redelivery.

The public `session.inbox.cancel` operation was characterized separately with
two owned scratch notifications: both were admitted in queue order; cancelling
only the second returned HTTP 204 and left the first intact. A possible fix
should track notification ownership/IDs and cancel only Ensemble-owned items,
never arbitrary user inbox entries. Evidence: `runtime-inbox-cancel-check.json`.

### Branch preservation — standalone reference works in scratch repository

After the host created a detached checkout, a standalone preserved ref was
created from its actual HEAD commit. It still existed after interrupt. This
characterizes Git preservation by commit only; the plugin currently expects a
branch and has not been verified to preserve detached teammate commits.

## Automated validation

Fresh `bun run typecheck`, `bun test`, and `bun run build` completed successfully
on the aggregate branch. The full suite reported **877 pass, 0 fail**.
No TypeScript or build errors were reported. Green mocks do not override the
runtime worktree-contract failure above.

## Terminal rendering verification

A disposable TUI client connected to the isolated server and scratch
`sidebar-proof` lead session through a pseudo-terminal sized 140x40.
Captured output rendered `Ensemble: sidebar-proof`, `Tarefas abertas:`,
`□ [pending] Greeting proof`, `responsável: não atribuído`, and
`tasks: 1 open / 1 done`. The client exited normally via Ctrl+C with code 0;
neither server was stopped. Evidence: `tui-screen-raw.txt` and
`tui-screen-text.txt`, generated by `ensemble-tui-screen-check.py`.
This is a text terminal render capture, not a browser/desktop screenshot.
A second disposable client opened a known scratch session outside any team:
it rendered `Ensemble: no active team` and no open-task section. Evidence:
`tui-no-team-raw.txt` and `tui-no-team-text.txt`; client exit code was again 0.

## Not covered

- Actual model turns using team tools; tests confirmed permission decisions but
  did not dispatch inference. Scratch sessions report zero token usage.
- End-to-end spawn, editing, shutdown, merge, recovery, and purge against the
  live host as a complete workflow. Message/results/archive/purge persistence
  were exercised separately without model execution or spawned teammates.
- Effective variant selection by Ensemble rather than direct API selection.
- Responsiveness for large task boards and native session navigation.
  The small-board happy-path terminal render was exercised as described above.
- Behavior on other host releases or operating systems.

**Overall verdict:** not ready to claim 100% V2 compatibility or mandatory
Ensemble orchestration for all work. Fable review is tracked separately.

## Follow-up correction scope suggested by runtime evidence

1. Pass the actual location's project ID to every worktree operation. Test
   create/list/remove/refresh on the real contract, including a missing project
   failure, rather than guessing endpoint support from an old SDK.
2. Establish an actual teammate Git branch in a detached worktree before
   advertising branch isolation, or preserve/merge by an explicitly tracked
   commit ref. Do not invent branch names when branch discovery fails.
3. Bind spawned sessions directly to the verified worktree directory. Verify
   session readback instead of relying on a prompt CWD instruction.
4. Track and cancel owned Ensemble notification inbox IDs during archive/purge;
   do not clear the lead's entire inbox or cancel user messages.
5. Replace unsupported permission-loss claims with capability/runtime evidence,
   and test both native `rules` and a verified session-update path if retained.
6. Verify the selected model and variant through the shared adapter before any
   model-driven smoke test, then obtain approval for paid/provider execution.

This verification session did not implement these runtime behavior changes.
