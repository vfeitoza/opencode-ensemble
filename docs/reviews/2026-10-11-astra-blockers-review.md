# Astra blocker correction review

Reviewer: `servtec/gpt-6-astra`, session `ses_ed5a385d4ffeVPqKd9Lz7GB5Cc`.
Range: `59cbcf2..86984ab`. Coverage: 27 files reviewed, 0 skipped.
Initial verdict: **needs_changes**, four Blocking and two Should fix.
This is the original review verdict, not a post-fix approval.

## Correction pass

1. Broadcast reactivation during cleanup: reproduced with the existing tool
   firing inside workspace.remove; before the fix `removeWhileRunning=true`.
   Broadcast now checks admission, member message/broadcast deliveries retain a
   durable in-flight admission until transport settles, pending admissions block
   destructive tools, and execution is rechecked immediately before removal.
   Nudge/recovery delivery paths skip teams in cleanup.
2. Purge path identity: it now rechecks execution and validates identity before
   actual workspace/worktree removal, rather than relying solely on inventory.
   Regression proves legacy identity absence leaves checkout and team intact.
3. Event-triggered interrupt: same verified host-capability gate as tool shutdown;
   event interruption also acquires shared lifecycle ownership and preserves
   again before interrupt. Unknown host regression asserts zero interrupt calls.
4. Branch-null snapshot: cleanup always consumes the preservation result. A
   persisted merged_head distinguishes no new work from a post-merge commit.
   Real Git regression covers merge A, commit B, cleanup merging B. Final host
   runtime also proves retry does not remerge an unchanged already-merged HEAD.
5. Dead spawn admission: lifecycle acquisition removes admissions only when the
   recorded owner is definitively no longer alive. Test uses an exited child
   process; live/unverifiable/PID-reused owners are not displaced.
6. Uncancellable public wait: the pinned SDK ignores request options. A single
   waiter per session is reused instead of creating one abandoned waiter on each
   retry; bounded observation still returns unknown and blocks deletion. This
   does not claim the host's underlying wait is abortable.

## Intentional conservative boundaries

- Legacy checkout identity is not invented retrospectively. Such work is
  retained for explicit recovery rather than automatically deleted.
- Unknown execution or unverified destructive interrupt behavior blocks cleanup.
- Process liveness signal 0 is a read-only check, not process termination. No
  server was stopped/restarted in this execution.
- Admission/ownership guards protect Ensemble-initiated work; arbitrary external
  tools modifying a checkout are outside that coordination model.
- Paid/model inference was not executed. Tests use public APIs with queued
  synthetic prompts and deterministic writers in scratch repositories.
- Earlier advisory findings outside B1–B5 are not implicitly marked fixed.

See `2026-10-11-astra-blockers-runtime.md` for RED reproductions and actual host
evidence. Final typecheck/suite/build results are recorded on delivery.

Post-fix full gate in the implementation worktree: **932 tests passed, 0 failed**;
typecheck and build passed. Lint introduces no errors; preexisting warnings are
reported separately. No second reviewer approval is claimed.
