# SQLite Session Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Preserve local Web conversations and evidence access across restarts, with explicit checkpoint recovery.

**Architecture:** A SQLite repository owns Web metadata; bounded filesystem readers own access to authoritative Runtime summaries/queries. HTTP keeps only the active controller, starts coordination after binding, and serves existing projected DTOs. Runtime files and its recovery validator remain authoritative.

**Tech Stack:** TypeScript, Node >=22.19 `node:sqlite`, React/Vite, node:test, Playwright. No new service or provider dependency.

**Spec:** `docs/superpowers/specs/2026-11-15-sqlite-session-design.md`

## Global Constraints

- Database: `runtime-results/web.sqlite`; raw evidence/checkpoints remain files and Git-ignored.
- Loopback-only, one active run, exact strings for amounts, unchanged budgets and recovery validation.
- No provider calls on startup/history/evidence; no automatic recovery or in-memory success fallback.
- State retains 30 sessions / 20 turns with explicit truncation hints; no historical data deletion.

## Review Focus

- SQL acceptance failure must precede any provider call; final state and references commit together.
- A second server sharing the database must not interrupt the first owner's jobs.
- Crash between Runtime finalization and SQL completion must reconcile without replaying providers.
- Historical evidence belongs to its original run, not necessarily the displaying turn.
- Corrupt, missing, symlinked or oversized files cannot expose arbitrary paths or manufacture success.

### Task 1: SQLite repository and Runtime identity

**Files:** create `packages/web-server/src/{storage,views}.ts`, `packages/web-server/test/storage.test.ts`; modify Runtime events and exports, add identity regression.

**Interfaces:** `WebStore(path)` owns schema, process lease and transactions; `accept`, `bindRun`, `progress`, `finish`, `interrupt`, `get`, `list`, `refs`, `unfinished`, `hasImported`, `completeImport`, `close`. `views.ts` exports public projections and persisted DTO types. Runtime exports its existing CheckpointStore and emits sessionId/runId with events.

- [x] Write/run RED tests for reopen, exact precision/no raw records, transaction rollback, owner exclusion, schema failure, and >200 durable jobs with bounded views.
- [x] Implement initial schema version 1, then version 2 with evidence hashes; prepared statements, WAL, FK, busy timeout, transactional metadata and owner lease (PID/token; no silent lock takeover from a live owner).
- [x] Add/run RED Runtime identity regression, then extend the existing event callback.
- [x] Run focused tests, root suite and typecheck; commit the independently testable repository.

### Task 2: Durable HTTP lifecycle, import and recovery

**Files:** create `packages/web-server/src/history.ts`, `packages/web-server/test/persistence.test.ts`; modify server/main and existing HTTP test fixtures.

**Interfaces:** `history.ts` provides bounded registered summary/query loading, startup reconciliation/import and checkpoint availability. `createWebServer` retains its HTTP Server shape and exposes a readiness promise; startup runs after successful listening, and shutdown waits for active cleanup before store close.

- [x] Write/run RED tests for API restart/evidence ownership, actual offline Runtime follow-up, crash recovery (with/without checkpoint), staged resume failure and consumed checkpoints, import idempotence, stale SQL terminal, malformed files and failed startup/writes.
- [x] Implement filesystem validation and batched import, reusing original run IDs; add durable acceptance and Runtime event binding. Keep only active controller/task in memory; remove the old 200-job cap.
- [x] Compute resume availability through the existing checkpoint validator, preserve errors and interruption without fake Runtime results, and reject unregistered IDs.
- [x] Run API/Runtime suites and typecheck; commit.

### Task 3: Live UI and full verification

**Files:** modify LiveApp/README/AGENTS; add `scripts/verify-persistence.mjs` and its offline server fixture; update documentation and this plan's ledger.

**Interfaces:** turn DTO may include `recovery: {sessionId,runId}` without `run`; `interrupted` is a Web-only state; state/session truncation flags are optional for compatibility.

- [x] Run a failing browser scenario for persistence copy against the existing UI, followed by interruption/recovery acceptance.
- [x] Add interruption/recovery rendering, bounded-history hints and truthful local-storage copy.
- [x] Verify actual local HTTP + SQLite + offline Pi Runtime in Chrome through a subprocess restart, exact evidence, historical follow-up and mobile view. Run original browser regressions, build, front-end tests, root tests/typecheck and Node 22 compatibility checks.
- [x] Request one fresh whole-change review; fix important findings with RED→GREEN and update evidence. Commit completed work; leave local preview running without deployment or push.

User explicitly said “直接实现”; execute inline without another plan approval or execution-method question. Continue on the current feature branch to preserve the user's active workspace and local preview.
