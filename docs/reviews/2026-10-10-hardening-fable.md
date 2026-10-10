# Fable 5.1 final hardening review

Reviewer `servtec/claude-fable-5-1`, session
`ses_ed7fe9e03ffephAUrI9NlbYX46`, range `8447e81..e9b1ecd`.
Coverage: 44 files reviewed, 0 skipped. Original verdict `not_safe_to_commit`:
5 Blocking, 6 Should fix, 3 Nit. Findings were checked against actual code and
runtime, not accepted as guarantees.

## Adjudication and correction pass

| Finding | Decision/evidence |
|---|---|
| B1 V1 without inbox | Confirmed compatibility gap. V1 transport now declares `notificationMode: legacy`; its wakes use original behavior and do not create queued-inbox cancellation obligations. Regression covers no-inbox legacy archive. V2 missing capability still blocks owned cancellation. |
| B2 preservation error in event dispatcher | Confirmed. Catch preserves shutdown_requested and keeps subscription alive; do **not** follow suggested interrupt-after-failure because approved fail-closed invariant forbids abort of unpreserved/dirty work. Regression confirms subsequent events still dispatch. |
| B3 BEGIN failure masks SQLITE_BUSY | Claimed sequence contradicted by code: `BEGIN IMMEDIATE` is outside try, so a failed BEGIN never executes rollback. Added defensive rollback catch for SQLite auto-rollback after an operation failure; original error preserved. Process-lock regression already passes. |
| B4 space/equals shell split | No shell is used: argv stays a single value. Fixture exercises a location containing spaces, equals and ampersand. No demonstrated parsing failure; identity challenge remains required. |
| B5 missing checkout/ref cannot recover | Missing owned commit intentionally blocks destruction; relaxing purge by guessing a branch could lose work. Keep blocker and document manual investigation. An acknowledgement bypass/new tool was not silently added. |
| S1 double preservation/collision | Final reread is intentional to capture commits during shutdown; divergent old tip is independently checked by ancestry plus update-ref CAS. No overwrite demonstrated. Redundant no-change reads acceptable for safety. |
| S2 spawn-resource growth | Registered terminal spawn evidence is removed on successful archive/purge. Timed-out/late ownership remains until actually reconciled; not removed by arbitrary TTL. |
| S3 # invalid Git branch | Refuted by actual Git worktree/runtime: branch names generated with `#` succeeded. Regression now uses `ensemble-test#team-worker`. Do not rename existing branch namespaces without cause. |
| S4 legacy only lead | Report now checks lead and member inboxes, without cancelling items based on text. |
| S5 mock get not a function | SDK requires get; no concrete production missing-method case. Sync failures correctly propagate to loader error; avoid generic fail-open cache fallback. |
| S6 watchdog injection ignored | Source already chooses injected preservation backend in GC and timeout, contradicting finding. Production uses verified Git by default; fixtures use explicit backend. |
| N1 mixed language | Deferred existing presentation convention; not correctness blocker. |
| N2 eval cleanup on failure | Retaining failed scratch resource is safer than unconditional deletion after unknown mutation; exact paths in evidence. Harness remains explicit isolated-only. |
| N3 retention docs | Runtime/plan docs explain registered cleanup versus timeout evidence retained; no claim of automatic unsafe orphan destruction. |

Additional screen validation found and corrected task-description wrapping so
five long Unicode tasks do not hide totals/overflow. Temporary diagnostic writes
were removed from production code.

## Verification limits

All corrections are covered by regressions and a fresh full verification gate.
Model inference was disabled in runtime; actual provider-driven completion and
cross-version/OS equivalence are not claimed. The optional CLI inbox bridge is
available only when it proves the existing managed service is this exact host;
standalone instances without native inbox/verified injected bridge fail closed.
Legacy ambiguity and already missing commits remain explicitly reported, never
treated as permission to delete user data. No blanket 100% compatibility claim.
