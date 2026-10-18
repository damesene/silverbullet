# Reindex performance: change log

Branch `perf/reindex`. Hashes change on rebase; the commit message is the stable reference.
Goal beyond this branch: parallelize indexing (several workers). Fewer main-thread messages per page then matter more than their measured gain today, so they count in favor of a change even when the time gain is small.
Test data: Obsidian Hub (6,715 files, ~445k index rows). Baseline on `main`: clearing ~45 s, full reindex ~1:40.

## 41d828dd `perf(index): clear the index with range deletes`

- **Why:** `clearIndex` read every index key and deleted them in chunks of 500, ~45 s before the progress bar appeared.
- **Measured:** clearing 45 s → 10.7 s, full reindex 1:40 → ~58 s (Vivaldi).

## acf5cecf `perf(index): keep the object index in a database of its own`

- **Why:** Chrome deletes a range, and even `store.clear()`, record by record (~23 µs/row, ~10 s). `deleteDatabase` is cheap. The index is disposable data, so it gets its own database `sb_index_<hash>`.
- **Discarded first attempt:** a separate object store in `sb_data_` (`clear()` measured 10.15 s, no gain).
- **Measured:** clearing 10.15 s → 6–21 ms. On LevelDB (Vivaldi 152 uses it even for new storage) part of the cost moves to background compaction (`enqueue` +2–4 s).
- **Known limitations:** dropping the database waits for other connections to close; until the version 15 reindex runs (needs the server version handshake) the index is empty, so an upgrade while offline has no index-backed scripts, styles or page list; a tab on an older client keeps using the legacy index until reloaded.
- **A/B** (headless Chromium 145, LevelDB, fresh profiles, 6 reindexes each, both with the flush fix below): range deletes only, median 47.1 s; separate database, median 37.3 s. That is ~10 s (~21 %) faster.

## 0f995fd2 `perf(index): flush tag changes once at the end of a full reindex`

- **Why:** an idle-flush feedback loop during reindex (live queries rescanned the `relation` tag, 18M rows). Randomly 240 s instead of 38 s (5 of 6 runs in headless tests).
- **Measured:** idle flush switched off at runtime: 3 × 37.4 s, stable (default: 39 / 38 / 240 s). On the build: 12 of 12 runs stable (36.6–48.9 s depending on variant), no 240 s run.

## 8aa56849 `perf(index): write batches without a promise per row`

- **Why:** each of ~459k written rows got its own idb promise and request callback on the main thread; only `tx.done` matters (a failed request aborts the transaction). Also: a batch failing part way no longer commits the rows before the failure.
- **Measured** (headless, 2 profiles × 3 reindexes, without the measurement commit): median 39.9 s → 35.8 s (~10 %), consistent in both profiles.

## 8896bcb9 `perf(index): read query ranges in chunks with getAll`

- **Why:** `query()` used a cursor, one task per row, for every index scan and queue poll. Now getAllKeys + getAll in chunks of 16 doubling to 1024 (small first chunk for queue polls that stop early).
- **Measured, reindex:** median 39.8 s, no proven gain (within noise). Expected: a reindex reads little (~8k rows).
- **Measured, reads** (headless, raw `query` of a whole tag, 2 alternating rounds × 7 repeats): `relation` (104k rows) 1158/1091 → 707/682 ms (~38 % faster); `page` (6.6k rows) 62.6 → 38 ms (~40 %); first 8 rows (queue poll pattern) 0.3 → 0.2 ms, no regression.

## (removed) c8fa4309 `perf(index): skip the per-page aspiring-page lookup during a full reindex`

- **Why:** every indexed page queried all `aspiring-page` records with a Lua `where` (2 syscalls per page, ~26k messages; quadratic with many broken links, the MDN 30+ min case). The cleanup moved from `page.ts` to `queue.ts`; full-reindex messages carry `reindex: true` and skip it, and one pass at the end of the reindex drops aspiring records whose page exists (also removes their `ridx` entries).
- **Discarded first attempt:** dropping the cleanup entirely and relying on `invalidate.ts`. Review: that path is in-memory and debounced, can miss files, and new pages would show twice (page + aspiring) until linking pages are re-indexed.
- **Not covered:** the fresh-install initial index and incremental indexing still query per page (MDN first index stays quadratic). Fix for all paths: look up aspiring records by name via a dedicated key (option B).
- **Measured, Obsidian Hub** (headless, 2 alternating rounds × 3 reindexes): median 36.0 s → 36.0 s, no difference. Expected: few broken links (~1k aspiring records), so the per-page query was cheap there. The target case (MDN-like, many broken links) is not measured yet.
- **Status:** removed from the branch at the user's request (no measurable gain on Obsidian Hub). Can be brought back for an MDN-like space.
- **Measurement was flawed:** the A/B swapped only `client_bundle/client` (`build:client`). Plug code (`plugs/index/*`, built by `build:plugs` into `client_bundle/base_fs`) stayed at the `main` version in both variants, so the queue-side half of this change (skipping the per-page query) was never measured. Re-measure before deciding.
- **Re-measured with full bundles** (2 rounds × 3 reindexes), but round 2 ran while I built bundles and ran tests on the same machine, so it is invalid. Round 1 only: base 37.3 s, with this commit 35.0 s (3 runs each, too few to conclude). The removal may not have been justified; to be re-measured without background load.
- **Re-measured, clean** (3 rounds × 3 reindexes, nothing else running): round medians base / this commit 35.7 / 35.9, 35.4 / 36.0, 41.5 / 35.7 s (base outlier in round 3). No measurable time difference on Obsidian Hub; saves ~13k messages per reindex (2 per page), which counts toward parallel indexing. Replaced by option B (049b1493).

