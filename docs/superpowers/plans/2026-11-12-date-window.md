# Date Window Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Query transactions and transfers in user-selected date windows with verified boundaries and stable recovery.

**Architecture:** Deterministic parsing produces an immutable TimeWindow. QueryService resolves it with budgeted Etherscan mapping and Alchemy boundary headers. Normal query evidence carries the verified mapping; recovery reuses only hash-verified lineage evidence.

**Tech Stack:** Existing TypeScript / Pi / npm workspaces; no added dependencies.

**Spec:** docs/superpowers/specs/2026-11-12-date-window-design.md (user approved).

## Global Constraints

- User chose Etherscan, Asia/Shanghai calendar dates, rolling168h for seven days.
- Keep 32 HTTP attempts, 8 model requests,12 tools and120s caps; count mapping and header requests.
- Checkpoint retains original integer-second window, never recomputes relative time on resume.
- Windows tokenizer remains deferred; execution inline in existing checkout feature branch, no push/merge.

## Review Focus

- Exact start/end block timestamps and gaps must not include out-of-window blocks.
- Unsupported or conflicting input clarifies before network.
- Mapping failures cannot silently broaden to all history.
- Recovery must reject altered source proof and preserve original time.
- Partial pagination must retain the time window and honest completeness.

### Task 1 Deterministic parser

Files: packages/agent-runtime/src/dates.ts; packages/agent-runtime/test/dates.test.ts; packages/chain-data/src/time.ts.
Produces: parseDateWindow(input: string, now: Date): { window?: TimeWindow; error?: string }; TimeWindow fields startTimestamp/endTimestamp/referenceTimestamp/timezone/clipped.

- [x] RED: fixed 2026-11-12T01:00:00Z, 最近七天 => start2026-11-05T01:00:00Z; 昨天 => 2026-11-10T16:00:00Z to2026-11-11T15:59:59Z; invalid2026-02-29 rejected; unsupported/explicit block conflict rejected.
- [x] Implement supported rolling/calendar/absolute windows; future clipping explicit.
- [x] GREEN parser tests.

### Task 2 Mapping and query enforcement

Files: chain-data src/time.ts, api.ts, queries.ts,index.ts; test/time.test.ts.
Produces: ResolvedTimeWindow with snapshot, startBlock,endBlock,sourceQueryId,proof; resolver using existing Transport.

- [x] RED mock real HTTP boundary requests: timestamps 100..199 => blocks2..3 with proof blocks1:90,2:100,3:199,4:200; invalid boundary rejected; multiple history queries reuse mapping; cancellation/budget respected.
- [x] Implement fixed Etherscan block endpoint and whitelisted block headers, verified resolver and programmatic range override/conflict rejection.
- [x] GREEN targeted tests and suite.

### Task 3 Runtime and recovery

Files: agent-runtime src/runtime.ts, checkpoint.ts, tools.ts,answer.ts; runtime/resume tests.
Consumes parser and QueryService.timeWindow. Checkpoint adds optional TimeWindow; old checkpoints remain supported.

- [x] RED real Pi tests: date query completes with forced range, invalid dates make zero calls; cancel after history tool and resume keeps exact window and reuses mapping. Existing partial-history regressions retained; partial live first attempt renders dates and facts.
- [x] Validate checkpoint window/proof/source references before requests; render time in deterministic answer and update prompt to omit guessed blocks.
- [x] GREEN complete npm test, typecheck and diff check.

### Task 4 Live date acceptance and docs

- [x] Execute a real public-address 最近七天 query through CLI; inspect Etherscan parameters, block headers, mapped range, counters and answer completeness.
- [x] Update README and integration record with limits and actual result.
- [x] Whole-change review followed by necessary regression fixes and final verification (183 tests:181 pass,2 optional skips; typecheck and diff check pass).
