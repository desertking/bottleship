# #362 step 1 (#374) and step 2 (#392): raw measurement records

## Builds

The full source of every measured build is on the fork branches below. Each one is
develop `fe884b1d` plus 27 downstream commits that we ship, plus the PR commits, plus
the measurement-only commit (`measurement-instrumentation.diff`).

| build | branch | commit | tree |
|---|---|---|---|
| step 1 (cache + counters + off switch) | `measure/362-step1-build-20261115` | `3174460a7afe99a18e52c9c92316dad741a4e56c` | `4e291254e7b139f8efe8a838f76bf8f2b21c0cc7` |
| step 2 (step 1 + vertex range + off switch) | `measure/362-step2-build-20261115` | `a3fdf310f78ec57c41cbf9393da4eb93cac68c20` | `a6571548686e80e6a217f53694da497cbdb5f8e7` |
| pre-feature baseline (no #374 commits) | `measure/362-prefeature-build-20261116` | `77bac4b7` | |

`hashes-build.txt` lists the SHA-256 of `v86.wasm`, the emulator worker and the entry bundle of each build.

**Package.** One Game Maker 8 title, served as a WGB of 6,510,480 bytes, SHA-256
`a11c6cb75c9ec71a7cfebc79851f189f7516a6e2ff00ffa116d7d29842af410b`.

**Browser.** Chrome 157 on Windows, real GPU, one machine. The local ledger runs used
headless Chrome 157 on another Windows machine.

**Effective arm.** In every run, every switch is set explicitly before the worker starts:
`__ddrawMegaBatchCacheOff`, `__ddrawMegaBatchVertexRangeOff`, and `__aotNoAutoLoad = true`.
The worker reports the latched state of the live manager or executor (`r.flagCheck`).
Every run is a fresh page load, which means a new worker, device and manager.

## Workload

The Delphi `RandSeed` at `0x585008` is set to `0x1234567` right before the click on
"Normal" (harness `clickHold(215,217,600)`). The click is retried until the play field
is dark. The result is the same dungeon in every run.

## Windows (`*-raw-windows.json`)

- Counters are snapshotted inside the present notification, so each window starts and ends at exact present serials.
- Each run has three consecutive windows of 300 presents, after 30 skipped presents.
- Each window record holds the start/end serials, `rs` (render-stat deltas), `cache` (cache-counter deltas, step 1), the per-present frame times `dtMs`, and the per-present draw counts (min/max/distinct).

**Failed controls.** These windows did not do equal work and must be read as failed:

| file | run | arm | window | draw requests |
|---|---|---|---|---|
| 374-step1 | m374-20261115124033 | B | 2 | 421,200 |
| 374-step1 | m374-20261115124807 | B | 0 | 421,238 |
| 374-step1 | m374-20261115124807 | B | 1, 2 | 421,200 |
| 392-step2 | m374-20261115131141 | B | 0, 1, 2 | 421,200 |

## Draw ledger (`res-ledger2-*.json`, local, step 1 + baseline)

- Every draw request is keyed by indexed flag, primitive type, FVF, vertex count and texture, for every present of a 60 s window.
- A full present is 1395 textured triangle-list quads, 7 untextured quads and **3 untextured `D3DPT_LINESTRIP` draws of 5 vertices**. The line strips are rectangle outlines and are not MegaBatch draws.
- The 1404-draw windows above are one of these outlines missing for the whole window.
- In 14 local runs (A/B/C), every full present had all 1405 draws, so the missing outline did not reproduce locally.
- Arms: A = cache on, B = cache off, C = pre-feature build.
- **Key multiset.** A and C are identical. B is identical once texture identity is ignored. B's texture surface addresses are consistently shifted (the same in both B runs), and the cause is not identified.
- **Cache counters** (cumulative from boot):
  - menu: 24 misses, 26,874 hits;
  - after entering the dungeon: 108 misses;
  - after 60 s more in the dungeon: still 108 misses, 0 resets.
  - B: every build is uncached.
- **Local present rate** (one machine, noisy):
  - A: 13.18 and 13.79;
  - B: 12.18 and 12.46;
  - C: 12.08 and 12.18.
