# S3 -- v0.2.0 -- Reader.d.ts + BR-08 door + type-drift guard

status: PLANNED (awaiting review, then run planner -> coder -> reviewer -> qa)
version_target: 0.2.0
depends_on: S2 (DONE, reviewer-APPROVED, v0.1.2)
blocks: S4
roadmap anchor: ROADMAP.md section 6, "S3 -- v0.2.0 -- Reader.d.ts"; findings BR-08 (and the
  door-contract note under BR-05/BR-06, both already fixed in S2 -- see "State check" below).

===============================================================================
## State check (what S2 already did, so S3 does NOT redo it)
===============================================================================
The ROADMAP findings table still labels BR-05 and BR-06 as "S3", but S2 PROMOTED both to
enforced coded doors:
  - BR-05: bytes() -> R_BUFFER_TOO_SMALL (overflow) / R_BAD_LENGTH (bad len).  DONE.
  - BR-06: fromBaked(null) -> R_BAD_SOURCE; fieldless fromLBK1Shard -> R_BAD_SCHEMA.  DONE.
Verified by scratchpad/probe.mjs. So the ONLY code fix left in the S3 door family is BR-08.
(Housekeeping task H0 below re-labels those two rows in ROADMAP so the table stops lying.)

===============================================================================
## Findings this session closes
===============================================================================
BR-08 (S3, hygiene, fails SAFELY today): a DETACHED ArrayBuffer is still
`instanceof ArrayBuffer`, so it passes coercion at Reader.js:111-112 and reaches
`new DataView(buffer)` at Reader.js:183, which throws a raw TypeError
("Cannot perform DataView constructor on a detached ArrayBuffer") -- no `.code`.
Same uncoded-door class as BR-06. No read-past; the only defect is the useless error.
Repro: scratchpad/probe2.mjs -- `mc.postMessage(buf,[buf])` then `new LiteBinaryReader(buf,{schema})`.

===============================================================================
## Tasks
===============================================================================

### T1 -- BR-08: coded door for a detached buffer  (Reader.js, COLD PATH only)
Root cause: the `instanceof ArrayBuffer` and `ArrayBuffer.isView` branches accept a
buffer whose backing store has been transferred/detached; the throw surfaces later at
DataView construction with no code.

Fix (in the coercion block, Reader.js:110-123), BEFORE `new DataView`:
  - ArrayBuffer branch: after `source instanceof ArrayBuffer`, if the buffer is detached
    -> fail("R_BAD_SOURCE", "source ArrayBuffer is detached").
  - View branch: if `source.buffer` is detached -> same coded fail (a view over a
    detached buffer reports byteLength 0 but must not be mistaken for empty).
Detection must DISTINGUISH detached from a legitimately zero-length buffer:
  - Node 20+: `ArrayBuffer.prototype.detached` getter (`buffer.detached === true`).
  - Portable floor (engines: node>=18): a `try { new DataView(buffer) } catch` probe,
    or `structuredClone`-free detection. Prefer feature-detect `detached` once at module
    load (like IS_LITTLE_ENDIAN), fall back to a guarded DataView construction that
    re-throws as R_BAD_SOURCE. Decide in the planner; record the choice in decisions/.
CONSTRAINT: the fix lives entirely in the cold constructor path. The 9 numeric read
bodies (getF64..getU8) + get + bytes stay BYTE-IDENTICAL. No new per-read work.
Reuse the existing R_BAD_SOURCE code -- do NOT invent R_DETACHED (keeps the union at 10;
a detached source IS a bad source). Note in decisions/ why we fold it into R_BAD_SOURCE.

### T2 -- Reader.d.ts  (the TypeScript surface)
Emit a hand-written ambient `.d.ts` covering exactly the runtime exports (verified list):
  - `VERSION: string`.
  - Type-code consts as `const` literals: `T_F32: 0, T_F64: 1, T_I32: 2, T_I16: 3,
    T_I8: 4, T_U32: 5, T_U16: 6, T_U8: 7` (literal types, not `number`, so unions narrow).
  - `IS_LITTLE_ENDIAN: boolean`.
  - `type TypeCode = 0|1|2|3|4|5|6|7;`
  - `interface Field { name: string | number; type: TypeCode; offset: number; }`
    (name is used as a Map key -- allow string|number; the code accepts both).
  - `interface Schema/Options { schema: Field[]; stride?: number; count?: number;
    byteOffset?: number; littleEndian?: boolean; }` -- match the real opts keys in Reader.js.
  - `class LiteBinaryReader` with the ctor `(source: ArrayBuffer | ArrayBufferView, opts)`,
    getters (`count`, `fieldCount`, `stride`, `buffer`, ...), `field(name)`, `offsetOf(id)`,
    the 9 typed getters `getF64(row,id): number` ... `getU8`, `get(row,id): number`,
    `bytes(row, id_or_off, len): Uint8Array`, and the statics
    `fromBaked(baked): LiteBinaryReader` and `fromLBK1Shard(shard): LiteBinaryReader`.
    Pull the EXACT public method/getter names from Reader.js -- do not invent surface.
  - `interface Baked` / `interface Shard` shapes -- read them off the fromBaked /
    fromLBK1Shard bodies in Reader.js (fields/laneKind/offsetInRow/rowStride/bytes).
  - `type ReaderErrorCode =` a union of ALL 10 R_* tags currently thrown:
    R_BAD_COUNT | R_BAD_LENGTH | R_BAD_OFFSET | R_BAD_SCHEMA | R_BAD_SOURCE |
    R_BAD_STRIDE | R_BAD_TYPE | R_BUFFER_TOO_SMALL | R_DUPLICATE_FIELD | R_UNKNOWN_FIELD.
  - `class LiteBinaryReaderError extends Error { readonly code: ReaderErrorCode; }`.
