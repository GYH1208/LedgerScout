# AI Application Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Deliver source-backed AI application theme discovery, candidate-company handoff and user-confirmed investment-thesis review for a 12–24 month horizon.

**Architecture:** Keep existing equity and Ethereum sessions intact. Add a discovery domain package contract, bounded public-document reader/indexer, independent SQLite discovery metadata, staged Pi analysis and adjacent React workflow; share the existing equity cache, provider quota and single-work admission.

**Tech Stack:** Node >=22.19, TypeScript, Pi, existing DeepSeek, SQLite, React; one HTML parser dependency if needed.

**Spec:** `docs/superpowers/specs/2026-11-16-ai-application-discovery-design.md` (approved 2026-11-16).

## Global Constraints

- US/USD/US-GAAP common stocks; fixed four starting themes; discovery catalog<=30, research pool<=10; explicit refresh<=5, cache-only scan<=10; opportunities0–5.
- All stages share one task:15 model/12 tools/32 HTTP/300 seconds;35-second model timeout; cumulative explicit recovery. No background continuation or scheduler.
- Sources: verified SEC plus registered issuer document/index pages. At most1 index+1 pagination page and2 new bodies/company; all count against HTTP budget. No paid API/new key/search engine.
- New evidence does not overwrite confirmed thesis versions; unknown metric values, AI attribution and missing counterevidence remain explicit. No investment-return rankings or trades.
- User authorized direct implementation after design approval; execute without another plan/method approval. Existing shared checkout and local configuration are preserved on a new feature branch.

## Review Focus

- Issuer indexes changing URLs: constrained real links and honest checked/unchecked/partial status (Task2/4 tests).
- SEC TOCs repeating section titles: actual body chunks with valid offsets, safe fallback and no cover-as-business claims (Task2 tests).
- Same-period restatement vs new period vs missing value: typed deterministic changes and preserved gaps (Task3 tests).
- Hostile or invented model citations/AI revenue: authorized original chunks only; management claims never become independently verified fact (Task5 tests).
- Concurrent acceptance and cancelled staged tasks: frozen targets, preserved completed extraction, cumulative counts and one-consumer resume (Task4/5 tests).

## Files and Interfaces

- `packages/equity-data/src/discovery-types.ts`: shared theme/catalog/document/task/opportunity/thesis contracts and catalog validation.
- `packages/equity-data/src/documents.ts`: HTML parsing, section/chunk offsets and bounded retrieval.
- `packages/equity-data/src/official-sources.ts`: exact official-source URL validation, public reader and bounded index link discovery.
- `packages/web-server/src/discovery-store.ts`: separate `discovery.sqlite`, immutable document files, catalog/task/thesis/proposal versions and atomic recovery/confirmation.
- `packages/web-server/src/discovery-theses.ts`: thesis validation and deterministic snapshot/condition comparison.
- `packages/web-server/src/discovery-runtime.ts`: shared task budgets and bounded Pi extraction/aggregation/review.
- `packages/web-server/src/discovery-service.ts`: catalog/source refresh, scans, proofs, thesis/review/cancel/resume routes.
- Existing `equity-service.ts` owns the discovery service, sharing its `EquityStore`, single admission and provider cache/quota. `/api/equity/discovery/*` routes remain within existing HTTP origin/header checks.
- `apps/research-prototype/src/DiscoveryApp.jsx`, `discovery-api.js`, `discovery.css`: catalog/source editing, refresh/scan, opportunity→company, thesis confirmation and version review UI. `EquityApp.jsx` integrates the new tabs and handoff.

### Task 1: Contracts and approved-plan baseline

- [x] Write `discovery-contracts.test.ts`: catalog rejects31/duplicates/invalid theme and untrusted source configuration; accepts pending entries without silently granting verification.
- [x] Run it RED, implement types and validation, run GREEN. Type-only contracts also define durable frozen task input and source IDs.
- [x] Record existing test baseline and approval in progress ledger. Commit contracts+approved spec+plan.

### Task 2: Documents and official source reader

**Produces:** `buildDocument(input):DiscoveryDocument`, `retrieveChunks(document,query,{offset?,limit?}):{chunks,total,nextOffset}`, `validateOfficialSource(source):OfficialSource`, `discoverOfficialLinks(html,source,pageUrl):{documents,nextPage?}`, `readOfficialPage(source,url,{fetch?,signal?,beforeRequest?}):Promise<{html,url,fetchedAt}>`.

- [x] Tests RED: body headings afterTOC, escaped entities/boilerplate removal, chunk offset roundtrip, fallback extraction, paging, hostile link/redirect/private host, cancellation and max response, real allowed links only.
- [x] Implement bounded parsing/indexing and source-host/path validation; SEC filing body max16MiB / issuer body max2MiB, indexed text max500000 characters, HTTPS public exact registered scope. No scripts/rendering/search or URLs inferred by model.
- [x] Tests GREEN; export source contracts. Commit.

