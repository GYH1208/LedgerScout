# Prototype Instructions

## Approved LedgerScout direction

User selected generated option 2 and approved its interaction scope on 2026-11-14: Apple-inspired white/gray/blue conversation workspace, left session list, center conversation, right evidence panel. Visual truth: `../../docs/design/selected-conversation-ui.png`. Specification: `../../docs/superpowers/specs/2026-11-14-web-ui-design.md`. This milestone is an in-memory interactive demo; do not silently connect providers or present sample data as real research.

On 2026-11-15 the user requested real testing. Live mode is separately available at `?mode=live`, using the existing Runtime via a loopback-only local adapter; see `../../docs/superpowers/specs/2026-11-15-web-live-design.md`. The default demo remains separate. Live mode must never use sample facts or fall back to them. Explicit `test:live` calls providers and incurs usage; ordinary tests remain offline.

The user subsequently selected SQLite for local single-user persistence and approved direct implementation. Web metadata lives in the ignored `runtime-results/web.sqlite`; raw evidence and checkpoints remain Runtime files. Startup/history viewing never calls suppliers; interrupted runs require explicit recovery. See `../../docs/superpowers/specs/2026-11-15-sqlite-session-design.md`. `test:persistence` uses actual local HTTP/SQLite/Pi Runtime with offline upstream responses in a temporary directory.

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

On 2026-11-16 the user approved the US-equity design and authorized offline implementation while applying for the free FMP key. Live equity view is `?mode=live&domain=us-equity`; retain the selected white/gray/blue layout and separate Ethereum entry. Never render sample stock facts in live mode. Keep actual source coverage, adjustment semantics, and PE availability visibly unverified until real credentials and share/price bases are checked. Market refresh and at-most-five-stock refresh remain explicit; no startup refresh or automatic batch continuation.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

On 2026-11-16, after live FMP ETF HTTP402 responses, the user explicitly approved Twelve Data free ETF pricing. Market readiness/status/quota must use TWELVE_DATA_API_KEY and the separate shared daily/pacing ledger; retain FMP+SEC company research. Never relabel old FMP market cache as Twelve Data or mix its unknown adjustment into ETF returns.