## 246b3b7e `perf(index): read indexer config once per queue batch`

- **Why:** `item.ts` (3 keys) and `paragraph.ts` (1 key) called `system.getConfig` for every page, 26.5k round trips per reindex (~15 % of all worker messages). Values are now cached for one queue batch (`config_cache.ts`); outside a batch reads go straight to the config, and a change applies from the next batch. Cached values are shared by the pages of a batch, so `indexConfig` returns a `DeepReadonly<T>` type (the user preferred read-only types over `Object.freeze`). Later fix (found by the parallel-index review): overlapping batches in one worker share the cache through a counter, so the cache cannot be left behind.
- **Measured** (headless, full bundles): round 2 invalid (builds and tests ran in parallel). Round 1 only: 37.3 s → 35.6 s (3 runs each, too few to conclude).
- **Re-measured, clean** (3 rounds × 3 reindexes, nothing else running): round medians base / this commit 35.7 / 35.7, 35.4 / 34.2, 41.5 / 36.4 s (base outlier in round 3). Equal or ~1 s faster; ~23k fewer messages per reindex.

## db7401ac `perf(index): poll index progress every 200 ms`

- **Why:** the progress loop polled `mq.getQueueStats` (3 `count()` calls over the queue) every 40 ms, ~620 times per reindex. Now 200 ms (first 1 s, the user chose 200 ms as a compromise for a smoother progress bar).
- **Measured** (headless, full bundles, 3 rounds × 3 reindexes, nothing else running): faster than the previous commit in every round, round medians 42.4 → 40.2, 42.2 → 40.7, 40.9 → 34.6 s; overall median 42.2 → 40.2 s (~5 %). Absolute times drift between rounds, compare within a round. Measured with the 1 s interval.
- **Measured, 200 ms** (3 rounds × 3 reindexes, against the config commit): round medians 35.2 / 35.8, 35.6 / 34.7, 36.0 / 34.9 s; overall median 35.6 → 34.9 s (~2 %), faster in 2 of 3 rounds. Less than with 1 s (~5 %), as expected with 5× more polls.

## (removed) a7f51b03 `perf(index): process the index queue in batches of 32`

- **Why:** each batch of 8 cost a poll, a sync readiness check and an ack round trip (~840 each per reindex). The lease is renewed on an interval while a batch runs, so larger batches are safe.
- **Trade-offs:** higher peak memory (32 pages in flight), an edited page waits longer behind a running batch during bulk indexing, a crash mid-batch redoes 32 files.
- **Measured** (same run): faster than the progress commit in every round, 40.2 → 39.3, 40.7 → 39.4, 34.6 → 34.0 s; overall median 40.2 → 39.1 s (~2–3 %).
- **Status:** removed at the user's request: the gain is small and the trade-offs are real; batch size stays 8 (to revisit with parallel indexing).

## (moved to branch `perf/aspiring-by-name`) 049b1493 `perf(index): drop aspiring pages by name when their page is indexed`

- **Why:** option B for the aspiring-page cleanup (replaces the removed c8fa4309). Every aspiring-page record gets a secondary key `["$aspiring-page-by-name", name, ref]` (written like any object, so `ridx` and `clearFileIndex` drop it). When `indexObjects` gets a page object, it drops the records pointing at that page by a range lookup on that key, on the main thread. Removes the plug-side Lua query over the whole tag: no messages at all instead of 2 per page, on every path (reindex, first index, edits), so it also fixes the MDN quadratic case.
- **Details:** only real page objects count (not items tagged `#page`); a by-name key can be stale, so the record's name is checked before deleting. `MemoryKvPrimitives` prefix matching now matches whole key parts like IndexedDB (tests and mock relied on raw string prefixes). Index version 16.
- **Not done (review):** a generic secondary-key mechanism; the key lives under `idx`, so it is queryable as a tag and fires its own tag-changed event; one extra IndexedDB read per indexed page.
- **Measured** (headless, 3 rounds × 3 reindexes, against the 200 ms commit): **slower** in every round, 34.1 → 36.7, 33.9 → 36.5, 34.9 → 36.9 s; median 34.1 → 36.7 s (+2.6 s, ~8 %); first index in a fresh profile +1.5–3.5 s. Likely cause (not verified): one IndexedDB read transaction per indexed page on the main thread, while on Obsidian Hub the old per-page query ran against a rarely invalidated in-memory memo. Proposed: skip the lookup during a full reindex and drop resolved records in one pass over the by-name keys at the end.
- **Status:** removed from `perf/reindex` at the user's request and kept on branch `perf/aspiring-by-name` (based on b51f6da2) to come back to later, e.g. with the proposed reindex skip or for MDN-like spaces.

