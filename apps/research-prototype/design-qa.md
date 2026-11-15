# LedgerScout UI verification — 2026-11-15

**Findings**

No remaining actionable P0/P1/P2 findings after the fixes and recapture below. The original demonstration and the subsequent connected local live mode are verified separately below.

## Visual evidence and normalization

- Source visual truth: `../../docs/design/selected-conversation-ui.png` (887 × 1774 physical pixels). Each stacked state is 887 × 887; source CSS size and device density are unknown. The image generator did not honor its requested wide desktop aspect ratio.
- Written design approved a 1440 × 1024 desktop viewport and approximately 220px session sidebar. Implementation intentionally uses those dimensions rather than stretching the square raster or making the desktop app square. This is a responsive composition comparison, not a claim of pixel-identical viewport reproduction.
- Implementation: `../../docs/design/qa/home-desktop.png` and `result-desktop.png`, browser-rendered at 1440 × 1024 CSS/physical pixels, deviceScaleFactor 1. States: empty homepage; flow result with first citation open.
- Full-view comparisons: `../../docs/design/qa/compare-home-final.png` and `compare-result-final.png`. Source states were cropped apart, resized proportionally to 1024 × 1024, and placed beside the full 1440 × 1024 implementation. No aspect-ratio distortion.
- Focused typography/value comparison: `../../docs/design/qa/compare-result-detail.png`, containing source and implementation crops together. Inspected result title, date/scope, conclusion, numeric values, dividers and headings at readable sizes.
- Responsive captures: `home-mobile.png`, `result-mobile.png`, `evidence-mobile.png` under the same evidence folder; 390 × 844 CSS/physical pixels, density 1. Horizontal overflow was also checked at 320 × 640.

## Required fidelity surfaces

- **Fonts/typography:** system sans/PingFang fallbacks, dark semibold display titles, muted body metadata, tabular numeric amounts. Desktop header hierarchy follows the mock. Mobile hero uses balanced wrapping instead of leaving a single character on its own line. Generated source text is raster and has unknown font metrics; no exact typeface identity is claimed.
- **Spacing/layout:** session sidebar, central conversation and right evidence rail preserve the source anatomy. The approved 220px sidebar and 285px evidence rail leave more reading width than the square source. Sections use whitespace and thin rules. The composer remains visible while conversation content scrolls; content can scroll completely above it. Long session titles truncate without resizing the sidebar; history itself scrolls. Short homepage viewports can scroll.
- **Colors/tokens:** white main surface, #f5f5f7 sidebar, #1d1d1f text, #6e6e73 metadata, #0071e3 primary actions. Selected sessions use a light blue tint. Disabled empty-input submit is deliberately lighter than the source's decorative active button.
- **Image quality/assets:** source contains editable text and standard UI symbols, no photos or bespoke artwork. Wordmark is text as shown. Phosphor icons supply navigation, copy, user and assistant symbols; no handwritten SVG or rasterized interface substitutes.
- **Copy/content:** demo markers remain visible, partial statements are sample-bounded, two records are called examples rather than all records or a ranking, sources explicitly say they are demonstration evidence. Current-snapshot ENS binding is distinguished from historical binding. Unsupported targets/scopes clarify rather than returning fixed ETH conclusions.

## Comparison/fix history

1. **[P2] Opening an existing session scrolled to its bottom and cut off the title.** Evidence: `result-initial.png`. Fixed selection to open at the top; only a newly appended turn scrolls into view. Rechecked title bounds and recaptured `result-desktop.png`.
2. **[P2] A long new-session title widened the sidebar.** Earlier result capture showed the shift. Fixed the flex item's minimum width and made the history scroll independently. Final result/sidebar is 220px, confirmed in the final full-view comparison.
3. **[P2] Mobile keyboard Tab cycling briefly escaped the modal's controls.** Browser regression failed. Added explicit first/last Tab wrapping; both navigation and evidence modal checks now pass, including Escape and focus restoration.
4. **[P2] Mobile hero left a very short final line.** Evidence: earlier `home-mobile.png`. Applied balanced text wrapping and recaptured the final mobile screenshot. Small-screen metric sizes also scale to avoid clipping.
5. **[P2, independent code review] Unsupported domains, token, chain and date requests could receive the fixed demo response.** Two regression tests failed before the change. Whole-request validation now accepts only the documented demo requests and source follow-ups. All three classifier regression tests pass; the full browser flow was rerun afterward.

## Interaction and error checks

