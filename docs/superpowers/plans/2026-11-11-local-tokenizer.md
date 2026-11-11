# Local Tokenizer Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline. User delegated routine choices and execution.

**Goal:** Count actual DeepSeek request prompts locally with official encodings and an honest estimate fallback.
**Architecture:** Async context measurement accepts optional counter; official Python worker consumes shared DeepSeek wire payload. Optional local setup pins package/assets; CLI manages worker lifetime.
**Tech Stack:** TypeScript, Python3.10+, deepseek-recipe0.2.0, node:test.
**Spec:** docs/superpowers/specs/2026-11-11-local-tokenizer-design.md

## Global Constraints

- Existing hard budgets, bytes limit, output reserve, exact evidence validation unchanged.
- No API secrets/headers to worker. No inference or data HTTP requests for verification.
- Timeout5s with signal cancellation; assets pinned/checksummed, runtime fallback estimated.

## Review Focus

1. Counter failure cannot strand or split a current tool batch.
2. Timeout and cancellation must reap worker and settle pending calls.
3. HTTP/count conversion must agree on tool calls, tool results and disabled tools.
4. Bad or missing assets must not break existing CLI.
5. Actual provider usage and offline template count must remain distinguishable.

### Task 1: Async capacity and wire boundary
Files: context.ts, types.ts, model.ts, compaction.ts, runtime.ts; tests context/model/runtime.
Interfaces: TokenCounter(messages,tools,signal) returns local token metadata; measureContext and fitContextAsync accept optional counter. toDeepSeekMessages/tools shared by model and worker.
- [x] Add failing async budget/counter fallback and shared wire tests.
- [x] Implement async fit and thread through all context decisions, preserve sync helper compatibility.
- [x] Run focused tests and full suite/typecheck.

### Task 2: Official local worker and setup
Files: tokenizer.ts, scripts/count_tokens.py, scripts/setup-tokenizer.py, cli.ts, package.json, gitignore; test/tokenizer.test.ts.
Interfaces: createLocalTokenCounter returns count/close; Python JSONL worker returns id/tokens/encoding/provenance with errors sanitized. setup installs pinned wheel/verified assets in.runtime/tokenizer.
- [x] Add failing worker timeout/exit/cancel and payload validation tests.
- [x] Implement bounded worker and setup; verify real offline encoder fixture counts.
- [x] Wire optional counter into CLI, close in finally; run focused/full tests/typecheck.

### Task 3: Review and documentation
- [x] Document setup, current mapping and offline/provider distinction.
- [x] Independent review, fix important issues with regression tests.
- [x] Run final suite/typecheck and record local smoke evidence.
