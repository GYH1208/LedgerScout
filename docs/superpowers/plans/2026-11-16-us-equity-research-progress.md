# US-equity implementation and verification — 2026-11-16

Implementation branch: `feat/us-equity-research`, based on `d6e9120`. The user approved committing this implementation on the feature branch, then merging it into local main. No push or deployment is authorized by this integration step. Local preview is running at http://127.0.0.1:4173/?mode=live&domain=us-equity .

## Current verified scope

- The user approved implementing the latest design, then explicitly approved Twelve Data free ETF pricing after FMP's actual ETF permission failure. FMP, SEC and Twelve Data credentials are now configured locally; no values are included here.
- FMP+SEC actual capability checks passed for AAPL, MSFT, GOOGL, AMZN and META. All five now have real cached company snapshots; pool version1 contains those samples. This is a configurable test pool, not an investment recommendation or index universe.
- FMP's free account returned HTTP402 for QQQ and the11 sector ETFs; SPY alone worked. This is recorded as PERMISSION_DENIED, never retried as a transient error or silently upgraded.
- Twelve Data returned13 successful time_series responses,128 daily observations each. Requests explicitly used adjust=splits; currency/type/US MIC/time zone/date/numeric checks passed. QQQ's XNMS Nasdaq Global Market segment was initially rejected, then verified and added with a regression. Original responses remain unchanged; revalidation consumed zero additional HTTP requests.
- All13 ETF series share closing date2026-11-13, with1/5/21/63-session price returns and relative-to-SPY differences available. Independently recomputed52 returns and52 benchmark differences directly from saved raw prices; all agree within1e-8 percentage points.
- Actual DeepSeek/Pi research generated cited explanations for Apple and Amazon with separately rendered deterministic facts. Both reports correctly remain partial because model context contains only bounded disclosure excerpts. PE and FMP individual-stock split-adjustment gaps remain explicit.
- Actual historical follow-up reused its original company snapshot and made zero supplier HTTP requests. One follow-up's model explanation lacked the required disclosure citation and was withheld; verified program facts were retained.
- Actual cancellation at the first model request produced a recoverable checkpoint. Explicit resume kept the original snapshot and cumulative budgets:3 model requests total,2 tools,0 supplier HTTP, about41.7 seconds including35 seconds reserved for the cancelled model request. Cancelled request token usage remains unknown, not zero. Resumed cited explanation contains925 characters and retains the input-truncation limitation.
- Actual screening of the five cached stocks with nonnegative revenue growth returned five matches without model or supplier calls. Histories, snapshots, market series and checkpoints survived backend restarts.

## Implementation

- Dedicated equity-data workspace: root .env configuration; allowlisted SEC/FMP/Twelve Data adapters; sanitized immutable source evidence; deterministic securities, dates, financials, metrics and filters; bounded capability CLI.
- SEC dispatch spacing500ms; FMP transactional attempt ledger capped200/UTC day; separate Twelve Data transactional ledger default600/UTC day, configurable1–800, with8-second dispatch spacing. CLI and Web share each supplier's ledger under EQUITY_OUTPUT_DIRECTORY. Failures and retries count;429 stops a stage. No automatic provider fallback or batch continuation.
- Dedicated equity.sqlite metadata and immutable evidence files. Seven-day profiles and24-hour company/market caches are reused only when explicitly relevant. Old FMP market caches cannot be shown under the new Twelve Data split-adjusted caption or mixed into its returns.
- Fixed equity session symbols/domain and original historical evidence/peer authorization. Recovery verifies hashes and paths and atomically consumes its parent checkpoint. Legacy Ethereum sessions default to ethereum; old Web metadata has a backed-up domain migration.
- Actual Pi/DeepSeek integration keeps15 model,12 tool,32 data-HTTP,300-second total limits and35-second model timeout. A transient SEC retry consumes the shared32-attempt stage allowance, rather than an erroneous five-attempt per-company limit.
- Multi-tool real acceptance exposed oversized protected tool batches. Regression now covers this through actual Pi. When needed, only JSON evidence payloads are compacted; complete assistant/tool pairs, arrays and query IDs remain intact. The closing request disables further tools, keeps the conservative10k input limit and reports truncation. Resume preserves that limitation and closes from saved evidence.
- White/gray/blue market, pool screening and company research views; independent source readiness and quotas; pool<=10, explicit stock batches<=5; provenance/metric periods/evidence pagination; partial progress, cancellation and explicit recovery. Ethereum entry remains available.

