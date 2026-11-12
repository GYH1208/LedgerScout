# Date window progress

User approved Etherscan and rolling168h / Asia-Shanghai semantics, then approved the written design for implementation. Windows tokenizer deferred.

Ruling: Work inline in existing feature branch feat/research-readiness; no worktree, dependency installation, push or merge.
Ruling: Original TimeWindow is durable before model requests; resolved mapping is committed with the existing query-boundary protocol. Interrupted mapping can repeat at the same timestamps and snapshot under cumulative budgets. This avoids referring to a source query.json that does not exist yet (independent builder-check finding).
Ruling: Calendar date input with future tail is clipped explicitly. Empty mined-block windows fail with a specific diagnostic rather than claiming a complete empty history.

Task1: parser tests RED missing module → GREEN; fixed a real regression where numeric UUID components were read as partial dates, via a deterministic failing query-ID test. Added unsupported/ambiguous temporal expression regressions.
Task2: four real HTTP fixture tests RED wrong ranges / ignored failures → GREEN. Verified mapping, adjacent headers, scoped requests, shared mapping and budget. A real combination query exposed oversized model previews in estimated mode; dedicated preview test RED→GREEN, full records/proof remain on disk.
Task3: real Pi date/recovery integration RED→GREEN; original timestamps retained across changed clock, remaining tool reuses source mapping, malformed checkpoint rejected before network. Existing supported-date refusal test updated to exercise genuinely unsupported dates.
Task4: real last-seven-day combined query completed with6normal /29incoming /2outgoing,12HTTP and4736reported tokens; evidence linked in integration record. Final independent code review completed and findings resolved (see below).

Pre-review:162tests,160pass/2optional tokenizer skips; both typechecks pass. Additional parser rejection tests are being incorporated before final verification.

Independent review:3Important initially: ignored date qualifiers, mapping source eviction at the32query cap, and cache publication before durable query save. All reproduced with failing regressions and fixed. Follow-up found direction-word over-rejection and old evidence satisfying a different requested date; those also reproduced RED→GREEN. Final focused reviewer independently reran50date parser/runtime tests and confirmed all reported Important findings resolved.

Ruling: Date qualifiers attach to parsed date spans, avoiding false positives on received transfers or transfer direction; unsupported qualifiers/timezones clarify. Explicit historical transaction/transfer evidence must match requested start/end timestamps; reference/clipped metadata may differ for the same absolute interval. Balance scope retains existing rules.
Ruling: Session query cap remains32, keeping mapping sources and dependents together and evicting an older unrelated query when required. Reusable mapping cache is published only after successful source query.json persistence.

Final verification: npm test183total/181pass/2optional tokenizer skips/0fail; npm run typecheck root and data-validation pass; git diff --check pass. Live-provider behavior was validated by the main executor; independent reviewer deliberately did not run billable calls. No API keys printed.

Delivery: User subsequently authorized committing these changes, merging into local main, and pushing main to origin. Actual delivery state is recorded by Git; fresh verification is required before commit and after merge.
