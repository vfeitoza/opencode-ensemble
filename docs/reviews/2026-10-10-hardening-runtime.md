# Hardening runtime evidence

Native execution of the approved lifecycle plan, base `8447e81`, implementation
branch `test/v2-lifecycle-integration` at `e9b1ecd`. The user's checkout and
shared server have not yet received these changes. No push/PR or server stop.

## Verified

- Fresh typecheck/build and full suite: 910 passing tests, zero failures.
- Real host API adapter created two isolated named Git branches and performed
  project-scoped list/refresh/remove on scratch resources.
- Production spawn functions used the real host session/worktree APIs with
  inference disabled for the test. Parent location inheritance was detected;
  moving the child to its own checkout and reading location back passed.
- Two workers were registered; worker A committed a scratch file, preserved its
  HEAD, shut down, and merged the file into the lead checkout. Worker B preserved
  its own branch independently.
- Production message delivery carried deterministic owned inbox ID/metadata.
  Archive removed that notification while leaving the unrelated synthetic input
  intact. Confirmed purge removed the scratch team's DB records.
- Unit tests reproduce late admission after close/purge, cancellation failures,
  foreign/user input protection, legacy ambiguity, and CLI identity mismatch.
- Transaction rollback exercised on Bun and on the bundled database adapter in
  Node `24.21.0`; a duplicate-key failure left zero rows. Separate-process writer
  lock test passed on Bun.

## Findings during integration

- Child creation with a parent inherited the lead's directory in this host;
  the adapter now performs public session.move and verifies location before
  prompt admission.
- The initial cold-TUI capture was falsely classified as loading-only because
  terminal delta writes omitted spaces in updated words. The settled capture
  did contain the team/task/owner/counters; state publication was verified.
  Session-only tracking avoids dependencies from cache fetches. A 101-task
  hostile Unicode board then revealed excessive wrapping: task lines now use
  no-wrap truncation and a real terminal capture showed `+96 tarefas abertas`
  and the full `101 open / 1 done` counter with only five task rows.
- Existing tests with fake worktree paths now use an explicit preservation port;
  real Git fixtures verify preservation business logic and dirty/ref failures.
- The optional inbox bridge uses read-only service discovery and an explicit
  authenticated CLI server target. It never calls Service.ensure/start. It must
  answer a per-instance nonce at the plugin location before every inbox operation.
  Standalone servers without native inbox remain capability-blocked unless a
  verified explicit bridge is provided; no guessed URL/port is allowed.

## Evidence outside the repository

`ensemble-worktree-runtime.log`, `ensemble-hardening-runtime.log`,
`ensemble-hardening-tests-final.log`, `ensemble-hardening-lint-final.log`,
`ensemble-hardening-tui-proof.log` under `/tmp/opencode`. The scripts and
scratch HOME/database/resources stay isolated and are not published.

## Not covered

- Paid/model inference, effective model/variant selection during an actual LLM
  turn, and full provider-driven teammate interaction. Test prompt transport
  admitted synthetic inbox work with resume disabled instead.
- Cross-version/OS behavior and legacy inbox items without ownership evidence.
- Cold/small-board and 101-task TUI screens passed; final Fable review returned
  changes required and the adjudication/correction pass is recorded separately.
- Late spawn-resource automatic orphan cleanup is conservative: owned records
  remain durable; unidentified/dirty resources are not destroyed automatically.