## Review

The first independent review identified ten material issues, all reproduced and fixed: outbound/provider-key redaction, capability stdout redaction, unsupported recent SEC XML handling, frozen recovery peer authorization, disclosure abort propagation, historical disclosure reuse, foreign citation rejection, concurrent admission ownership, informational formula notes misclassified as gaps, and mismatched market return keys.

A second independent review covered Twelve Data auth, identity, UTC atomic quota/pacing, cancellation, cache migration and readiness. It prompted fixes for old FMP snapshot visibility and shared CLI/Web quota paths. Follow-up review confirmed the context/budget fixes and caught the lost truncation warning after resume; the new resume regression passes. Latest review reports no remaining material findings. Reviewer used only offline reads/tests.

## Verification

- Latest pre-merge full run:380 tests,374 pass,4 fail,2 skip. Only the four existing Windows EPERM symlink setup cases fail; both recovery checks pass in this run. Log: %TEMP%/ledgerscout-before-merge-tests.log. Earlier unstable recovery runs remain recorded below.

- npm run typecheck: passes.
- npm run ui:build: passes, including existing Sites packaging.
- App npm test:13/13 passes.
- Focused runtime/provider review tests:16/16 passes. All added equity tests pass in the full run.
- git diff --check: passes.
- Full default parallel run:380 tests,373 pass,5 fail,2 skip. Four failures are the pre-existing Windows EPERM symlink setup cases in persistence.test.ts. The fifth is the existing busy/cancel/resume assertion in server.test.ts; its complete six-test file passes independently but the assertion reappears under the full parallel workload. No Windows security/permission settings were changed. Logs: %TEMP%/ledgerscout-twelve-final-tests-v3.log and %TEMP%/ledgerscout-server-focused.log. Serial full run:380 tests,373 pass,5 fail,2 skip; the four EPERM cases remain, the busy/cancel/resume test passes, and the existing SIGKILL recovery-result test fails instead. This confirms recovery verification remains unstable rather than establishing a clean full-suite result. Serial log: %TEMP%/ledgerscout-twelve-serial-tests.log.
- Original pre-change baseline:301 tests,293 pass,6 fail,2 skip; four EPERM setups and two recovery-result mismatches. Baseline log: %TEMP%/ledgerscout-baseline-tests.log.
- UI HTTP and equity-state endpoints return200, with13/13 market coverage, all five real company caches and all four source/model configuration statuses present. These are HTTP/API checks, not browser visual verification.

## Evidence artifacts

All are local ignored runtime data, containing sanitized source responses and source hashes:

- Initial FMP13-proxy capability: runtime-results/equity/capabilities/2026-11-16T04-19-20-423Z-a8e52eb2/0027-capability-report.json .
- Five-stock FMP+SEC capability: runtime-results/equity/capabilities/2026-11-16T04-19-20-632Z-aaaf02f6/0022-capability-report.json .
- QQQ HTTP402 diagnosis: runtime-results/equity/capabilities/2026-11-16T04-20-50-875Z-6db473bb/0001-permission-diagnostic.json .
- Original Twelve Data raw responses and initial report: runtime-results/equity/capabilities/2026-11-16T05-43-12-333Z-6ada2efb/ .
- Final13-proxy revalidation: the same directory's0015-revalidated-market-report.json .
- Company/history/screen acceptance: runtime-results/equity/acceptance/2026-11-16T06-01-46.209Z.json .
- Actual cancellation/recovery: runtime-results/equity/acceptance/cancel-resume-2026-11-16.json .

## Remaining limits

- Browser automation cannot open the local preview: the in-app browser is unavailable and Chrome tab creation fails in the host with “Cannot read properties of undefined (reading 'timeoutMs')”. No screenshots, visual fidelity or interactive browser acceptance are claimed. The local preview is ready for manual inspection.
- Full default parallel tests are not all green, as described above. Do not claim complete regression acceptance or merge readiness from focused passes.
- FMP individual-stock prices retain unknown adjustment, so stock price-return screening is unavailable. PE remains unavailable until compatible EPS/share/split semantics are verified. ETF price returns exclude dividends and stop at New York's previous calendar day to avoid unclosed daily bars.
- Evidence snippets are bounded; reports show explicit gaps and must not be represented as exhaustive business/risk coverage. The feature is implemented and its source/API workflows verified, but the design's complete browser and regression acceptance is not declared finished.