## bfd2ea55 `perf(index): batch link target lookups of concurrently indexed pages`

- **Why:** `relation.ts` called `space.lookupPaths` once per page (~6.4k calls per reindex). The syscall takes an array and its results are per path, so lookups of concurrently indexed pages are collected and sent as one syscall (`batched_lookup.ts`); each caller gets only its own paths. No API change.
- **Counted** (headless, measurement bundle, 1 reindex): collecting within one task (0 ms) → 4,934 calls (−23 %); a 10 ms window → 876 calls (−86 %, about one per batch).
- **Measured** (headless, against b51f6da2; YouTube was started during round 2, so only round 1 and part of round 2 are clean): no batching 42.4 / 39.4 s, 0 ms window 41.4 / 35.7 s, 10 ms window 47.5 / 46.1 s (round medians). **10 ms window rejected** (+5–7 s: pages wait while batches run one after another). 0 ms looks slightly faster but needs a clean re-measure.
- **Re-measured, clean** (rounds 1–2 complete; round 3 was cut off when the session ended and its last run overlapped a build): round medians no batching / 0 ms 35.2 / 34.3, 33.9 / 34.1 s. No measurable time difference; −23 % `lookupPaths` calls (~3k messages per reindex). Recommended to keep for parallel indexing; user decision pending.

## eb4d7b5e `perf(index): write the objects of concurrently indexed pages in one transaction`

- **Why:** each page ended with its own `index.indexObjects` syscall and IndexedDB transaction. New, additive syscall `index.indexObjectsBatch(entries)` (documented in `docs/API/index.md`; `index.indexObjects` unchanged) writes several pages in one transaction; the indexer coalesces the writes of concurrently indexed pages through `collect.ts` (same helper as the lookup batching).
- **Review fixes:** a failing entry (e.g. a throwing tag transform) no longer fails the whole batch: the others are written and each caller gets its own error (`collectWithinTask` returns per-item results; `indexObjectsBatch` returns an error message or null per entry).
- **Counted** (headless, measurement bundle, 1 reindex): messages ~122k → ~111k (−9 %), IndexedDB transactions ~12.5k → ~8.7k (−30 %), 4,207 batched writes instead of 6,701 per-page ones (77 single writes left, for documents).
- **Measured** (headless, 3 rounds × 3 reindexes, against 97748e8f): round medians 39.2 / 39.2, 40.2 / 39.8, 41.3 / 40.1 s; median 40.2 → 39.8 s, within noise (equal or slightly faster, not slower; a single quick round had suggested slower). First index unchanged. Kept by the user. Note: evening absolute times were ~40 s vs ~35 s earlier in the day; the machine was not busier, the cause is unknown.

## e6d7aae1 `chore(index): log reindex phase timings and traffic counters`

- **Why:** `[reindex-timing]` logs and counters for comparing runs. Measurement aid only, revert before a PR.

## Current state (all commits above)

- Vivaldi 152, Obsidian Hub: full reindex **1:40 → 40.5 s** (clearing 0.45 s, enqueue 3.3 s, indexing 36.5 s), up to the flush fix.
- With the write and read commits: 39.7 s (one run), then 42.2 / 46.3 / 45.3 s (3 consecutive runs). Same workload in every run; the headless gain (~4 s) does not show in Vivaldi: either a larger error there or different behavior in that browser. Times grow with each reindex on the same storage.
- Controlled A/B in Vivaldi (Clear site data, 3 reindexes each, both with the measurement logs): base `0f995fd2` 43.0 / 41.4 / 42.6 s (median 42.6 s, indexing 38.7 s); with the write and read commits 39.8 / 40.0 / 39.4 s (median 39.8 s, indexing 36.0 s). **~2.8 s (~7 %) faster**, non-overlapping ranges; smaller than headless (~10 %).

## (experiment, branch `perf/worker-parse`) da94253e `perf(index): parse and index pages in the index worker`

