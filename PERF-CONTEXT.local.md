# Reindex performance work: context for a new session

Personal notes, committed on branch `perf/reindex` only (drop that commit before an upstream PR).
Read this together with `PERF-INVESTIGATION.local.md` (original profiling notes from 2026-10-16/17),
`PERF-CHANGES.local.md` (one entry per commit: why, measurements) and `CLAUDE.local.md` (general,
not committed: environment, build, pitfalls). State as of 2026-10-18.

**Status: paused by the user on 2026-10-18.** Nothing is in progress. To resume, read "Where the main thread time goes" and "Ideas for later" below.

## Goal and constraints

- Make a full `Space: Reindex` fast; later parallelize indexing (several workers). The main thread is the bottleneck, so fewer main-thread messages per page count even when the time gain is small.
- **The public API must not change** (syscalls, events and their payloads, plug manifest semantics). Adding a new syscall is an addition, but ask the user first.
- Changes the upstream author would hardly accept are out (e.g. changing what index objects contain).
- Each change is its own commit on `perf/reindex`, with a **one-line message, no body, no AI/Co-Authored-By signature**. Fixups go into the right commit (`git commit --fixup` + `rebase -i --autosquash`).
- Never drop/revert a commit without the user's approval; report results and recommend.
- After each change: code review (`/code-review` skill), fix findings, run tests, then measure (headless A/B by me, Vivaldi manually by the user), then update `PERF-CHANGES.local.md`.
- Reply to the user in Czech; files, commits and code in English.

## Environment

