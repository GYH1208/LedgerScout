# US Equity Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved free-data US equity research workflow alongside Ethereum research.

**Architecture:** Establish actual provider capabilities before product integration. Keep provider transport, normalization and deterministic calculations in a new equity-data package; retain the current Pi runtime, React workspace and SQLite storage. No provider fallback, paid upgrade, background polling or sample-data substitution.

**Tech Stack:** Node >=22.19, TypeScript, node:sqlite, Pi, React, existing DeepSeek transport.

**Spec:** `docs/superpowers/specs/2026-11-15-us-equity-research-design.md`

## Global Constraints

User implementation steering on 2026-11-16: proceed with other/offline work while the user applies for the key. Tasks 2–6 may be implemented and tested offline before actual Task 1 coverage acceptance; real acceptance remains a release gate.

- At most 32 data HTTP attempts per explicit operation, 300 seconds per run; all failures and retries count.
- FMP requests reserve quota transactionally before dispatch, at most 200 attempts per UTC day by default.
- SEC requests share a scheduler with at least 500 ms between dispatches; real SEC_USER_AGENT is mandatory.
- Market refresh and stock refresh are separate explicit operations; at most 5 stock candidates per batch, default pool at most 10.
- Minimum actual coverage: all 13 market proxies plus at least 5 configurable ordinary US equities. Never infer entitlement from pricing pages.
- No secrets in output, evidence, commits or chat. No model requests in capability checks.
- Unknown adjustment semantics prohibit return rankings; prices are not dividend-inclusive total returns.
- Historical evidence is immutable; old Ethereum records and budgets retain their meaning.

## Review Focus

1. A provider echoes a credential in JSON fields, object keys, error text or URLs: every persisted artifact remains redacted.
2. A 200 response actually contains an entitlement/rate-limit error: record the real failure, stop on rate limits.
3. Restart or competing quota connections: no lost counters, failed attempts remain charged locally, UTC reset is explicit.
4. Ticker/CIK mismatch, ADR, ETF, missing security flags or incompatible currency: cannot certify an ordinary-stock candidate.
5. Truncated/duplicate/conflicting/future prices or an exhausted deadline: no fabricated coverage and no requests beyond the budget.

---

### Task 1: Capability validation gate

**Files:** Create `packages/equity-data/{package.json,src/config.ts,src/quota.ts,src/transport.ts,src/capabilities.ts,src/cli.ts,test/*.test.ts}`; modify root `package.json`, `package-lock.json`, `.env.example`, README.

**Interfaces:** `loadEquityConfig(env?, files?)`; `DailyQuota.reserve(now?)`; `EquityTransport.request(provider, endpoint, symbol?)`; `validateCapabilities({stage, symbols, config, directory, fetch?})` returns a bounded report with endpoint/symbol/status/fields/history/adjustment/source samples and counts. CLI offers `--config`, `--stage market`, `--stage stocks --symbols ...`. No implicit stock choices become an authorized pool.

- [ ] Write and run failing tests for config isolation, persistent quotas, safe bounded HTTP, provider errors, identity, price coverage, partial progress and capability reports.
- [ ] Implement configuration, transactionally reserved quotas, SEC pacing, cancellation/deadlines, bounded payload recording and strict normalizers.
- [ ] Run new offline tests and typecheck; run actual configured market and stock checks, recording sanitized samples and permission results.
- [ ] Gate: if credentials are missing or minimum real coverage is unavailable, record the exact blocker and keep Tasks 2–6 pending. Do not silently switch providers or pretend the full feature is complete.

### Task 2: Financial data and deterministic screening

**Files:** New `packages/equity-data/src/{cache,identity,financials,metrics,screening}.ts` and corresponding tests.

**Interfaces:** versioned identity/period/source-tagged evidence; snapshots contain stable references to immutable files. Filters accept allow-listed numeric fields and operators; missing or stale fields explicitly exclude rows. Market returns use common dates and confirmed adjustment semantics. Financial facts retain units, accession, filing date, period length and restatements.

- [ ] RED→GREEN tests for annual/quarterly/YTD disaggregation, consistent four-quarter TTM, zero/negative valuation denominators, financial-industry exclusions, common market dates, refresh failures and filter exclusions.
- [ ] Add bounded immutable raw storage, persistent cache/pool indexes and explicit max-five partial refresh/continue.
- [ ] Verify deterministic calculations against preserved actual source samples from Task 1.

### Task 3: Domain persistence and runtime integration

**Files:** `packages/agent-runtime/src/{session,checkpoint,context,runtime,tools,answer}.ts`, new equity runtime modules; `packages/web-server/src/{storage,history,views}.ts`, domain migration tests.

**Interfaces:** immutable session `researchDomain: ethereum | us-equity`, legacy default ethereum; common result envelope with tagged domain evidence. Equity tools have separate target authorization and evidence validators. Resume freezes original securities, snapshot hashes and cumulative budgets.

- [ ] RED→GREEN migration tests with consistent pre-migration backup, old histories, wrong-domain recovery, changed source hashes and path traversal.
- [ ] Integrate equity tools through Pi with 15 model requests, 35-second model timeout and 300-second total deadline; bound repeated no-progress reads.
- [ ] Verify actual offline runtime, cancellation/restart/explicit recovery and all existing Ethereum regressions.

### Task 4: Complete web workflow

**Files:** `packages/web-server/src/server.ts`, React workspace source and tests, `apps/research-prototype/AGENTS.md` if durable choices change.

**Interfaces:** domain-specific readiness; market/screen/research endpoints return source-tagged results without exposing secrets. Candidate research receives the exact screen conditions and snapshot reference without authorizing unrelated historical evidence.

- [ ] RED→GREEN API/browser tests for independent configuration, fixed domain sessions, cached views with zero model/HTTP activity, partial refresh and missing/stale states.
- [ ] Add white/gray/blue domain entry and market→screen→research views; preserve existing conversation/evidence layout.
- [ ] Start the app and visually verify real and missing-config states using the local preview.

### Task 5: End-to-end acceptance

- [ ] Actual offline Pi/API/SQLite/browser tests: two company types, sector ETF, screening, evidence follow-up, restart, cancellation and explicit recovery.
- [ ] Bounded real acceptance against the verified free sources; inspect saved inputs and program calculations independently of model wording.

### Task 6: Budgets, review and documentation

- [ ] Verify counts/timing/token reporting, cached views without model calls, follow-ups without refresh and bounded repeated reads.
- [ ] Run full suite, typecheck and UI build. Record baseline failures separately from regressions.
- [ ] Fresh final implementation review, address material findings with reproducing tests, document achieved scope and remaining blockers precisely.


### Approved follow-on: Twelve Data ETF prices (2026-11-16)

- [x] User approval after real FMP 402 permission gate; retain FMP+SEC stocks.
- [x] RED→GREEN fixed-host/header-auth, ETF identity/prices, Nasdaq MIC, response redaction, stop-on-rate-limit, cancellation, UTC atomic quota and 8-second dispatch tests.
- [x] Independent market readiness/UI quota, provider-specific cache, capability CLI and shared CLI/Web quota-directory tests.
- [x] Real13 ETF requests, revalidate immutable responses and populate comparable cached market; all13 ×128 bars, common2026-11-13, 1/5/21/63-day price returns.
- [x] Fresh independent code review and material fixes.
- [x] Bounded real company/history/screen/cancel/resume acceptance; detailed partial-result semantics recorded.
- [ ] Complete regression and browser visual acceptance: existing Windows permission/parallel timing failures and host browser error remain separately recorded.
