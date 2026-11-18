# Census v2 rerun, 17.11.2026: raw snapshots and provenance

Each file in `raw/` is the complete page-side record of one run: input log, `fnCensusArm` / `fnCensusMark` / `fnCensus({top:40})` results and `threadWork` before and after. The `fnCensus` report carries the window (ms, retired instructions), the counted-channel coverage (counted vs retired, pages armed vs wanted), the caps and the build fingerprint.

| Title | Raw file | Host build (BottleShip) | Host bundle sha256 (entry JS) | v86 runtime sha256 | Game bundle sha256 (size) | Per-title config |
|---|---|---|---|---|---|---|
| Gravity Bone | raw/zensus-gravitybone-20261117193226.json | `32543d21` (tree identical to develop `15c72387`, i.e. #414 as merged) | c1537267… | 6bd4b820d4ab5eb7… | 6bfc676a… (25,338,288) | none |
| Robot Vacuum | raw/zensus-robotvacuum-20261117193927.json | `32543d21` | c1537267… | 6bd4b820d4ab5eb7… | 2b1900e7… (47,241,062) | `jit_threshold 50000` |
| Deadlock | raw/zensus-deadlock-20261117200620.json | **overlay** `4e68b36b` = fork `integration/develop-b44` (`28602d29`) + `src/worker/harness/cmds/fn-census.ts` and `public/v86.wasm` checked out from `15c72387` | ffdb2dbe… | 6bd4b820d4ab5eb7… | a0046fe1… (55,533,035) | `jit_threshold 50000` |
| Flying Pigs | raw/zensus-flyingpigs-20261117201011.json | overlay `4e68b36b` | ffdb2dbe… | 6bd4b820d4ab5eb7… | a4c18d8d… (12,032,406) | `jit_threshold 50000` |

Full hashes:
- host entry JS `32543d21`: c1537267f09cd95c0a91de551e2261c8804667a2b92bfec858a240f734bf2569
- host entry JS `4e68b36b`: ffdb2dbe92e822d27fffc9be5ef2ce452dd719a0c241660519f4f923ff165e9b
- v86.wasm (all runs, = blob `b66fca6e`, native `4b6cc454`): 6bd4b820d4ab5eb7352d5a824b06b3cab58183c2bec8b6b3447a70e540bb21a3
- game bundles: 6bfc676af09508e0e9f2a058ab74cb509f1c94a99553de8a65c84bbf171b4001, 2b1900e78d411322f87f6d62c5d2b8859da269b78b2f34f765ef95272e3b571f, a0046fe15a6d3f9230a75c9a414ab34177a6ec352c4546c40931e45f9a3dc564, a4c18d8d7c7557ed8aec9afbb6aa25186ed55221ae6e93ec7e4c1dca0e52ef15

**The overlay host** (Deadlock, Flying Pigs) is the integration branch with our 35 local commits (listed in the fork's `integration/develop-b44` history). These two titles do not reach a frame on the plain develop host in this player. Only `fn-census.ts` and the runtime are identical to the merged pair. The rest of the host differs, so these two rows are not exact-pair evidence.

**Scene and window.**
- Same browser and machine (Chrome 157, Windows).
- AOT packages off (`__aotNoAutoLoad`).
- Scripted inputs per title are in each file's `log`.
- 45 s warm-up after `fnCensusArm`, then a 45 s window between `fnCensusMark` and `fnCensus`.

**Denominators and channel capacity.**
- `window.retiredIns` is the denominator.
- `executed.countedIns` / `retiredIns` is the counted coverage: Gravity Bone 95.2 %, Deadlock 24.0 %, Robot Vacuum 46.9 %, Flying Pigs 49.5 %.
- Pages armed vs wanted (64 cap) are in each file's `mark.counted`. Shares above the counted coverage are lower bounds.
