# Progress — docs/superpowers/plans/2026-11-11-run-resume.md

User requested merge into main then continue. main fast-forwarded from c5b3087 to f4ecdc6 after fresh91-test/typecheck verification; merged tree91/typecheck also passed. No remote push. Next feature isolated on feat/run-resume.

Decision: query-boundary checkpoints, explicit resume, no page cursor recovery. Completed tool results replay through Pi; pending read-only queries may restart first page at the same block. Cost: repeated HTTP attempts can occur for interrupted tools, charged to original cumulative budget.

Task 1 complete: bounded atomic checkpoints with verified query-file references; async pre-request reservation and persisted snapshot before data fetch. Snapshot assigned only after successful persistence, so subsequent queries cannot bypass a failed snapshot save.

Task 2 complete: four initial recovery integration tests RED→GREEN. Original model/tool/HTTP ceilings, cache, failure count and usage preserved; active time plus crash reservations carried forward. Source consumption links and child run IDs retained.

Task 3 complete: CLI constraints, real child-process exit recovery and checkpoint write failure tests pass. Independent review found3Important: orphan child activation, superseded cancelled query poisoning answer, terminal-close window. All reproduced RED→GREEN, fixed, independently rechecked. Extra query-finished/tool-end cancellation regression prevents completed queries being counted twice. Malformed counters now rejected before replay.

Decision: committed terminal resumable intent and immediate parent-link validation supplement checkpoint.closed; preserves evidence and prevents automatic source branching after a process exit. Single-process sessions remain the supported mode; no multiprocess coordination added.

Final verification: Node22.23.1 + LEDGERSCOUT_TEST_TOKENIZER=1运行npm test，106/106通过无跳过；npm run typecheck根与原数据模块通过；git diff --check通过。超大历史在写检查点前拟合、快照保存失败后重试不能绕过持久化、存储失败不声明resumable均有失败回归。No inference/data HTTP calls used; local tokenizer assets enabled for full verification.
