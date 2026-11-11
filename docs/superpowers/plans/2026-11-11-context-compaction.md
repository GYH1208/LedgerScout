# Context Compaction Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task-by-task. User delegated execution and routine design decisions; execute inline.

**Goal:** Add honest token accounting and bounded, persistent history summaries.
**Architecture:** Context helpers budget messages and tool schemas; runtime shares one model request gateway between summaries and Pi. Session persists optional summary; evidence remains authoritative.
**Tech Stack:** TypeScript, node:test, Pi 1.5.2, existing DeepSeek adapter.
**Spec:** docs/superpowers/specs/2026-11-11-context-compaction-design.md

## Global Constraints

- Existing 8 model / 12 tool / 32 HTTP / 120 second ceilings remain.
- Context 12000 estimated tokens, 2000 output reserve, 24000 bytes; no tokenizer downloads.
- Summary at 80% capacity, at most once per run; preserve two recent historical rounds.
- Summary <=2000 characters and <=6000 bytes; no tools; use low privilege content.
- No real secrets in tests; no live provider calls required; no auto-resume or long-term memory.

## Review Focus

1. Large tool schemas must count toward capacity (Task 1).
2. Current tool call and result pairs must remain together (Task 1).
3. Summary failure/cancellation must not erase persisted history (Task 2).
4. Summary cannot grant address or historical-evidence permission (Task 2).
5. Missing usage and retried requests must remain visible (Task 2).

### Task 1: Context capacity

Files: context.ts, types.ts, test/context.test.ts.
Interfaces: estimateContext(messages, tools) returns bytes/tokens/method; fitContext accepts optional tools and token allowance while preserving existing byte-limit argument.
- [x] Add failing capacity tests covering tools, Unicode, old-round removal and current tool batch protection; run focused test.
- [x] Implement conservative UTF-8 based token estimate with protocol allowance and full-round fitting; run focused test.

### Task 2: Summary and request accounting

Files: compaction.ts, runtime.ts, session.ts, types.ts, test/context.test.ts, test/runtime.test.ts.
Interfaces: compactHistory takes recent turns, previous summary, budgets, and a bounded summarize callback; returns selected turns/summary and counts. RunResult adds tokenUsage with known totals and unknownRequests.
- [x] Write failing persistent summary, summary failure, exhausted-budget, cancellation, evidence isolation and usage aggregation tests; observe failures.
- [x] Share request timeout/retry/accounting gateway; integrate bounded compaction and programmatic evidence index. Persist optional summary with session turns.
- [x] Run focused tests then npm test and npm run typecheck.

### Task 3: Documentation and review

Files: README.md, docs/runtime-integration.md, plan progress record.
- [x] Document estimate/actual distinction, compaction trigger, shared budget and fallback.
- [x] Review diff against spec; fix material defects with regression tests.
- [x] Verify full suite/typecheck and record results, leave changes reviewable on feature branch.
