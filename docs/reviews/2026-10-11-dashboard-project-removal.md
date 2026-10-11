# Dashboard project removal validation

Scope: database-only deletion, no filesystem or OpenCode session removal.
Plan: `docs/superpowers/plans/2026-10-11-dashboard-project-removal.md`.

## Verification so far
- Backend RED: unimplemented preview/removal; all-project auxiliary data,
  concurrent new team, stale token, typed-name mismatch, rollback and host faults.
- HTTP RED: missing routes returned 404 instead of preview/same-origin rejection.
- UI RED: missing interaction and action; generated production scripts then run
  in VM to assert counts, blocked submission, exact typed-name confirmation and
  escaped IDs.
- History ownership RED: purged team notification count missing; additive migration
  captures team ownership before purge and includes that history in project deletion.
- Full suite pre-review: 943 passing, 0 failed; typecheck/build pass.

## Runtime envelope
runtime_verification: { surface: screen, verdict: works_as_specified }

Disposable dashboard on 49198, scratch database and Chrome profile; no user
server restarted/stopped. `project-removal-runtime.ts` drives Chrome through CDP:
open active project → blocked with confirm disabled; cancel → preview archived
project → type name → submit → dialog closes and the remaining project stays.
Direct SQLite query verifies deleted project's message is absent and unrelated
project remains. Chrome and dashboard created by this bounded harness are closed
by its own finally; no shared host processes are touched.

Evidence (external, not committed): `project-removal-runtime.log`,
`project-removal-blocked.png`, `project-removal-preview.png`,
`project-removal-complete.png` under the scratch directory.

Not covered: actual paid/model turns; host restart/hot-reload; arbitrary external
writers to preserved files; multiple browser engines; physical file compaction.

## References
- Native modal behavior: https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/showModal
- Reusable SQLite pages vs VACUUM: https://sqlite.org/lang_vacuum.html
- Bun WebSocket client used by runtime harness: https://bun.sh/docs/runtime/http/websockets

## Independent review
Pending final Fable 5.1 review. No approval is claimed until its result is recorded.
