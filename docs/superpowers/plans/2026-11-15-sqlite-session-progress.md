# Implementation ledger — plan: docs/superpowers/plans/2026-11-15-sqlite-session.md

## Scope and execution

User chose SQLite for local single-user use, then explicitly said “直接实现”. Implemented inline on the existing feature branch without another approval question. Raw Runtime evidence, session research context and checkpoints remain files; Web metadata is persisted in the ignored `runtime-results/web.sqlite`. No real supplier request, deployment or push was issued for this milestone.

## Completed work

1. SQLite repository: projected answers, exact amount strings, session/job/reference relationships, prepared statements, atomic acceptance/finalization, FK constraints, WAL, schema migration and process ownership. Six initial storage tests failed before the module existed, then passed. Runtime callback identity failed with an undefined runId before the callback was extended, then passed. Commit `b226830`.
2. HTTP persistence and lifecycle: durable acceptance before execution, early Runtime binding, bounded file readers, SHA-256 query references, historical import, startup reconciliation and explicit recovery using the existing checkpoint validator. Restart regression failed with a missing session before integration. SQL import-failure and history ordering regressions also failed before their fixes. Actual SIGKILL subprocess tests passed both with and without a recoverable checkpoint. Commit `494eb2a`.
3. UI: truthful local persistence copy, Web-only interrupted status, recovery control without a fabricated answer, bounded-history hints and import warnings. A browser assertion for persistence copy failed before UI changes. The final browser acceptance uses actual local HTTP, SQLite and Pi Runtime; only upstream model/data responses are offline fixtures in temporary directories.

## Independent review and fix pass

Fresh review found three issues. Seven focused regressions were observed failing before the fix pass, then passed; the reviewer independently reran those seven and confirmed no residual actionable issue in the fixes.

- Final SQLite result write could fail after Runtime had completed; the task was marked failed and never reconciled. Startup now also checks bound tasks without committed results, and failed bound tasks can expose valid checkpoints.
- Duplicate query IDs or an oversized projected historical result could be mistaken for a database failure and block startup. Source identity/uniqueness/size validation now runs before entering storage; malformed source entries are skipped, while actual SQL failures remain fatal and retryable on restart.
- Recovery checked query/checkpoint paths but other dependencies could follow symlinks. Checkpoint/ENS loaders now accept a bounded reader, and Web recovery applies its path policy to every dependency, including ENS proofs, parent checkpoints and terminal summaries.

## Verification evidence

- Root `npm test` on Node 24.22.3: 271 tests, 269 passed, 2 optional tokenizer skips, zero failures.
- Exact minimum Node 22.19.0: the same 271 tests, 269 passed, 2 optional skips, zero failures.
- Root and data-validation typecheck passed. Front-end build and 7 local tests passed.
- Original demo: 16 browser checks passed. Live offline transport/evidence race/mobile checks passed.
- `npm --prefix apps/research-prototype run test:persistence`: subprocess restart retains history and exact evidence; historical follow-up has zero data HTTP; SIGKILL becomes interrupted and manual recovery reuses the completed data; mobile evidence drawer preserves precision without overflow. Browser errors: none. Report and inspected screenshots: `docs/design/qa/sqlite-persistence-results.json`, `sqlite-offline-interrupted-desktop.png`, `sqlite-offline-evidence-mobile.png`.
- Actual local history was imported with **4 sessions and 10 visible Runtime results**, zero skipped malformed records. The service was restarted again; the complete visible history digest, original Web job references and exact balance evidence matched. Read-only Chrome verification opened the restored actual history and exact wei panel without browser errors. No new model/chain-data requests were made. Ignored evidence: `runtime-results/sqlite-local-verification.json`, `runtime-results/sqlite-restored-history.png`.

## Implementation rulings

- Continued in the user's existing `feat/web-ui-prototype` checkout to honor direct execution and preserve the local preview. This does not add a separate worktree's isolation if unrelated changes arrive.
- Extended initial schema 1 to schema 2 for evidence SHA-256 fingerprints. Migration backfills old references from Runtime summaries before serving; this costs additional one-time local reads.

Deferred minor review findings: none. Earlier history is retained but the current UI deliberately shows only 30 sessions / 20 turns; history search and pagination remain outside this scope. Physical mobile keyboards and assistive screen readers were not tested.
