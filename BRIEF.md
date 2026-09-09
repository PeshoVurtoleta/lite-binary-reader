# S4b -- v0.4.0 -- native typed-lane fast path (laneOf)  [DRAFT FOR YOUR REVIEW]

status: APPROVED -- SCOPE LOCKED: ship T3 (native typed-lane fast path, laneOf) as v0.4.0. The
  SWAP option (running S5 first) was considered and DECLINED -- S4b runs next as recommended, S5
  (cooperation) reflows to v0.5.0 and S6 (lite-query) to v0.6.0. Pipeline authorized:
  planner -> coder -> reviewer -> qa; reviewer REJECTED returns to coder, not forward.
version_target: 0.4.0   (reflows the roadmap: S5 cooperation -> v0.5.0, S6 lite-query -> v0.6.0)
depends_on: S2 (DONE, fail-closed door) is the only HARD dependency. S4 (DONE, v0.3.0) is not a
  dependency -- laneOf sits BESIDE the cursor/readRow/bytes surfaces, it does not build on them.
blocks: nothing hard. S5 (baker cooperation) is independent of this and of S4.
roadmap anchor: ROADMAP.md section 6 folded T3 into "S4 -- v0.3.0 -- API sugar". S4 shipped the
  three safe wrappers and deferred T3; this brief is T3 standalone. The T3 spec text this expands
  lives in the prior S4 BRIEF (archived in git) and in decisions/0004-api-sugar.md's defer note.

===============================================================================
## THE ONE DECISION FOR YOUR REVIEW (resolve before the pipeline runs)
===============================================================================
Two sessions are both unblocked right now. Pick which runs next.

  RECOMMEND -- S4b (this brief): finish the fast-path story the S4 split opened. It is the
  package's highest-correctness-risk surface (a SECOND read path that must be byte-identical to
  DataView on every eligible cell and DECLINE on every ineligible one). Doing it now, while the
  read-fidelity oracle + T5 differential machinery from S1 is fresh, is the efficient moment. A
  bug here reads WRONG BYTES silently (an S1-class defect), so it wants undivided review -- which
  is precisely why S4 refused to bundle it with the three safe wrappers.

  SWAP -- S5 (cooperation proof, its own brief in ROADMAP.md:584): the roadmap's "if you only do a
  subset" ranks S5 as THE cross-package rep -- fromBaked / fromLBK1Shard reading the REAL sibling
  output cell-for-cell, not emulated bytes, is the whole cooperation claim. Lower correctness risk
  than T3, higher strategic signal, and equally unblocked (depends only on S2). If you would rather
  bank the cooperation proof before adding a second read path, say so and I write the S5 brief
  instead; S4b then becomes v0.5.0.

Either way T3/laneOf is self-contained and nothing else depends on it. My default is S4b because it
is the piece we explicitly deferred and the correctness cost is cheapest to pay now.

===============================================================================
## State check (what is already true, so S4b does NOT redo it)
===============================================================================
- The door is fail-closed (S1/S2): every incoherent shape throws a coded R_* at construction. The
  read hot path is unchecked BY DESIGN. laneOf's ELIGIBILITY test is a cold, construction-time
  computation; the lane hot loop it hands back is unchecked, same trust model as getX.
- The 9 numeric bodies (getF64..getU8) + get + bytes + the S4 cursor/readRow surfaces are the
  pinned core. S4b is ADDITIVE: it must not touch ANY of them. The reviewer diffs them vs v0.3.0.
- Reader.d.ts ships and is gated by test/dts-drift.test.js (export parity + classMembers >= 31).
  CONSEQUENCE: laneOf and the Lane descriptor interface MUST be added to Reader.d.ts in THIS
  session or the drift gate fails. The member floor rises (>= 31 -> >= 32).
- The R_* union is exactly 10 and the type table exactly 8, both asserted by the drift gate. S4b
  adds NO new R_* code and NO new type code. laneOf's failure mode is to RETURN null, not throw --
  ineligibility is a normal answer, not an error. If a task seems to need a new R_*, stop and
  re-scope; both unions staying frozen is a hard invariant.
- TYPE_BYTES = [4,8,4,2,1,4,2,1], TYPE_COUNT = 8, IS_LITTLE_ENDIAN detected once at load. laneOf
  reuses all three; it introduces no new constant table.

===============================================================================
## Tasks
===============================================================================