### Task 3: Catalog, evidence, thesis and review persistence

**Produces:** `DiscoveryStore(directory)` with `universe/setUniverse`, `saveDocument/document/documents`, `saveJob/job/jobs/claimResume`, `confirmThesis/thesis/theses`, `saveProposal/proposal/resolveProposal`, `close`; immutable file integrity and transactional optimistic versions. `compareSnapshots(previous,next):MetricChange[]`, `validateThesis(input):ThesisInput`.

- [x] Tests RED: pool remains untouched,30-limit, document tamper/path rejection, catalog history and task hash, interrupted restart, atomic duplicate recovery, explicit thesis confirm, rejected/stale proposal, immutable older thesis, missing/restated/newperiod changes and gap resolution reason.
- [x] Implement dedicated SQLite schema with consistent migration backup; no constructor network calls. Store snippets separately from small state projections. Preserve source timestamps and content identity.
- [x] Tests GREEN; commit.

### Task 4: Source acquisition and discovery HTTP workflow

**Consumes:** existing EquityStore, EquityProvider/Transport, Task2/3 contracts.

**Produces routes:** GET `/state`, `/documents/:id?query=&offset=`, `/jobs/:id`, `/theses/:id`; POST `/universe`, `/refresh`, `/scan`, `/theses`, `/review`, `/proposals/:id`, `/cancel`, `/resume`, `/handoff` under `/api/equity/discovery`.

- [x] Tests RED: browse no network/model, frozen catalog<=30 with pending source edits, source ownership from verified company profile/domain or actual official-site link, updates<=5,32 aggregate HTTP attempts, stop onquota/rate/cancel, maxindexpages/bodies, source checked/unchanged/partial status and global workload serialization.
- [x] Implement explicit refresh using existing cached profiles/SEC data and normalized companies; add parsed SEC documents plus constrained official sources. A pending URL cannot grant itself trust. Fresh citations/ownership checks count toward one task's budget.
- [x] Freeze selected snapshot/document IDs before async scan/review admission. Candidate handoff validates chosen opportunity/company and adds immutable theme context without relaxing fixed-symbol sessions.
- [x] Tests GREEN; commit.

### Task 5: Staged analysis, thesis conditions and change review

**Produces:** `runDiscoveryTask(options):Promise<DiscoveryJob>` and bounded budget helper used by refresh as well as analysis. All stages persist progress and use frozen original sources.

- [x] Tests RED using actual Pi with offline model: per-company isolated inputs,10-company read/model caps,0 opportunities, mixed issuer/report/application scopes, foreign citations rejected, missing AI metrics remainunknown, max15/12/32/300s, model timeout/cancel, frozen one-consumer cumulative resume, source hash mismatch and input truncation gaps.
- [x] Implement company extracts then citation-validated aggregation with0–5 opportunities; structured results distinguish issuer claims/analysis and exact original quotes. No ordinal return score.
- [x] Implement deterministic metric comparisons and explicit review proposals; no-evidence refresh skips model. Confirmation/rejection is idempotent and tied to original thesis version; clearing prior gaps requires new evidence or an explicit user reason.
- [x] Tests GREEN; commit.

### Task 6: Complete React flow, acceptance and documentation

- [x] Write frontend API/selection/confirmation tests RED; implement two new tabs, catalog/source edits, current task progress, cancel/resume, proof pagination, opportunity handoff, editable thesis draft/conditions and accept/reject review with history. Retain existing visual language and live-only evidence.
- [x] Update API/README/AGENTS docs; source/catalog identities and current coverage visible, no demo conclusions. Tests GREEN, root typecheck, app tests and production build.
- [x] Prepare a curated pending seed catalog with official source metadata; actual free-source gate:5 verified companies,3 with locatable AI application正文,2 themes. Reuse existing data before explicit bounded refresh. Record real limitations if source gate fails rather than certify fixture coverage.
- [x] Actual local HTTP/SQLite/Pi workflow: scan→company→confirmthesis→new evidence/review→accept/reject, cancel/restart/explicitresume, historical versions; live model call limited and documented. Browser preview attempted via supported host tool, report host limitations accurately.
- [x] Whole-branch independent review, reproduce/fix material findings, final verification and ledger. Commit implementation; do not merge/push without a new user request.

## Self-review

Spec §§1–3 map toTasks1/3/6; §4 toTasks4–6; §5 toTasks2/4; §6/8 toTasks4/5; §7 toTasks1/3/6; §9 toTask6. Shared contracts are defined before independent source/persistence work; root owns service/runtime integration. Existing known Windows symlink failures stay separately recorded, not fixed or silently skipped as part of feature work.
