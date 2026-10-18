# Reindex performance: original investigation (2026-10-16/17)

Findings from the profiling session that started the work on branch `perf/reindex`, before any
change was made. Code references are against `main` at commit `0a9d136` (2026-10-16); line numbers
are approximate. Some conclusions were revised later (see `PERF-CONTEXT.local.md` and
`PERF-CHANGES.local.md`): e.g. a separate index database replaced the range delete, the aspiring-page
fixes did not pay off on Obsidian Hub, and parallel indexing saturates at two workers.

## Goal

Make a full space reindex (`Space: Reindex`) fast. The user runs SilverBullet in Docker and plans to
store "Notion-style database" records as one page per record with frontmatter, rendered by custom
widgets (e.g. a ` ```timeline ` fenced block). Long reindex time is the concern.

## Test data and measurements

| Dataset | Pages | Links | Full reindex |
|---|---|---|---|
| MDN content (`mdn/content`, only `.md`) | 14,723 | most links are absolute URLs like `/en-US/docs/...`, so almost all become broken links | 30+ min, gets slower over time |
| Obsidian Hub (`obsidian-community/obsidian-hub`, only `.md`) | 6,566 | 42,381 wikilinks, 99.6% resolve | ~30 s with no progress bar, then ~90 s with progress, ~2 min total |

Other candidates checked: `obsidianmd/obsidian-help` (6,489 files, 95% links resolve, but ~35 language
copies with the same page names, so ambiguous links); `dendronhq/dendron-site` (1,016 files, 76% broken).

Silversearch was enabled during tests and adds cost; its share was not isolated.

IndexedDB micro-benchmark in the user's browser: 10,000 `put`s in separate transactions 1905 ms,
in one transaction 253 ms (~0.19 ms per transaction). Conclusion: transaction commit cost is NOT the bottleneck.

## Chrome performance traces (DevTools, ~6 to 10 s windows during reindex)

1. MDN, normal page open: main thread busy ~68%, index plug worker idle >98%. 317k tasks and
   6M microtasks in 6.4 s. Nearly every task is one IndexedDB cursor step (one row read).
   Largest tasks (~40 ms) contained ~375k microtasks each = `memoLuaQuery` running an async Lua
   `where` over every row. Indexing work itself (parse ~18 ms, `batchSet` ~43 ms) was negligible.
2. MDN, empty page, side panels closed: same picture (main ~65% busy, worker 98% idle,
   412k cursor tasks, 8.5M microtasks in 10.5 s). So it is not UI widgets.
   Call path seen: `worker.onmessage -> syscall -> queryLuaObjects -> memoLuaQuery`.
3. Obsidian Hub: microtasks 283k total (30x fewer), largest batch 1,191, `memoLuaQuery` ~0,
   ~5x more worker/main messages per second (more pages per second). Worker ~10% busy.
   Main thread now: IndexedDB `put` ~11% self, `postMessage` ~8% on both sides, ~106k IDB request
   callbacks (one task per written row), markdown parse ~1.5%, file reads ~1%. Main thread is still
   the bottleneck; worker mostly idle.

## Root causes found in code

### 1. Quadratic "aspiring page" lookup during indexing (main cause for MDN)

`plugs/index/page.ts` (~line 58, has a `TODO: This can possibly done more optimally`):
for EVERY indexed page it runs
`index.queryLuaObjects("aspiring-page", { where: _.name == pageRef })` to delete broken-link records
that point to the page being indexed.

- `memoLuaQuery` (`client/data/object_index.ts`) has no index by name: it materializes the whole
  `aspiring-page` tag range (`scanTagRawRows`, IndexedDB cursor, one task per row) and evaluates the
  Lua `where` per row (`await matchesWhere`, many microtasks per row).
- Every index write goes through `writeInvalidating`, which drops the scan memo for the written tags,
  so the next page rescans everything from IndexedDB.
- Aspiring pages are created in `plugs/index/relation.ts` (~line 751) when a link target file does not
  exist (checked against the file list via `space.lookupPaths`, not against the index).
- Cost per page grows with the number of aspiring records already indexed: total ~ k * n^2 / 2
  (k = broken links per page, n = pages). Negligible for spaces with few broken links, catastrophic
  for MDN-like data.

Fix options:
- A (simplest): skip this query during a full reindex and run one linear cleanup pass at the end
  (build a Set of page names once, scan aspiring records once, delete those whose target exists).
  Hook: the index queue emits `mq:emptyQueue:indexQueue`. Keep the per-page check for incremental
  (single page) indexing. During a full reindex the index is cleared first and aspiring records are
  only created for missing files, so the query is effectively a no-op; edge case: files created
  during the reindex (also covered by `plugs/index/invalidate.ts`, which reindexes pages with broken
  links to a newly appeared name).
- B (behavior 1:1): look up aspiring records by target name via a dedicated key instead of a full
  scan with a Lua filter. Needs an extra key in the index and a one time reindex.

### 2. `clearIndex` walks every key (the ~30 s with no progress bar)

`ObjectIndex.reindexSpaceUnlocked` -> `clearIndex()` (`client/data/object_index.ts` ~line 845):
cursor-iterates all `idx` and reverse `pageKey` keys into an array, then deletes them in chunks of
500 sequentially. The progress bar is driven by the index queue, which is still empty then.

Fix: delete each prefix with a single range request, `store.delete(IDBKeyRange.bound(prefix+"", prefix+"￿"))`
(same key building as `IndexedDBKvPrimitives.countQuery`). Expected ~30 s -> < 1 s, same semantics.
Note the object store is shared with other prefixes (e.g. `mq`), so do not use `store.clear()`.

### 3. Per-row promise overhead in IndexedDB writes and reads

`client/data/indexeddb_kv_primitives.ts`:
- `batchSet` / `batchDelete` use one transaction (good) but `Promise.all(entries.map(put))` with the
  `idb` wrapper creates a promise and a JS callback task per row. Only `tx.done` needs awaiting.
- `query()` iterates with an async cursor (`tx.store.iterate`): one request and one task per row plus
  async generator microtasks. Use `getAll(range)` + `getAllKeys(range)` (optionally chunked) instead.
  Affects every Lua query, page list, widgets, boot.

### 4. Smaller items

- `plugs/index/queue.ts` `updateIndexProgressInUI` polls `mq.getQueueStats` every 40 ms
  (3 IndexedDB `count()` calls over the queue). 1 s is enough.
- Markdown is parsed outside the worker (`markdown.parseMarkdown` syscall) and the full AST is
  serialized across `postMessage` several times (parse result, `page:index` event dispatch).
- Async `matchesWhere` per row in `memoLuaQuery`; a synchronous fast path for simple expressions
  would speed up every query with `where`.
- Incremental memo patching instead of dropping the whole tag memo on each write (helps live widgets
  while typing; not needed for reindex if fix 1 is done).

## Verified non-issues

- Index writes are already batched per page: about 3 to 4 transactions per page.
- `mq.poll` uses an early-terminating cursor (comment in code mentions an earlier quadratic version).
- Files not yet delivered by sync are deferred, not re-downloaded.
- Parallelizing the indexer will not help yet: the index plug worker is idle most of the time,
  the main thread is the bottleneck. On 8C/16T, Amdahl estimate after fixes is ~3 to 6x at best.

## Expected gains (rough, from short traces)

- MDN: fix 1 alone ~30 min -> ~2 to 5 min; with 2 and 3, roughly 10x total.
- Typical space (few broken links, e.g. Obsidian Hub ~2 min): fix 2 saves ~30 s; fix 3 maybe 1.5 to 2x
  on the indexing phase. Total roughly 2 min -> ~1 min.

## Suggested order of work

1. Fix 2 (range delete in `clearIndex`): smallest, safe, measurable immediately.
2. Fix 1 option A (defer aspiring cleanup to end of full reindex), with a test: link to a missing page,
   create the page, verify the broken-link record disappears (both incremental and full reindex paths).
3. Fix 3 (`batchSet` without per-row promises; `getAll` in `query`).
4. Re-measure with Obsidian Hub and MDN (DevTools Performance trace + wall clock).
5. Optionally upstream as issues/PRs.
