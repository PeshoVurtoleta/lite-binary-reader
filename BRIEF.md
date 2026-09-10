# S10 -- v1.2.0 -- per-field endianness (mixed-endian wire structs)  [PLAN FOR REVIEW]

status: PLAN, plan-only. Nothing implemented until you say "run it". This is a
MODULE change (Reader.js hot read path + laneOf + door), so it runs the FULL
pipeline (planner -> coder -> reviewer -> qa) and every read surface is re-proven by
`node --expose-gc test/torture.mjs`. Additive minor: version 1.1.0 -> 1.2.0 at
`/release`. No R_* code added, no type-table move (unlike S9) -- the drift gate's
three inventories (R_* union 10, type table 10, VERSION===package.json) are unchanged
except the lock-step VERSION bump.

why_now: it is the next feature by version (ROADMAP S10) AND the next step of the
reader's core differentiator -- law #4, "endianness is explicit and owned." Today
`littleEndian` is ONE per-reader flag; real wire structs are mixed (a big-endian
length/type prefix in front of a little-endian payload, protocol headers, some GPU
readback). No sibling baker emits mixed-endian, so this is a READER-only capability
-- exactly the "bytes nobody else can address" wedge, taken one step further.

===============================================================================
## What exists today (grounded in Reader.js, not assumed)
===============================================================================
  - The reader carries ONE endianness: `this._le` (a boolean), set once at the door
    from `options.littleEndian` (default host order). EVERY read uses it:
      * getF64..getU8 / getI64 / getU64  -> `this._dv.getX(pos, this._le)`
      * the cursor reads f64..u8 / i64 / u64 -> same, over `_cursor`
      * `get` / `val` / `readRow` switch arms -> `dv.getX(pos, le)` with `le = this._le`
      * `bytes()` is endianness-agnostic (raw span) -- unaffected.
  - laneOf eligibility has a SINGLE global gate: `if (this._le === IS_LITTLE_ENDIAN)`
    wraps the whole per-field lane-build loop (Reader.js ~line 302). A non-host reader
    declines EVERY lane today; per-field must make that decision per field.
  - The door validates option shape and every field {name,type,offset,lengthField?};
    there is no per-field endianness field yet.

===============================================================================
## The design (the one real decision is the hot-path shape)
===============================================================================
  Add an OPTIONAL `Field.littleEndian?: boolean`. Absent -> inherit the reader flag.
  Build a per-field endianness table ONCE at the door:
      `_leOf[i] = field.littleEndian === undefined ? this._le : field.littleEndian`
  (explicit `undefined` check, NOT `?? / ||` -- the S2/BR-03 lesson: a legitimate
  `false` must not be swallowed). Store it as a `Uint8Array` of 0/1, alongside `_off`
  and `_type` (monomorphic, cache-friendly, zero-alloc to read).

  THE HOT-PATH CHANGE (and why it is honest, not a regression):
    every getter changes `this._le` -> `this._leOf[fieldId]` (cursor: `this._leOf[id]`;
    readRow/get/val: `this._leOf[i]`). This is ONE extra typed-array index per read.
    The roadmap's "default-absent path byte-identical to 1.1.0" CANNOT mean a literal
    source diff here -- a per-field getter that still hard-codes `this._le` cannot read
    a per-field flag. So the honest contract is:
      - IDENTICAL RESULTS on any 1.1.0 schema (no field overrides -> `_leOf[i] === _le`
        for all i -> same bytes), AND
      - WITHIN-NOISE performance vs the 1.1.0 getter, PROVEN on the existing S13
        `bench/bench.mjs` (an L1 array index the branch predictor eats; expected noise).

  DECISION D1 (surface it, do not silently pick): single `_leOf` array getter (one
    extra index, measured within-noise) vs. DUAL getter classes chosen at the door
    (byte-identical default, but DOUBLES the hot-getter surface).
    RECOMMEND: single `_leOf` array. S13 already rejected doubling the getter surface
    for the ~4% split-endianness micro-gain; the same logic applies -- a predicted L1
    index is not worth a second getter set to maintain. Prove within-noise on bench;
    if bench somehow shows a real regression, revisit D1 then, with data.

  laneOf: move the global `this._le === IS_LITTLE_ENDIAN` gate INSIDE the per-field
  loop as `if (leOf[i] === IS_LITTLE_ENDIAN)`. A field whose own endianness != host
  declines to null (served by getX), exactly as a whole non-host reader does today; a
  host-endian field in a mixed reader stays lane-eligible. This is a strict
  generalization -- an all-default reader behaves identically.

