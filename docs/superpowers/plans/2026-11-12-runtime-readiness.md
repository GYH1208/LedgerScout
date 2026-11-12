# Runtime Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct diagnostic codes and verify real compaction / explicit recovery before date-window work.

**Architecture:** Keep current Pi runtime, evidence protocol and string-compatible error classification. Real acceptance uses the production runtime and adapters with bounded cancellation and assertions.

**Tech Stack:** TypeScript, Node.js 24, npm workspaces, DeepSeek, Alchemy, Etherscan.

**Spec:** docs/superpowers/specs/2026-11-12-runtime-readiness-design.md

## Global Constraints

- Windows tokenizer installation deferred; no new dependencies.
- Preserve all existing limits, readonly authorization and evidence redaction.
- Work inline on feature branch; no worktree created, no push or merge.

## Review Focus

- Provider quota exhaustion must not consume a different runtime termination path.
- Repeated pageKey is an invalid response, never an auth failure.
- Partial pagination retains the accurate error code and existing records.
- Resume keeps a fixed snapshot and cumulative request counts.
- Real acceptance must distinguish provider failures from completed scenarios.

### Task 1 Error classification

Files: packages/chain-data/src/queries.ts; packages/chain-data/test/queries.test.ts.
Interface: errorCode(error: unknown): string and QueryResult.error.code remain unchanged.

- [x] Add table regressions for quota, invalid pageKey, auth, rate limit, local budget, cancellation and timeout; add real QueryService partial-page regression.
- [x] Run `npx tsx --test packages/chain-data/test/queries.test.ts`, observe expected wrong-code failures (7 failures).
- [x] Narrow ambiguous classifier rules; preserve transport retry decisions.
- [x] Run targeted tests (25/25) and `npm test` (125 pass / 2 optional skips); verify no failures.

### Task 2 Real acceptance

Files: packages/agent-runtime/scripts/verify-live.ts; docs/runtime-integration.md.
Interface: production runAgent, createDeepSeekRequest, loadRuntimeConfig.

- [x] Build a bounded acceptance script exercising true provider calls, real summary, cancellation and explicit recovery.
- [x] Run with local process proxy configuration; inspect saved run summaries, events and original query evidence (3 scenarios passed).
- [x] Record exact successful/failed scenarios and usage, without copying credentials.
- [x] Run `npm run typecheck` and `git diff --check`.

Date implementation receives a separate spec after the user chooses the proposed approach and time semantics.
