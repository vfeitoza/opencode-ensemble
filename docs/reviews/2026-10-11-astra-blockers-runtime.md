# Astra blockers: reproduction and runtime verification

Base: `59cbcf2`. Work is isolated until final validation/review and integration.
This report describes evidence, not universal host compatibility.

## RED reproductions against existing behavior

| Blocker | Existing behavior reproduced | Corrected assertion |
|---|---|---|
| B2 | Interrupt rejection closed the real async event iterator before Bob's idle event; Bob remained busy. | Per-event containment processes Bob and keeps Alice recoverable. |
| B3 | Removed linked checkout replaced by an empty directory was accepted; Git discovered the lead ancestor. | Persisted checkout identity rejects reused path, no ref/DB overwrite. |
| B4 | Cleanup accepted shutdown_requested and removed its worktree before host confirmed idle. | State is not proof; execution must be confirmed idle/missing before removal. |
| B5 | SessionNotFound in inbox list broke preview; first failed notification scope prevented the next from cancelling. | Typed terminal absence handled; subsequent scopes attempted and failures returned. |
| B1 | Inbox failure caused team archived + registry removed. | Team remains active and registry intact; retry state persists until success. |

RED tests were written against the production functions before their fixes,
not only newly introduced helper stubs. Baseline and targeted/full test logs are
under `/tmp/opencode/astra-*.log`.

## Real host characterization and integration

A new disposable host on loopback port 49188 uses HOME/XDG under
`/tmp/opencode/astra-runtime-home`. The previous scratch host was already not
listening. The user service was never stopped/restarted. Production functions
were run with real session/worktree APIs and an isolated Ensemble database.
The prompt transport queues synthetic input with resume disabled: no paid or
model inference was performed.

Evidence `astra-blockers-runtime.log` records:
- Two workers with distinct real worktrees and named refs.
- Session directory binding and a committed worker file.
- Preservation, shutdown and merge into scratch lead checkout.
- An injected inbox failure leaves team active and registry present.
- Retrying cleanup succeeds; the unrelated inbox entry survives owned cancellation.
- Confirmed purge deletes the scratch team.

The first integration run exposed redundant remerge of a member already merged;
this was retained as a final-fix-pass item, not silently reported as success.
The final run (`astra-blockers-runtime-final.log`) passed without that remerge:
`merged_head` skips only the identical already-integrated commit. A real Git
regression separately commits B after integrating A and verifies B reaches the
lead through the safety-net merge.

`astra-missing-inbox.json` and `astra-missing-inbox-cli.txt` characterize deletion
of a disposable session: remove returned 204, inbox list returned 404 with exact
`_tag: SessionNotFoundError`, and the CLI returned structured JSON on stdout plus
HTTP status on stderr. Generic 404 text alone is not used as proof of absence.
The production notification helpers were then called against that actual removed
session: ambiguity count was 0, reconciliation processed one scope with no
failures, and its durable owned notification transitioned to cancelled without
issuing a cancel request to any other session.

The bundled database adapter was also initialized on the installed Node runtime:
schema version 16 and all cleanup/operation/admission tables were created. This
checks migration initialization on Node, not a complete Node host lifecycle.

## Limits and policy

- Confirmed stop capability is required; unknown execution blocks destructive
  operations. Non-destructive forced interrupt is enabled only for the explicitly
  characterized host release; V1 running workers must finish gracefully if the
  host cannot provide a safe stop boundary.
- Legacy members without persisted checkout identity cannot have their paths
  automatically adopted for deletion. Their data is retained for explicit recovery.
- Concurrent lifecycle ownership uses SQLite and owner process liveness, never
  steals from a live process because of elapsed time. PID reuse can conservatively
  require manual recovery rather than grant unsafe ownership.
- Model inference and arbitrary external writers are not controlled or verified.
  Git ownership/dirty/HEAD checks apply to managed teammate resources.
- Final independent Astra review and final aggregate checks are recorded in the
  companion review report when complete.
