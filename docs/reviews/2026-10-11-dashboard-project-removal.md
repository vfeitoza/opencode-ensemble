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
An actual Escape key closed the preview without removal. At a 390px emulated
viewport, the dialog measured 352px wide and kept its controls visible; evidence
includes `project-removal-narrow.png`.

Evidence (external, not committed): `project-removal-runtime.log`,
`project-removal-blocked.png`, `project-removal-preview.png`,
`project-removal-complete.png` under the scratch directory.

Not covered: actual paid/model turns; host restart/hot-reload; arbitrary external
writers to preserved files; multiple browser engines; physical file compaction.

Migration runtime (`project-removal-migration.log`): seeded schema 17 with an
existing project/team on SQLite 3.53.2 (Bun adapter); reopening migrated to 18,
backfilled the correct ownership row and a second initialization kept one row.
`PRAGMA foreign_key_check` returned no violations. Node adapter SQLite 3.53.4
also initialized schema 18: ownership survived team deletion and cascaded only
when the project was deleted (`project-removal-node.log`).
Space-reuse characterization (`project-removal-space.log`): 2,000 scratch
messages were counted in preview and removed; SQLite freelist grew from 0 to
706 pages and remaining message count was 0. This is reusable space, not a
physical file-size reduction claim.
The bundled removal service also ran on Node's database adapter: preview of one
archived team followed by removal returned `{ removed: true }`, preserved the
unrelated default project and left no foreign-key violation
(`project-removal-node-service.log`).

## References
- Native modal behavior: https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/showModal
- Reusable SQLite pages vs VACUUM: https://sqlite.org/lang_vacuum.html
- Bun WebSocket client used by runtime harness: https://bun.sh/docs/runtime/http/websockets

## Independent review
Fable 5.1 (`servtec/claude-fable-5-1`), session
`ses_ed527d47affeOTY2i0stCm9aqn`, reviewed `b29d6d3..41a421a`.
Coverage: **15 files, 15 reviewed, 0 skipped**. Verdict: **safe_to_commit**,
0 Blocking, 2 Should fix and 4 Nit. The first transport attempt did not review
code (context marker failure); the self-contained retry produced this verdict.

### Findings and adjudication
- SF1 (request stream): declared oversized bodies now return 413 before reading.
  RED regression withheld body after sending a 20KB Content-Length and previously
  received no response; GREEN gets 413. Stream transport failures map to 400 and
  already-destroyed responses are not written. No database work begins before
  complete validated JSON.
- SF2 (expired confirmation retention): regraded Minor. Expired tokens cannot be
  used, are pruned on preview, and the map is capped at 128. A per-token timer adds
  no correctness/security benefit; retained until the next preview/removal or
  dashboard disposal. Deferred idle-memory optimization, not an authorization gap.
- N1 (unknown peer): intentional fail-closed local access; no bypass introduced.
- N2 (proxy CORS additions): outside application control; mutation endpoint itself
  emits no CORS and still enforces origin/instance-token.
- N3 (history schema): source IDs are validated by existing schema and triggers;
  old unowned records remain deliberately unattributed. No defect demonstrated.
- N4 (VACUUM docs style): existing reusable-space warning is accurate; extra
  auto-vacuum explanation deferred.

### Final gate
After the correction pass: **944 tests passed, 0 failed**, typecheck/build pass,
lint 12 warnings/5 infos (baseline). Browser runtime repeated successfully after
the pass. No second independent review approval is claimed for the tiny stream
correction; the original review already allowed commit.