===============================================================================
## Tasks (planner -> coder -> reviewer -> qa)
===============================================================================
  T1  Door: accept `Field.littleEndian?`; validate boolean-or-absent -> else
      R_BAD_SCHEMA (reuse; NO new code). Build `_leOf` (Uint8Array 0/1) with the
      explicit-undefined default. O(fields), cold, once.
  T2  Reads: swap `this._le` -> `this._leOf[<id>]` in getF64..getU8, getI64/getU64,
      the cursor reads, and the get/val/readRow switch arms. `bytes()` unchanged.
  T3  laneOf: per-field host-endian gate (move the guard inside the loop).
  T4  Reader.d.ts: `Field.littleEndian?: boolean` on the schema field type; JSDoc the
      default-inherits + laneOf-declines-non-host contract. No R_* union / type-table
      change -> dts-drift untouched but MUST still pass.
  T5  Torture (every claim falsifiable):
        - t0/t5 fidelity: a MIXED record -- one LE field + one BE field in the same
          row -- both bit-exact vs a DataView oracle, LE-host and BE-host paths.
        - t6: the per-field getters stay 0 B/op (typed-array index allocates nothing);
          the 8 primitive lanes' existing 0-B/op gates stay green; the 64-bit
          positive-alloc gate (S9 Gate 5) unaffected.
        - laneOf: BE field in an LE reader -> null; the LE sibling field -> a served
          lane; an all-default reader's lanes identical to 1.1.0.
        - t2 door matrix: `littleEndian` of "yes" / 1 / 0 / null / NaN -> R_BAD_SCHEMA
          (boolean-or-absent only); absent -> inherits.
        - t9 control: a getter that reads `this._le` instead of `this._leOf[id]` (the
          per-field-drop bug) -> a BE field reads byte-swapped garbage -> the mixed
          differential MUST catch it (analogue of the existing dropped-`_le` control).
  T6  Bench: run `npm run bench`; confirm the default path is within-noise of 1.1.0
      (this is the "byte-identical default" done-when, discharged with data).
  T7  decisions/0011-per-field-endianness.md: record D1 (single `_leOf`), the laneOf
      per-field gate, the explicit-undefined default, the results-identical +
      within-noise contract. CHANGELOG 1.2.0 Added; llms.txt + README (the schema
      field, one mixed-endian example, laneOf-declines-non-host note).

===============================================================================
## Assertions (the DONE-WHEN, each falsifiable)
===============================================================================
  - A single reader reads an LE field and a BE field in the SAME row, both bit-exact
    vs a DataView oracle (failing-before is impossible -- the field does not exist yet;
    so the proof is oracle equality on the mixed fixture, LE+BE host).
  - laneOf declines the non-host field (null) and serves the host field; an all-default
    schema's lanes and reads are identical to 1.1.0 (regression pin).
  - `littleEndian` non-boolean -> R_BAD_SCHEMA; absent -> inherits the reader flag.
  - t6: 0 B/op on every primitive read surface; 64-bit positive-alloc gate intact.
  - t9 per-field-drop control fails the run; LBR_TORTURE_BREAK=1 still fails.
  - bench: default path within-noise of 1.1.0. verify green; torture "ok"; controls ok.
  - drift gate green (R_* union 10, type table 10, VERSION===package.json at 1.2.0).

===============================================================================
## Non-goals / boundaries
===============================================================================
  - No write path, no schema mutation, no per-read bounds checks (unchanged laws).
  - No NEW R_* code and NO type-table move -- this is a schema-field addition only.
  - No doubled getter surface unless bench forces it (D1); default to the single array.
  - Not a demo session -- demos already cover the shipped surface; a mixed-endian demo
    line is optional and folds into T7 docs, not a new demo/ file.

===============================================================================
## Decisions for you (recommendation inline)
===============================================================================
  D1 -- hot-path shape: single `_leOf` array getter (RECOMMEND) vs dual getter classes.
        RECOMMEND single array -- consistent with S13's rejection of doubling; proven
        within-noise on bench. Say "dual" only if you want a literal byte-identical
        default at the cost of a second getter set.
  D2 -- scope: S10 alone (per-field endianness, v1.2.0)? Or would you rather take a
        lower-risk DX session next -- S11 (v1.3.0, type-level record inference, PURE
        .d.ts, zero runtime, no torture) or S12 (v1.4.0, zero-alloc for-of iterator,
        module change, torture-gated)? RECOMMEND S10 -- it is the next real CAPABILITY
        and the strongest fit for the reader's endianness-owning wedge; S11/S12 are DX
        polish that can follow in any order.

===============================================================================
===============================================================================
# Shipped log (most recent first) -- context, not active work
===============================================================================

## Demo refresh (post-1.1.0) -- commit bf35c27  [DONE]
  demo/ only, no module change. T1 compound.mjs zero-alloc join (seek + readRow into
  one reused sink) split from a cold print; T2 standalone.mjs got a 64-bit event record
  (getU64/getI64 + a variable-length bytes(row,id) span) with the BigInt-allocation note;
  T3 NEW demo/webgl-handoff.mjs (laneOf -> exact gl.vertexAttribPointer args, honest
  decline for f64/i64/u64 + BE); V1+V2 NEW demo/visuals.html (byte grids generated from
  the LIVE reader offsetOf/typeOf/stride, a real WebGL upload of reader.buffer, an
  endianness-reinterpret toggle showing 3.5 vs 3.45e-41 on the same 4 bytes, and the
  padding reframe). package.json +demo:webgl; README Demos 3 -> 5. V3 (ecosystem flow
  scene) DEFERRED -- lowest value, most generic; a later branding pass. Suite green
  throughout (101/101, torture ok, controls ok).

## S9 -- v1.1.0 -- 64-bit integer lanes  -- commit f7027f9  [DONE, published]
  T_I64=8 / T_U64=9; getI64/getU64 + cursor i64/u64 + get/val/readRow return
  number|bigint; laneOf yields BigInt64Array/BigUint64Array views. Type table moved
  8 -> 10 in lock-step with the drift gate (the ONE sanctioned 1.0.0-invariant move);
  R_* union unchanged at 10. The 64-bit lanes ALLOCATE (BigInt is a heap value) -- the
  second documented exception alongside bytes(); t6 Gate 5 PROVES it (retain + heapUsed,
  ~32 B/read). All 8 primitive read bodies byte-identical (diff-proven; 0-B/op gates
  intact). D1-D4 accepted as recommended (D2/D4 = no). decisions/0010 records it.
  verify 101/0. Catalog card synced to 1.1.0.
