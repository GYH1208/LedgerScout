# Flow Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Explain one address's observed per-asset flows and counterparties with exact evidence-backed arithmetic.
**Architecture:** Pure deterministic aggregation over complete retrieved source records; persist derived report in transfer query evidence, expose bounded readonly analysis and evidence paging, render verified fact references.
**Tech Stack:** Existing TypeScript / Node24 / Pi / npm workspaces; no dependencies added.
**Spec:** docs/superpowers/specs/2026-11-12-flow-analysis-design.md

## Global Constraints

- User said directly implement; work inline on feat/address-flow-analysis. No extra design approval or worktree; no automatic push/merge for this new task.
- Reuse existing8model/12tool/32HTTP/120s limits and date-window authorization.
- Exact amounts use BigInt and original units; no cross-asset totals or estimated float sums.
- Tokenizer/ENS/UI remain outside this change.

## Review Focus

- Self and duplicate transfers cannot inflate flows or rankings.
- Missing/conflicting precision or amount cannot be presented as an exact total.
- Same token symbol does not identify the same contract.
- Partial data must remain visibly partial through the final analysis answer.
- Analysis tools must not bypass existing evidence scope or mutate checkpoint-hashed source results.

### Task1 Exact aggregation

Files: packages/chain-data/src/flows.ts; packages/chain-data/test/flows.test.ts; src/index.ts.
Interface: analyzeFlows(query: QueryResult): FlowAnalysis; returns only serializable data, source query identity and recordIds.

- [x] Write literal fixtures for2ETH in/3out=>−1, unsafe integer exactness, separate same-symbol contracts, duplicate/self, missing amount/precision/conflict, partial and peers.
- [x] Run tests RED, implement pure aggregator, run GREEN.

### Task2 Query evidence and analysis tools

Files: chain-data/src/queries.ts; agent-runtime/src/tools.ts, runtime.ts; query/flow-runtime tests.
Interface: QueryService.analyzeFlows(queryId), readEvidence flow_assets/flow_counterparties; analyze_asset_flows registered with queryId only.

- [x] RED persisted flowAnalysis and bounded model preview, old-query compatibility, authorization and wrong-kind rejection.
- [x] Compute report before durable query write, add readonly tool and paging without new HTTP; keep original records immutable.
- [x] GREEN targeted tests / suite.

### Task3 Deterministic answer and runtime behavior

Files: agent-runtime/src/flow-answer.ts, flow-context.ts, answer.ts, tools.ts, runtime.ts; flow-runtime.test.ts.

- [x] RED flow_summary/counterparties fact validation, partial/missing amount labels, synthetic Pi tool chain, analysis-required final answer and cancellation recovery.
- [x] Implement bounded deterministic output and prompt; model does not invent totals.
- [x] GREEN npm test/typecheck and diff check.

### Task4 Verify and document

- [x] Public-address true model+data analysis; independently recompute raw integer totals from saved evidence.
- [x] Update README and integration record, independent review and necessary RED→GREEN fixes.
- [x] Final full tests/typecheck; leave local feature changes reviewable.