`npm run test:ui` passed 16 browser checks, recorded in `../../docs/design/qa/interaction-results.json`: example fill, empty input, submit, loading, duplicate prevention, partial response, follow-up, cancellation without stale completion, explicit resume, separate citations, full-address clipboard copy, Escape/focus restoration, unknown-target clarification, all configurable terminal states, cross-session timer isolation, balance mode, mobile drawer trapping, mobile follow-up/cancel and narrow-page overflow.

Browser console/page errors: none. External requests during the workflow: none. Browser is installed Google Chrome in an isolated Playwright context, as authorized by the user after the in-app browser failed.

## Open questions and limits

No open questions block this prototype. Actual iOS/Android software keyboards and assistive screen readers were not tested. Mobile captures verify responsive browser viewports and keyboard focus behavior, not a physical device. Real provider integration was verified in the later live-mode milestone below.

## Implementation checklist

- [x] Desktop and mobile visual evidence inspected.
- [x] Earlier P2 findings fixed and final states recaptured.
- [x] Primary interactions and console checked in a rendered browser.
- [x] Production build and 7 local tests passed.
- [x] Existing root suite: 233 passed, 2 optional tokenizer tests skipped; typecheck passed.
- [x] Preview left running locally; no deployment.

**Follow-up Polish**

None required for this prototype handoff. The separately scoped local server adapter and live acceptance were subsequently implemented below.

## Live-mode addition — 2026-11-15

The user requested real testing while preserving the layout. `?mode=live` keeps the same sidebar/conversation/evidence anatomy, with authoritative Runtime text and reference links instead of fictional metrics. Its empty state and config guard were inspected in `../../docs/design/qa/live-missing-config.png`. The result/evidence view was browser-tested with intercepted offline transport: `live-offline-result.png`, `live-offline-evidence-mobile.png`, and `live-offline-ui-results.json`. Combined structural comparison: `compare-live-layout.png`. Content differs intentionally (balance vs source flow report); this comparison assesses the shared layout, type and white/gray/blue tokens, not identical state content.

Live mode does not seed or fall back to the fixture data. Fixtures are confined to the browser test context and labelled in their report/screenshot names. After the user configured credentials, the explicit real acceptance script passed balance, date-window transfers, evidence opening and a historical-evidence follow-up with zero new data HTTP requests. Actual provider statuses were completed / partial / completed. The partial flow turn records an initial rejected timestamp boundary response and a successful retry with complete incoming/outgoing traversal; its failed source is retained in the UI.

Real provider record and browser captures: `../../runtime-results/web-live_2026-11-15T06-51-49-147Z/acceptance.json`, `run-1.png`, `run-2.png`, `run-3.png`, and `flow-evidence.png`. API answer text was compared with durable Runtime summaries. The detailed evidence and status are recorded in `../../docs/superpowers/plans/2026-11-15-web-live-progress.md`. Latest root suite: 243 passed, 2 optional tokenizer skips; typecheck passed.

Further real-data checks (`evidence-checks.json` in the same run folder) passed: 28 unique evidence records loaded in pages of 10/20/28, all 16 asset totals matched exact raw integer amounts, reload/session selection worked on mobile, and no horizontal page overflow or browser errors appeared. Inspected `flow-status-desktop.png` (honest partial status), `flow-paginated-desktop.png` (raw record details), and `flow-evidence-mobile.png` (28/28 evidence drawer at 390 × 844). Evidence inspection caused zero new provider requests.

Both independent-review issues (delayed evidence reopening and consumed recovery still offered) have failing-before/passing-after regressions. No actionable visual P0/P1/P2 remains in inspected states. Actual physical-device keyboards and assistive readers remain untested.

## SQLite persistence addition — 2026-11-15

The live view now persists local conversation/answer/job metadata in SQLite while retaining Runtime evidence and checkpoints as files. The layout is unchanged. Sidebar copy now accurately states that history survives restarts. A Web-only interrupted turn can display an explicit recovery control without inventing a Runtime answer; validation determines availability.

`npm run test:persistence` passed against actual local HTTP + SQLite + Pi Runtime in isolated subprocesses, with only upstream supplier responses replaced offline. It verifies restart/retained answer and exact wei evidence, historical follow-up with zero data HTTP, SIGKILL/interruption/explicit recovery, and the mobile restored-evidence drawer without page overflow. Browser errors: none. Evidence: `../../docs/design/qa/sqlite-persistence-results.json`, `sqlite-offline-interrupted-desktop.png` (1440 × 1024) and `sqlite-offline-evidence-mobile.png` (390 × 844). Both screenshots were inspected.

Original demo's 16 browser checks and live offline transport checks passed after the UI additions. Root suite on Node 24 and the exact minimum Node 22.19.0: 269 passed, 2 optional tokenizer skips; typecheck and front-end build/7 tests passed. This persistence milestone made no additional real model or chain-data requests.

final result: passed