### T3.1 -- Per-field lane eligibility (Reader.js, COLD, computed once at construction)
A field is lane-eligible iff ALL hold, evaluated once in the constructor's cold pass:
  - `this._le === IS_LITTLE_ENDIAN`  (typed arrays read HOST order only; a wrong-endian reader has
    NO eligible field -- see T3.4).
  - `(this._base + fieldOffset) % width === 0`  (the field's first byte is naturally aligned).
  - `this._stride % width === 0`  (so EVERY row's cell stays aligned, not just row 0).
  width = TYPE_BYTES[type]. A U8/I8 field (width 1) is trivially eligible on a matching-endian
  reader. Store the verdict per field; do NOT recompute per read. A field failing any clause is
  served by getX exactly as today -- eligibility is an OPTIMIZATION probe, never a gate on reads.
  DECISION for the planner (record in decisions/0005): store eligibility as a precomputed
  descriptor per eligible field (see T3.2) vs a lazy build on first laneOf(id). RECOMMEND precompute
  in the cold constructor pass -- it is a handful of small objects at construction, keeps laneOf a
  pure lookup (zero work, zero alloc on the call), and matches the "all allocation at the door" law.

### T3.2 -- The typed views + per-field lane descriptors (Reader.js, COLD)
  - Build AT MOST ONE typed view per PRESENT eligible type over `this._buffer`, at construction:
    e.g. one `new Float32Array(this._buffer)` shared by every eligible F32 field. Eight possible
    views; only those an eligible field actually needs are built. These are the only new
    allocations and they are COLD (construction), a handful of small view wrappers.
  - Per eligible field precompute `elemStride = this._stride / width` and
    `elemOffset = (this._base + fieldOffset) / width` (both are integers BECAUSE the field passed
    T3.1). The lane read is then `view[row * elemStride + elemOffset]` -- one multiply, one add,
    one indexed load, zero branch, zero alloc.
  - The descriptor shape handed to callers: `{ view, elemStride, elemOffset }` (a `Lane`). Frozen
    or plain-object -- planner decides; if frozen, freeze once at construction, never per call.

### T3.3 -- laneOf(id): the probe + accessor (Reader.js, additive, COLD call)
  - `laneOf(fieldId) -> Lane | null`. For an eligible field returns its precomputed
    `{ view, elemStride, elemOffset }`; for an ineligible field returns `null`. Called ONCE outside
    the loop, exactly like field(): resolve the lane, then run the tightest possible loop yourself:
      `const L = r.laneOf(x);`
      `if (L) { const {view,elemStride,elemOffset}=L; for (row=0;row<n;row++) sum += view[row*elemStride+elemOffset]; }`
      `else   { for (row=0;row<n;row++) sum += r.getF32(row, x); }   // fall back to getX`
  - laneOf itself allocates NOTHING on the call (the descriptor was built cold at construction; the
    call is a lookup returning a reference). Gate it at 0 B/op alongside the lane read loop (T6).
  - DO NOT bake a per-read eligibility branch into getX or the cursor reads. The fast path is
    OPT-IN via laneOf; a branch per read would defeat the entire purpose and taint the pinned core.
  - `fieldId` out of range: reuse the existing id-validation path if getX has one; otherwise laneOf
    is unchecked on a garbage id exactly like getX. Planner confirms and records the choice. NO new
    R_* code either way.

### T3.4 -- Endianness + the decline contract (correctness-critical, no code, just the invariant)
  - Typed arrays read HOST byte order. A reader constructed to read the OPPOSITE order
    (`this._le !== IS_LITTLE_ENDIAN`, e.g. a big-endian wire frame on a little-endian host) has NO
    eligible field: laneOf returns null for EVERY field, getX serves all reads correctly. This is
    the whole reason eligibility gates on `_le === IS_LITTLE_ENDIAN` in T3.1.
  - There is NO endianness swap inside the lane and NO "unaligned fast path" (an unaligned read is
    just getX). laneOf either hands back a raw host-order typed read or declines. These two
    NON-GOALS keep the fast path a pure speed win with zero fidelity surface area.

### T3.5 -- Reader.d.ts + VERSION sync (REQUIRED this session)
  - Add `laneOf(fieldId: number): Lane | null;` to the class and a `Lane` interface
    (`{ view: <the eight TypedArray types>; elemStride: number; elemOffset: number }`) to Reader.d.ts.
    The dts-drift export/classMember parity gate enforces presence; bump its member floor 31 -> 32.
  - Bump VERSION 0.3.0 -> 0.4.0 in Reader.js AND package.json AND llms.txt (the THREE version sites
    the release skill checks). Drift gate asserts Reader.js VERSION === package.json version.
  - CHANGELOG prose is NOT this session (that is /release 0.4.0). Leave a decisions/0005 breadcrumb
    listing what shipped so the release step records it under Added. README + llms.txt NARRATIVE for
    laneOf also lands at /release time (the S4 lesson: the release skill checks doc PRESENCE, not
    FRESHNESS -- so a focused docs pass, or writing the laneOf section during this session, is
    required before /release 0.4.0 reports BLOCKERS: none. Flagged here so it is not forgotten).

===============================================================================
## Torture / gate impact
===============================================================================
- T5 (differential) -- THE centrepiece proof. For EVERY eligible field and EVERY row, assert
  `laneOf(id).view[row*elemStride+elemOffset] === getX(row, id)` across the full alignment x
  endianness x type matrix (all 8 types, aligned + deliberately-unaligned layouts, matching- and
  opposite-endian readers). Assert laneOf returns null for a deliberately unaligned field AND for
  an opposite-endian reader (the decline contract). This is the read-fidelity invariant extended to
  the second read path; it is non-negotiable for this session.
- T6 (zero-alloc): the laneOf call is 0 B/op (it is a lookup), AND the lane read loop is 0 B/op +
  0 retained over >= N rows. Its own gate, per the roadmap rule "each new surface gets its own T6".
- T9 (controls, teeth): mutate a stored elemStride or elemOffset by 1 and assert the T5
  differential now FAILS (a differential that cannot fail is decorative); assert the unaligned /
  opposite-endian decline control is non-vacuous (there really IS an eligible field in the positive
  case). The reproduced-todo registry stays EMPTY (nothing deferred out of this session).
- The pinned core (getF64..getU8 / get / bytes / seek+cursor reads / readRow) stays byte-identical
  to v0.3.0 -- reviewer diffs every one of them. laneOf touches none of their bodies.

===============================================================================
## DONE WHEN
===============================================================================
1. laneOf lands ADDITIVE, with the full v0.3.0 pinned core byte-identical (reviewer diff).
2. laneOf + the Lane interface are in Reader.d.ts and test/dts-drift.test.js is green (export +
   member parity, floor raised to >= 32).
3. R_* union still EXACTLY 10, type table still EXACTLY 8 (drift gate asserts both). No new codes.
4. T5 differential: laneOf reads are byte-identical to getX on EVERY eligible cell across the
   alignment x endianness x type matrix; laneOf returns null on unaligned AND opposite-endian.
5. T9: a mutated elemStride/elemOffset FAILS the differential; the decline control is non-vacuous.
6. T6: laneOf is 0 B/op and the lane read loop is 0 B/op + 0 retained; LBR_TORTURE_BREAK=1 exits 1.
7. VERSION 0.4.0 in Reader.js + package.json + llms.txt; drift guard enforces Reader.js === pkg.
8. `npm run verify` green (test + torture + controls). decisions/0005 records: the precompute-vs-lazy
   eligibility choice, the Lane descriptor shape (frozen or plain), the out-of-range-id policy for
   laneOf, and why laneOf declines (returns null) rather than throwing.

===============================================================================
## NON-GOALS (later sessions -- guard against scope creep)
===============================================================================
- No unaligned "fast" path and no in-lane endianness swap -- laneOf either hands back a host-order
  typed read or declines. Those two are the fidelity guardrails, not features to add.
- No per-read eligibility branch in getX or the cursor reads -- the fast path is opt-in via laneOf.
- No cooperation tests against REAL lite-bake / lite-bake-stream buffers -- that is S5 (now v0.5.0),
  independent of this and runnable before or after it.
- No lite-query streaming adapter -- that is S6 (now v0.6.0), depends on S5.
- No write path, no schema mutation, no new R_* code, no new type code -- all frozen invariants.
- No README/llms.txt/CHANGELOG NARRATIVE beyond the VERSION bump + decisions/0005 breadcrumb in
  THIS session; the prose lands at /release 0.4.0 time (with the S4 doc-freshness lesson applied).

===============================================================================
## Housekeeping flagged for you (not part of the session)
===============================================================================
- scratchpad/ is still UNTRACKED and NOT in .gitignore (.gitignore currently lists only
  /node_modules/ and /package-lock.json). It holds session probe files. A blanket `git add -A`
  before a commit would sweep it in. Say the word and I add `/scratchpad/` to .gitignore, or leave
  it for you to handle at commit time.
- decisions/0004-api-sugar.md is the S4 record and is still UNTRACKED (it lands with the 0.3.0
  commit you review). S4b would add decisions/0005-typed-lane.md.