- **Why:** the trace (Vivaldi, 10 s mid-reindex) showed the main thread busy ~55 %, mostly handling worker messages: `postMessage` ~1.4 s, IndexedDB `put` ~1.3 s, per-request task overhead ~1.4 s; markdown parsing itself only ~30 ms. The page tree crossed threads 3× per page (parse result, `page:index` dispatch, delivery back to the index plug). Now the index plug parses in its worker with the same language as `markdown.parseMarkdown` (built-in syntax + `syntaxExtensions`) and calls its indexers directly; `page:index` is still dispatched, with the same payload and before indexing adds parent pointers, but only when others listen to it.
- **Public API unchanged:** the `markdown.parseMarkdown` syscall and the `page:index` event stay. Behavior change: the index plug no longer listens to its own `page:index`, so dispatching it from elsewhere no longer makes the index plug re-index a page (not documented, nothing in the repo does it).
- **Cost:** index plug 147 kB → 774 kB (parser, Lezer, YAML and Lua grammars).
- **Measured** (headless, 3 rounds × 3 reindexes, against b51f6da2): round medians 40.6 / 39.9, 41.3 / 37.7, 39.9 / 40.1 s; median 40.6 → 39.9 s (~2 %), faster in 2 of 3 rounds. First index: within noise. Small and uncertain with one worker; expected to matter more with parallel indexing.

## (prototype, branch `perf/parallel-index`) parallel indexing in two workers

Commits on top of perf/reindex (e6d7aae1): `6ef2600c` perf(index): parse and index pages in the index worker (the worker-parse commit, needed so the indexers run in the queue's worker); `2b048215` fix(mq): support several consumers of a queue in one window; `12735ca6` feat(plugos): run queue subscriptions in several plug workers; `8ccbf80e` perf(index): index in two workers.
- **What:** a plug can have further instances (workers); an mqSubscription takes an optional `workers` field (additive, validated, documented) and gets one consumer per instance. The MQ serializes polls per queue within a window, does not hand out a message identical to one in flight, announces a drain only when no consumer of the window has a batch in flight, wakes every waiting consumer, and survives poll errors. Further instances are started up front (started on first use they missed the 5 s manifest timeout while the main thread was busy), are named so plug code can tell (`isMainPlugInstance`, used to run the progress loop once), and are not restarted after the plug stops.
- **Verified:** after a reindex the index matches perf/reindex exactly (445,430 rows, 6,624 pages, 104,213 relations, 29 tasks, 69 aspiring pages), queue empty, no new console errors. Messages per reindex ~111k → ~71k (worker parsing).
- **Measured** (headless, 3 rounds × 3 reindexes, all with the measurement commit): round medians perf/reindex / + worker parsing / + 2 workers: 40.7 / 40.2 / 38.1, 41.7 / 40.2 / 37.0, 41.4 / 39.3 / 37.5 s; medians 41.4 / 40.2 / 37.8 s. Two workers: −3.6 s (~9 %) vs perf/reindex, consistent in every round; the indexing phase ~36 → ~32.5 s. Worker parsing alone: −1.2 s, consistent. Messages ~118k → ~71k; IDB transactions 8.7k → 7.1k. Modest, as expected: the main thread (IDB value serialization, message handling) stays the bottleneck.
- **Worker count** (3 rounds × 3 reindexes): 2 / 3 / 4 workers, medians 36.6 / 36.6 / 35.8 s, indexing phase 32.6 / 31.8 / 30.9 s. Saturated after 2 (~0.8 s per extra worker, within noise); first index tends to get slower with more workers starting at once. Kept at 2.
- **Status:** stays on its own branch (the biggest change for upstream: manifest field, MQ and plugos changes); to be offered as a separate proposal.

## Checked, no change needed

- **Idle-flush loop during the first index of a fresh install** (the flush fix only covers `rebuildInProgress`): 5 fresh headless profiles, first index 34–43 s, ~175 tag events and 20–60k rows read each (the loop: ~1,650 events, 18M rows). Not reproduced; likely because index-backed scripts and widgets do not run before `fullIndexCompleted`.

## Measurement notes

- Nothing else may run on the machine during a measurement (no builds, no tests, no video playback); on 2026-10-17 round 2 of one A/B was invalidated this way.
- A variant bundle must be a full `npm run build` (plugs + client) and the whole `client_bundle` (`client` and `base_fs`) must be swapped. Until 2026-10-17 ~15:00 only `client` was swapped: client-side changes were measured correctly, plug-side ones were not.

- Each change is measured in both: the headless A/B benchmark (Playwright Chromium, LevelDB, fresh profiles, alternating variants, without the measurement commit) and Vivaldi. Vivaldi results may have a larger error, or the change may behave differently there; record both and note when they disagree.
- Measure on fresh storage (Clear site data); LevelDB slows down after repeated reindexes.
- The open page matters: live queries (references) can multiply reindex time.
