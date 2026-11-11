# Run Resume Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline; routine design/execution delegated by user.

**Goal:** Explicitly resume bounded read-only runs without repeating completed tools or resetting budgets.
**Architecture:** Atomic last-model-request checkpoint with saved response/tool results and verified query references. Resume injects the saved response through the same Pi path, then continues with fixed snapshot and cumulative budgets.
**Tech Stack:** TypeScript, node:test, Pi1.5.2, existing file store.
**Spec:** docs/superpowers/specs/2026-11-11-run-resume-design.md

## Global Constraints
- Default no automatic replay; resume requires session and source run, no new input.
- Cumulative8 model/12 tool/32 HTTP/120s ceilings and original smaller limits.
- Atomic persistence before external requests; fixed snapshot once known; evidence hash validation.
- Incomplete query restarts, not page cursor recovery; no multi-process scheduling.

## Review Focus
1. Same-source double resume must not duplicate progress.
2. Truncated checkpoint or modified query evidence must fail before network.
3. Cancellation/crash around query completion must preserve snapshot and budgets.
4. Schema validation and address permissions remain enforced during replay.
5. Terminal successful or exhausted runs cannot be used to reset budgets.

### Task 1: Checkpoint and transport boundary
Files: checkpoint.ts, chain-data/queries.ts,http.ts; tests checkpoint/transport/query.
Interfaces: CheckpointStore save/load verified state, async beforeRequest, initialSnapshot/onSnapshot.
- [x] Add failing snapshot persistence and checkpoint round-trip/corruption tests.
- [x] Implement atomic bounded checkpoint and awaited transport hook.

### Task 2: Runtime recovery
Files: runtime.ts; tests resume.test.ts.
Interfaces: Options.resumeRunId; RunResult.resumeOf. Shared checkpoint saves counts before requests and tool state after completion; source consumed once, child linked.
- [x] Write failing cancel/resume/budget/evidence/terminal integration tests with real Pi.
- [x] Implement replay, cumulative budgets/time and snapshot restoration.
- [x] Verify focused and full tests/typecheck.

### Task 3: CLI, documentation, review
Files: cli.ts,README, integration/progress docs; test cli and subprocess recovery.
- [x] Add CLI contract and real process-interruption tests, observe failures.
- [x] Implement explicit command and document boundaries.
- [x] Independent review; fix material findings with regressions; final tests/typecheck and commit.
