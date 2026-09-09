# S7b -- pre-1.0 hardening pass (fuzz + negative gate + doc-drift)  [DRAFT FOR REVIEW]

status: DRAFT. A SHORT hardening session -- three cheap, high-value tests plus two
one-line additions. No runtime change expected (Reader.js byte-identical except, if
shipped on its own, a VERSION bump). Runs before S8 (v1.0.0 gate). Same plan-only
discipline; nothing implemented until you say "run it".
version_target: 0.6.1 (a hardening patch) OR fold into S7's docs release -- your call.
depends_on: S6 (done). Blocks: S8 (harden before cutting 1.0.0).
origin: review of a residual-gaps list. Of 10 suggestions, most were already covered
  (count*stride overflow already fails closed via C2; coop-lbk1 already cell-for-cell
  with the D3 control; read/value fuzzing already in t5 Oracle A) or against the
  zero-overhead ethos (browser runner, an assertInRange debug hook). These THREE are
  the genuine, cheap wins.

===============================================================================
## Tasks
===============================================================================

### T1 -- schema-space fuzzer (the real gap)
  t5 Oracle A ALREADY does 100k random (row,field) reads vs a plain DataView with a
  replay seed; t0 fuzzes VALUES across both endiannesses. What is NOT fuzzed is the
  SCHEMA SPACE: random LEGAL schemas -- random field count, random lane subset from
  the 8 type codes, random field ORDER, packed or padded offsets, derived vs explicit
  stride/count, LE and BE. Extend the EXISTING seeded harness (makePrng/SEED in
  test/torture/harness.mjs) with a schema generator; for N thousand draws, build a
  reader and a reference DataView oracle from the SAME random schema and assert every
  cell agrees. Reuse the existing replay-seed + "prints seed on divergence" contract.
  Lives in torture (sibling-free), likely a new t8 tier or an extension of t5.
  ASSERTION: over >= N random schemas x rows, getX(row,id) === the DataView oracle at
  the schema's computed (base + row*stride + offset); a single mismatch prints the
  seed and fails. Non-vacuous: assert the draws actually spanned all 8 lanes and both
  endiannesses.

### T2 -- bytes() negative alloc gate (guard the boundary)
  bytes() is CORRECTLY excluded from the zero-alloc hot gate (it returns a Uint8Array
  view wrapper). There is currently NO test pinning that it is cold-path -- so a future
  "optimization" could move it hot under a false zero-GC banner. Add a NEGATIVE gate:
  call bytes() in a loop and assert it DOES allocate (retained/arrayBuffers grows, via
  the same lite-gc-profiler machinery t6 uses, inverted). Pairs with the existing t6
  positive gates. Lives in torture t6 (or a t6 sub-case).
  ASSERTION: a bytes()-in-a-loop measurement is NON-zero alloc (the inverse of the
  getX/readRow/lane gates); if someone makes bytes() zero-alloc-by-view-reuse, this
  gate flips and forces an explicit decision.

### T3 -- README R_ codes subset check (doc-drift, beyond dts-drift)
  dts-drift pins the R_* union in Reader.d.ts vs Reader.js. It does NOT check the
  README's error table. Add a small test: extract every R_* token the README mentions
  and assert it is a SUBSET of the codes Reader.js actually throws (the exported union).
  Catches a README that names a code the reader no longer throws, or renames one.
  ASSERTION: (R_* mentioned in README) subset-of (R_* in the shipped union); a stray or
  stale code in the docs fails the gate. Positive control: a synthetic README naming a
  fake R_NONSENSE code makes the check fail.

### T4 -- two one-line additions (cheap, do alongside)
  - coop-lbk1.test.js: add a VERSION-PIN comment noting the bake-stream floor the proof
    was verified against (mirrors coop-bake's discipline), so a future bump is a
    conscious re-verify, not a silent drift.
  - README + llms.txt: one sentence -- "Works over a SharedArrayBuffer like any
    DataView, but provides NO atomics: it is not a concurrency primitive; cross-worker
    races are the caller's to synchronize." Documents the memory-model boundary without
    adding an Atomics path to build or maintain.

===============================================================================
## NON-GOALS (explicitly declined from the review, keep the ethos)
===============================================================================
- NO assertInRange / debug-build hook on the hot path -- the unchecked getX IS the
  product; "must not corrupt engine state" is already automatic in JS (DataView OOB
  throws, TypedArray OOB -> undefined; you cannot corrupt the engine from here).
- NO Playwright/Chromium browser runner -- DataView/ArrayBuffer semantics are
  spec-identical cross-engine; heavyweight CI for near-zero catch rate.
- NO structuredClone/cross-realm test -- documenting a non-use-case.
- NO Atomics/SAB concurrency PATH (only the one-line doc note in T4).
- NO ns/op perf-regression CI as a HARD gate -- wall-clock is flaky; the zero-alloc
  gate already protects the reason-to-exist. (Advisory via lite-perf-gate only if ever.)
- NO new READ surface, R_* code, or type code -- frozen invariants HOLD (R_* union 10,
  type table 8, dts-drift floor 32). This is a test/doc pass, not a feature.

===============================================================================
## DONE WHEN
===============================================================================
1. The schema-space fuzzer (T1) runs N random legal schemas vs a DataView oracle,
   seed-replayable, non-vacuous across all 8 lanes and both endiannesses.
2. The bytes() negative gate (T2) asserts bytes() allocates (inverse of t6).
3. The README-code subset gate (T3) passes, with a teeth control.
4. The coop-lbk1 pin comment and the SAB doc sentence (T4) land.
5. npm run verify green; frozen invariants unchanged; if shipped standalone, VERSION
   synced across the three sites and a CHANGELOG 0.6.1 head (facts only).

===============================================================================
## Separate strategic question (NOT this session -- now SCHEDULED post-1.0)
===============================================================================
The competitive feature gaps vs top-tier binary readers are now roadmapped as
POST-1.0.0 additive minors (ROADMAP.md): S9 v1.1.0 = 64-bit integer lanes (i64/u64 via
BigInt -- the biggest genuine gap, deliberately reopens the "table stays 8" invariant
as an explicit additive change); S10 v1.2.0 = per-field endianness; S11 v1.3.0 =
type-level .d.ts record inference (pure DX, zero runtime). Bitfields / float16 are
"on demand". Intentional BOUNDARIES (NOT gaps): no write path (bakers write), no
nested/array-of-struct DSL or codegen (lite-bake owns layout). Held until after 1.0.0
so the current frozen contract ships as the stable baseline first.
