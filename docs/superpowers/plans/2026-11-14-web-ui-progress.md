# Implementation ledger — plan: docs/superpowers/plans/2026-11-14-web-ui.md

## Authorization and workspace

User selected displayed option 2 and explicitly confirmed the written design. Implemented inline on `feat/web-ui-prototype`; the app lives in a standalone `apps/research-prototype` folder. Existing packages and runtime algorithms were not modified. Changes remain uncommitted for inspection.

## Task 1: complete

Bootstrapped the bundled web template, retained its worker and packaging files, and added React conversation UI, bounded local demo state, independent evidence selections, copying, demo scenario controls, explicit cancel/resume and responsive modal drawers. Added run documentation and root UI commands. Source image is preserved in `docs/design/`.

Initial root regression run failed because the existing local install lacked `@adraffy/ens-normalize` and related dependencies. `npm ci --ignore-scripts` restored the lockfile dependencies without changing the lockfile. Root regression now passes 233/235, with two intentional optional tokenizer skips. Root and data-validation typecheck pass.

## Task 2: complete

Browser verification passes 16 checks, with no console/page errors or external requests. Captures and combined source/implementation comparisons are saved in `docs/design/qa/`. `apps/research-prototype/design-qa.md` documents density/aspect normalization, visual changes and untested physical-device limitations; final result passed.

Production build passed. Prototype tests: 7/7 (three request validation regressions plus four original static packaging checks). Real model/data services were not called and the prototype was not deployed.

## Independent review and fix evidence

Fresh reviewer inspected the implementation against the specification, emphasizing cross-session timers, cancellation, target/scope validation, citations, focus restoration and recovery gating. It found one material issue: substring/keyword classification accepted unsupported target formats and token/chain/date scopes.

Two tests failed with the old classifier (`vitalik.eth.evil` and USDT balance). Replaced the classifier with whole-request matching and a finite set of contextual demo follow-ups; all three classifier tests then passed. Full browser suite rerun after the fix. No Critical/Important findings remain from that reviewed scope; no deferred minor findings.

## Final handoff

Preview runs at `http://127.0.0.1:4173/`. Data is marked as demonstration only, anchored to 2026-11-14. Session history resets on refresh. Scope remains the user-approved local prototype; real runtime connection and persistence require a subsequent implementation milestone.