- Repo `D:\git\silverbullet`, Windows, Git Bash + PowerShell. Node 24 via nvm-windows (`.nvmrc` 24.13.0; 24.22 in use). Rust stable via rustup, VS Build Tools (MSVC) installed.
- Debug server: `cargo build -p silverbullet` once. The debug build reads `client_bundle/` from disk at runtime (rust-embed without `debug-embed`), so no server rebuild is needed after a JS build.
- **`client_bundle/client`** comes from `npm run build:client` (client code, `client/**`). **`client_bundle/base_fs`** comes from `npm run build:plugs` (plug code, `plugs/**`, e.g. `Library/Std/Plugs/index.plug.js`). `npm run build` does both. A plug change is invisible with `build:client` alone.
- User's server: `SB_DISABLE_SERVICE_WORKER=1 ./target/debug/silverbullet.exe --single -p 3001 d:\download\sb-space` (Obsidian Hub copy, 6,715 files, ~445k index rows). User measures there in **Vivaldi 152** (Chromium, IndexedDB on **LevelDB**, even for freshly created storage).
- Benchmark server: port **3002** on a copy of the same space (the copy was in this session's scratchpad; recreate with `cp -r /d/download/sb-space <dir>` and start a second server on 3002).
- Playwright Chromium (headless shell 145, LevelDB) installed via `npx playwright install chromium`. Vivaldi cannot be driven by Playwright (exits immediately, likely a pending update), and the user measures Vivaldi manually anyway.

## Branches

- `perf/reindex` (main work, on top of `main` 0a9d1369):
  1. `41d828dd` perf(index): clear the index with range deletes
  2. `acf5cecf` perf(index): keep the object index in a database of its own
  3. `0f995fd2` perf(index): flush tag changes once at the end of a full reindex
  4. `8aa56849` perf(index): write batches without a promise per row
  5. `8896bcb9` perf(index): read query ranges in chunks with getAll
  6. `246b3b7e` perf(index): read indexer config once per queue batch
  7. `db7401ac` perf(index): poll index progress every 200 ms
  8. `bfd2ea55` perf(index): batch link target lookups of concurrently indexed pages (no measurable time change, −23 % lookups; kept)
  9. `eb4d7b5e` perf(index): write the objects of concurrently indexed pages in one transaction (new additive syscall `index.indexObjectsBatch`, documented in docs/API/index.md; −30 % transactions, −9 % messages; time within noise; kept)
  10. `e6d7aae1` chore(index): log reindex phase timings and traffic counters (**measurement only, revert before a PR**)
- `perf/aspiring-by-name` (`049b1493`, on b51f6da2): aspiring pages dropped via a by-name secondary key. Measured +2.6 s slower on Obsidian Hub (one IndexedDB read per page); idea for later: skip the lookup during a full reindex, one pass at the end.
- `perf/worker-parse` (`da94253e`, on the old measurement commit 256a5800): index plug parses in its worker and calls its indexers directly; `page:index` dispatched only when others listen (behavior change: dispatching `page:index` from elsewhere no longer makes the index plug re-index; undocumented use). −0.7 s at first, −1.2 s consistent on the newer base; messages ~118k → ~71k; plug 147 kB → 774 kB. Also contained in `perf/parallel-index` (as 6ef2600c).
- `perf/parallel-index` (prototype, on e6d7aae1): worker parsing + several queue consumers in separate plug workers (`workers: 2` for the index queue), with MQ fixes for several consumers per window. Index verified identical to perf/reindex; A/B: −3.6 s (~9 %) vs perf/reindex, consistent; saturated at 2 workers (3–4 add ~0.8 s each, within noise). Kept as a separate branch / proposal, not merged into perf/reindex. See PERF-CHANGES.local.md.
- Reflog only: `c8fa4309` (skip per-page aspiring lookup during reindex via `reindex: true` queue flag + end pass); removed, re-measure inconclusive. `a7f51b03` (queue batch size 32): removed by the user (small gain, real trade-offs).

## Results so far (Obsidian Hub)

- Baseline `main`: clearing ~45 s, full reindex ~1:40 (Vivaldi).
- `perf/reindex` (Vivaldi, fresh storage, 3 runs): ~39.8 s; headless ~35–41 s (absolute times drift between sessions, cause unknown; the machine was not busier).
- `perf/parallel-index` (headless): ~3.6 s (~9 %) faster than perf/reindex.
- Per change (details in `PERF-CHANGES.local.md`): range delete 45 → 10.7 s clearing; separate DB: clearing ~10 ms, A/B −10 s (~21 %) vs range delete only; flush fix: removes a random 240 s mode (5 of 6 runs); writes ~10 % (Vivaldi ~7 %); reads ~40 % faster raw tag reads, no reindex effect; config cache: no time effect, −23k messages; progress 200 ms: ~2 % (1 s interval gave ~5 %).

## Key findings

- **Idle-flush loop** (fixed in 0f995fd2): during a reindex, tag-change events flushed after 500 ms without writes; live queries on the open page (references panel) then rescanned the whole `relation` tag (~1 s each), which stalled writes into the next 500 ms gap. 1,658 events and 18M rows read instead of 95 events. Not present during the first index of a fresh install (checked, 5 profiles).
- **IndexedDB in Chrome/LevelDB**: range delete and `store.clear()` are record by record (~23 µs/row). `deleteDatabase` returns in ms, but LevelDB compacts in the background, which slows the following writes (`enqueue` 0.5–1 s → 2.7–4.4 s). Net still −10 s. All databases of an origin share one LevelDB. LevelDB slows down after many reindexes on the same storage: measure on fresh storage (Clear site data).
- **Trace after the changes** (Vivaldi, 10 s mid-reindex, `d:\download\Trace-20261017T192234.json.gz`): main thread ~55 % busy, worker ~17 %. Main thread: `postMessage` ~1.4 s, IndexedDB `put` ~1.3 s, per-request task overhead ~1.4 s (196k tasks, IDB request completions fire even without listeners), microtasks ~1.75 s (inflated by DevTools async stack tracking), markdown parsing only ~30 ms. ~5.9k network requests (page reads; the test server runs without service worker).
- Per page today: ~12 round trips (`readPageWithMeta`, `parseMarkdown`, `event.dispatch` page:index, `lookupPaths`, `indexObjects`, `queryLuaObjects` + `parseExpression` for aspiring pages, `getConfig` (now per batch), `areFilesReadyToIndex`/`batchAck`/poll per batch of 8).

## Measurement method

- Scripts in `D:\git\silverbullet\.perf-bench\` (excluded from git):
  - `bench.mjs <label> <runs>`: fresh Playwright profile, opens `http://localhost:3002/obsidian-hub-main/README` (an existing page; a missing page shows live queries that dominate), waits for `client.fullIndexCompleted`, runs `client.objectIndex.reindexSpace()` N times, appends to `results.jsonl` (with `[reindex-timing] summary` when the bundle has the measurement commit).
  - `qbench.mjs`: raw `indexDs.query` timings per tag. `initial.mjs`: first index in fresh profiles (tag events, rows). `scans*.mjs`: rows read per key prefix and call sites during a reindex. `overview.py`, `profile.py`, `slices.py`: Chrome trace analysis (`python -I <script> <trace.json.gz>`).
- A/B procedure: for each variant, check it out in a separate worktree, `npm run build` (needs `version.json` copied in and `node_modules` as a junction to the main repo), copy **both** `client_bundle/client` and `client_bundle/base_fs` aside; then alternate variants per round (3 rounds × 3 reindexes, one fresh profile each), swapping the whole `client_bundle` before each run; at the end run `npm run build` on the branch to restore. Compare within a round (absolute times drift by several seconds between rounds and sessions).
- **Nothing else may run during a benchmark** (no builds, no tests): it invalidated one round once.
- The measurement commit's logs: `[reindex-timing]` phases and a JSON `summary` with `sbIdbStats` (transactions, writes, rows scanned, counts) and `sbWorkerStats` (messages, syscalls by name) deltas.

## Pitfalls hit

- Writing files with Python on Windows in text mode produces CRLF; use `open(..., newline='')`. Biome format normalizes to LF.
- Escapes typed into tool input are decoded first: `"\uffff"`, `"\0"`, `"\\$"` end up as literal characters or different escapes. Check bytes (`od -c`) or build strings with `chr()`.
- `MemoryKvPrimitives` matched prefixes as raw strings until `deletePrefix` (and, on the by-name branch, `query`/`countQuery`) were aligned with IndexedDB whole-part matching; on `perf/reindex` only `deletePrefix` is aligned.
- Background tasks of a previous session can keep running as orphaned processes after the session ends (check with `Get-CimInstance Win32_Process` for `bench.mjs`), and a benchmark leaves a variant bundle in `client_bundle` when interrupted: rebuild with `npm run build`.
- `build/build_freshness.test.ts` fails on Windows on `main` too (path separators); ignore.
- Switching the data DB schema version (an intermediate attempt used v2) breaks older code with `VersionError`; the user had to delete `sb_data_*` once.

## Where the main thread time goes

The main thread is the bottleneck; the worker sits mostly idle. From the Vivaldi trace (10 s mid-reindex, perf/reindex as of 2026-10-17 afternoon, before worker parsing and batched writes):

| What | ~time of 10 s | Why |
|---|---|---|
| IndexedDB `put` | 1.3 s | structured clone of ~459k values (~68 objects per page) |
| Task overhead | 1.4 s | ~196k tasks, mostly IDB request completion events (fired even without listeners) plus incoming worker messages |
| `postMessage` | 1.4 s | copying data between threads (page text, objects to store, syscall results, the page tree at the time) |
| Microtasks | 1.75 s | `async/await` chains in syscall handling; inflated by DevTools async stack tracking |
| `(program)` | 5.2 s | native work the profile does not break down; overlaps the rows above |
| Index logic (JS) | < 0.7 s | object processing, keys, cache invalidation |

So the cost is moving data (between threads, and into IndexedDB one object per row), not the indexing logic. It grows with the number of objects, not pages. Worker parsing and batched writes already cut messages (~118k → ~71k) and transactions (−30 %). More workers saturate at 2 because they only hand the main thread work faster. No fresh trace exists for the current branches; one can be recorded headless via Playwright (CDP tracing) and analyzed with `.perf-bench/*.py`.

## Ideas for later

- **IndexedDB writes from the worker** (IDB is available in workers): the main thread would not take part in writes at all. Needs `ObjectIndex` (scan memo, tag-change events) reworked; big change.
- **Fewer rows** (store a page's objects together): changes the index layout and tag queries; unlikely to be accepted upstream.
- Smaller values: ruled out by the user (changes what index objects contain).
- **Aspiring pages for MDN-like spaces**: `perf/aspiring-by-name`, plus skipping the per-page lookup during a full reindex with one pass at the end (the by-name key makes that pass cheap).
- **Query/widget speed while working** (not reindex): incremental scan-memo updates instead of dropping a tag's memo on every write, and a synchronous fast path for simple `where` expressions. Relevant for the planned record pages with widgets.
- **Parallel indexing**: `perf/parallel-index` as a separate upstream proposal (adds a manifest field and MQ/plugos changes). Open: atomic message claiming across windows (an IDB readwrite transaction instead of the in-memory poll lock).
- **Upstream**: before any PR, drop the measurement commit (`e6d7aae1`) and the commit with these notes, and decide whether `index.indexObjectsBatch` (new syscall) is offered.

## State left behind (2026-10-18)

- Checked out: `main`, with its full build in `client_bundle` (switched at the user's request). To resume, `git switch perf/reindex && npm run build` (or another branch).
- Browser storage written by the branches (index in `sb_index_*`, index version 15/16, legacy rows removed from `sb_data_*`) does not fit `main` (expects version 14 and reads the index from `sb_data_*`): it would see an empty index it thinks is complete. Clear site data (or run `Space: Reindex`) when switching between `main` and the branches.
- Benchmark server on port 3002 (this session's scratchpad copy of the space) and a git worktree in the scratchpad (`wt-A`) may still exist; the scratchpad is session-specific. If the worktree directory is gone, run `git worktree prune`. Variant bundles were kept in the scratchpad only; rebuild them in a worktree.
- Playwright Chromium stays installed in `%LOCALAPPDATA%\ms-playwright`.

## History of the batch work (done)

`lookupPaths` batching (bfd2ea55): a 10 ms collect window cut calls to ~1 per batch but was 5–7 s slower (pages wait while batches run sequentially), so it collects within one task only; no measurable time change, −23 % lookup calls; kept. Batch writes (eb4d7b5e): reviewed (per-entry errors), within noise, kept.