ASCII-only. No stray tool-call tags (grep before trusting). `files[]` already lists it;
verify it resolves (npm pack includes it after this session).

### T3 -- type-drift guard  (test/, node:test)
Add a test (e.g. test/dts-drift.test.js) that FAILS if the .d.ts contract drifts from
the code. It is the whole point of shipping a d.ts in this suite (BLUEPRINT lists d.ts
drift + thrown-vs-declared code divergence as recurring finding classes; lite-bake ships
this exact gate). Assert THREE inventories, each derived by reading the files, not hardcoded:
  a) code-union parity: the set of `R_*` string literals in the `ReaderErrorCode` union in
     Reader.d.ts EQUALS the set of `R_*` tags actually passed to `fail(...)`/thrown in
     Reader.js. Extract both with a regex over the file text. Neither side may have an
     extra. (This is what would have caught a forgotten R_DUPLICATE_FIELD/R_BAD_LENGTH.)
  b) export parity: every `export const/function/class` name in Reader.js appears in the
     .d.ts, and vice-versa.
  c) VERSION parity: the `VERSION` string in Reader.js === the version in package.json.
     (Three-place sync; the .d.ts carries no version literal, so it is exempt -- but if a
     future .d.ts adds one, extend this assertion. Note that in decisions/.)
Model the extraction on lite-bake's inventory gate if present (../LiteBake).

### T4 -- VERSION sync to 0.2.0
Bump `Reader.js` VERSION "0.1.2" -> "0.2.0" and package.json "0.1.2" -> "0.2.0"
(minor: additive .d.ts + new coded door, no breaking change). The T3(c) assertion
enforces the two stay equal. CHANGELOG entry is S7, not here -- but leave a one-line
note in decisions/ so S7 records BR-08 under "Fixed" and the .d.ts under "Added".

### H0 -- ROADMAP housekeeping (docs, not code)
Re-label the BR-05 and BR-06 rows in the ROADMAP findings table from "S3" to
"S2 (FIXED)" so the table matches reality; add a one-line note that BR-08 is the sole
remaining door finding, closed here. Leave BR-01..BR-04, BR-07 as their recorded
"S2 FIXED" state.

===============================================================================
## Torture / gate impact
===============================================================================
- t2-adversarial (the door matrix): add a DETACHED source case to the source dimension
  and assert it throws R_BAD_SOURCE, and that checkCoherence flags it (door <-> coherence
  agreement must still hold across the now-5 source kinds). A detached buffer joins
  {ArrayBuffer, full-span view, zero-offset partial view, nonzero-offset view, DETACHED}.
- t9-controls: add a control proving the detached-door check has teeth AND is non-vacuous
  (a live buffer is accepted; a detached one is rejected with R_BAD_SOURCE) -- mirrors the
  existing Control 6 checkCoherence non-vacuity pair.
- Reproduced-todo registry stays EMPTY (BR-08 is fixed the same session, not carried).
- Hot-path gates (T6 zero-alloc + retained-alloc) unchanged -- no read body touched, so the
  reviewer must confirm getF64..getU8/get/bytes are byte-identical to v0.1.2 (diff the bodies).

===============================================================================
## DONE WHEN
===============================================================================
1. Detached ArrayBuffer (and view over a detached buffer) -> R_BAD_SOURCE, greppable code,
   fails safely; verified by probe2.mjs re-run + a boundary test in Reader.test.js.
2. Reader.d.ts exists, ASCII-clean, no tool-call tags, covers the full runtime surface, and
   resolves in `npm pack` (ships as a file).
3. test/dts-drift.test.js passes AND has teeth: temporarily removing one R_* from the union
   or one export makes it fail (prove non-vacuity, or add a t9-style control).
4. VERSION 0.2.0 in Reader.js AND package.json; drift guard enforces equality.
5. `npm run verify` green (test + torture + controls); LBR_TORTURE_BREAK=1 exits 1.
6. The 9 numeric read bodies + get + bytes are byte-identical to v0.1.2 (reviewer diff).
7. ROADMAP findings table re-labeled (H0); decisions/ records: BR-08 -> R_BAD_SOURCE
   rationale, detached-detection technique chosen, and the drift-guard's three inventories.

===============================================================================
## NON-GOALS (guard against scope creep -- these are later sessions)
===============================================================================
- No new read features / API sugar (seek, readRow, typed-lane fast path) -- that is S4.
- No cooperation tests against real lite-bake / lite-bake-stream buffers -- that is S5.
- No README / llms.txt / CHANGELOG prose -- that is S7 (only leave a decisions/ breadcrumb).
- No per-read bounds checks on the typed getters. No write path. No schema mutation.
