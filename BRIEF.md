# S4 -- v0.3.0 -- API sugar (each surface pinned zero-alloc)

status: APPROVED -- SCOPE LOCKED: ship T1 (cursor) + T2 (readRow) + T4 (variable-length) as
  v0.3.0. T3 (native typed-lane fast path) is DEFERRED to its own focused session (provisionally
  S4b / v0.4.0), per the recommendation below. T3 stays in this file for reference but is OUT OF
  SCOPE for this pipeline run -- do NOT implement it. S5 baker-cooperation reflows after S4b.
version_target: 0.3.0
depends_on: S2 (DONE, fail-closed door) + S3 (DONE, v0.2.0, Reader.d.ts + drift gate + BR-08/BR-09)
blocks: nothing hard; S5 (baker cooperation) is independent and can precede or follow S4
roadmap anchor: ROADMAP.md section 6, "S4 -- v0.3.0 -- API sugar"; section 5 shows S4 depends only on S2.

===============================================================================
## State check (what is already true, so S4 does NOT redo it)
===============================================================================
- The door is fail-closed (S1/S2): every incoherent shape throws a coded R_* at construction.
  The read hot path is unchecked BY DESIGN and every new read surface inherits that contract.
- The 9 numeric read bodies (getF64..getU8) + get + bytes are the pinned zero-GC core.
  S4 is ADDITIVE: it must not touch those bodies. The reviewer diffs them against v0.2.0.
- Reader.d.ts ships and is gated by test/dts-drift.test.js. CONSEQUENCE FOR S4: every new
  public method/getter MUST be added to Reader.d.ts in the SAME session, or the drift gate
  (export parity + classMembers >= N) fails. The gate now forces types to stay in sync -- lean on it.
- The R_* union is exactly 10 and the type-code table is exactly 8. Both are asserted by the
  drift gate. S4 adds NO new code and NO new type code (see T4 -- variable-length reuses
  R_UNKNOWN_FIELD / R_BUFFER_TOO_SMALL / R_BAD_LENGTH). If a task seems to need a new R_*, stop
  and re-scope: the union staying 10 is a hard invariant this session must preserve.

===============================================================================
## SCOPING DECISION FOR YOUR REVIEW (resolve before the pipeline runs)
===============================================================================
The roadmap bundles FOUR surfaces into S4/v0.3.0. Three of them (T1 cursor, T2 readRow,
T4 variable-length) are thin ergonomic wrappers that REUSE the existing DataView read path --
low correctness risk, provable by the existing T6/T2 gates plus small additions.

The fourth (T3, the native typed-lane fast path) is different in kind: it is a SECOND read
path (typed-array indexing instead of DataView) that must be byte-identical to the first on
every aligned+native-endian cell AND correctly DECLINE on every unaligned or wrong-endian
cell. That is a full differential-proof surface (alignment x endianness x type), the heaviest
correctness burden in the package since S1's read-fidelity invariant.

  RECOMMENDATION: ship T1 + T2 + T4 as v0.3.0 (three ergonomic surfaces, one clean release),
  and give T3 (typed-lane fast path) its own focused session -- provisionally "S4b / v0.4.0",
  with S5 baker-cooperation reflowing after it. Rationale: T3's differential + fallback matrix
  deserves undivided review, and a bug there reads WRONG BYTES silently (an S1-class defect),
  whereas T1/T2/T4 at worst throw. Bundling a silent-corruption-risk feature with three safe
  wrappers dilutes the review attention T3 needs.

  ALTERNATIVE: keep all four in v0.3.0 as the roadmap states. If you choose this, T3 still gets
  its own differential tier (T5 fast-vs-slow) and its own t9 control; the DONE-WHEN below covers it.

The tasks below are written so EITHER choice works: T3 is self-contained and can be lifted out.
Everything else is unaffected by the split. Mark your choice at the top of the planner run.

===============================================================================
## Tasks
===============================================================================

### T1 -- Row cursor: seek(row) + f64(id)/f32(id)/i32(id)/.../u8(id)  (Reader.js, additive)
Ergonomic sequential scans: seek a row once, then read fields without re-passing the row.
  - New mutable state: `this._cursor` (default 0), set only by `seek`. This makes the reader
    STATEFUL for the cursor API -- document it; the row-passing getX API stays stateless and
    is the recommended form for random access. The two APIs read the SAME bytes.
  - `seek(row)`: sets `_cursor = row`, returns `this` (chainable: `r.seek(i).f64(x)`).
    DECISION (flag for review): UNCHECKED to match the getX trust model (the scan loop
    `for (r=0;r<count;r++)` is trusted), OR a cold bounds check `0 <= row < count` throwing a
    coded R_* (row is set once per row, not per read, so a check here is affordable and catches
    the one error getX deliberately ignores). RECOMMEND unchecked for contract symmetry; note
    the choice in decisions/.
  - `f64(id)..u8(id)` (8 methods) + `val(id)` (the get-equivalent, type-dispatched): read at
    `_cursor`. IMPLEMENTATION: INLINE the same address arithmetic as getF64.. (do NOT delegate
    `f64(id){return this.getF64(this._cursor,id)}`) so each cursor read stays monomorphic and
    frame-flat -- matches the getX bodies exactly with `_cursor` substituted for `row`. This
    duplicates 8 one-line read expressions; that is the intended cost of a zero-overhead cursor.
ASSERTION: for every type and every row, `r.seek(row).f64(id) === r.getF64(row, id)` (add to
  T0/T5). ZERO-ALLOC: seek + each cursor read gated at 0 B/op (T6). The getX bodies stay byte-identical.

### T2 -- Out-param row fill: readRow(row, out)  (Reader.js, additive)
The SoA->AoS bridge: write every field of one row into a CALLER-OWNED sink, no record allocated.
  - PRIMARY form: `out` is an array indexed by field id -- `out[i] = <read field i at row>` for
    i in [0,fieldCount). Fastest, no key lookup. Cold door: require `out.length >= fieldCount`
    (an Array that is too short would auto-GROW = allocation; refuse it) -- reuse an existing
    coded R_* (R_BAD_LENGTH is the honest fit; confirm in planner) rather than inventing one.
  - OPTIONAL convenience form: `out` is a plain object; write `out[name] = value` for each field
    name. MUST NOT create keys that force hidden-class churn/alloc -- document that the caller
    passes a pre-shaped object. If this form complicates the zero-alloc proof, DEFER it to a
    later session and ship array-by-id only. RECOMMEND: array-by-id this session; object form deferred.
  - readRow itself allocates NOTHING (caller owns out); it uses the type-dispatched read per field.
ASSERTION: `readRow(row, out)` fills out[i] === get(row, i) for all i; a too-short array throws a
  coded R_*; the fill loop is 0 B/op over >= N rows into a reused out (T6).

### T3 -- Native typed-lane fast path  (Reader.js -- SEPARABLE; the correctness centrepiece)
When `this._le === IS_LITTLE_ENDIAN` AND a field is naturally aligned, expose lite-bake's
`typedView[row*elemStride + elemOffset]` shape for the absolute hot loop; else fall back to DataView.
  - ELIGIBILITY (per field, computed once at construction, COLD): `_le === IS_LITTLE_ENDIAN`
    AND `(base + fieldOffset) % width === 0` AND `stride % width === 0` (so every row stays
    aligned). Width = TYPE_BYTES[type]. A U8/I8 field is trivially aligned. Any field failing
    this is NOT lane-eligible; the reader still serves it via getX.
  - VIEWS: build at most one typed view per PRESENT eligible type over `_buffer` at construction
    (cold: a handful of small view wrappers, e.g. `new Float32Array(buffer)`). Precompute per
    eligible field its `elemStride = stride / width` and `elemOffset = (base + fieldOffset) / width`.
  - API (flag the exact shape for review): a probe + accessor, called ONCE outside the loop like
    field(): `laneOf(id)` returns a small descriptor `{ view, elemStride, elemOffset }` for an
    eligible field, or `null` (caller falls back to getX). Callers then run the tightest loop:
    `const {view,elemStride,elemOffset}=r.laneOf(x); for(row...) sum+=view[row*elemStride+elemOffset]`.
    The descriptor is allocated ONCE (cold, like a field-id lookup); the hot loop is a raw typed
    read with ZERO branch and ZERO alloc. Do NOT bake a per-read eligibility branch into f64(id) --
    a branch per read defeats the purpose; the fast path is opt-in via laneOf.
  - ENDIANNESS: typed arrays read HOST order only. On a big-endian READ on a little-endian host
    (`_le === false` here), NO field is eligible -- laneOf returns null everywhere, getX serves all.
CORRECTNESS PROOF (non-negotiable for this task): a T5 differential tier asserts, for EVERY
  eligible field and EVERY row, `view[row*elemStride+elemOffset] === getX(row, id)`; and asserts
  laneOf returns null for a deliberately unaligned field and for a big-endian reader. A t9 control
  mutates elemStride/elemOffset by 1 and asserts the differential now FAILS (teeth).
NON-GOAL within T3: no unaligned "fast" path (that is just getX), no endianness swap in the lane.

### T4 -- Variable-length fields: bytes(row, id) 2-arg overload  (Reader.js, additive)
A field can declare a sibling field that carries its run length; `bytes(row, id)` reads that
length and returns the borrowed span -- blob/string fields without a hardcoded len.
  - SCHEMA: a field may carry an optional `lengthField` (a name or id of another field whose
    integer value at the same row is the byte length). NO new type code -- the field keeps a
    normal type for its length-source, and the variable field is marked by `lengthField` presence.
    Confirm the exact descriptor shape against how a caller models a blob (planner decides;
    record in decisions/). Keeps the type table at 8.
  - `bytes(row, id)` (2-arg): resolve `len` = the integer read of the lengthField at `row`, then
    reuse the EXISTING coded bytes() door -- `R_BAD_LENGTH` if the resolved len is not a
    non-negative integer, `R_BUFFER_TOO_SMALL` if the span overruns, `R_UNKNOWN_FIELD` if the
    lengthField name does not resolve. NO new R_* code (union stays 10).
  - `bytes(row, id, len)` (3-arg, explicit len) stays byte-identical. Dispatch on arguments.length.
    The borrowed-view contract ("copy what you keep") is unchanged; still the one non-zero-GC method.
ASSERTION: `bytes(row, id)` with a lengthField returns the same span as `bytes(row, id, explicitLen)`
  when explicitLen equals the sibling's value; a len past the buffer throws R_BUFFER_TOO_SMALL; an
  unknown lengthField throws R_UNKNOWN_FIELD. Union stays exactly 10 (drift gate still green).

### T5 -- Reader.d.ts + VERSION sync  (REQUIRED whichever surfaces ship)
  - Add every NEW public method/getter to Reader.d.ts: seek, f64..u8/val (T1), readRow (T2),
    laneOf + a `Lane` descriptor interface (T3, if included), the bytes 2-arg overload + optional
    `lengthField` on Field/the schema (T4). The dts-drift export/classMember parity gate enforces this.
  - Bump VERSION 0.2.0 -> 0.3.0 in Reader.js AND package.json AND llms.txt (the THREE version
    sites the release skill checks; llms.txt now carries the version after S7). Drift gate T3(c)
    enforces Reader.js === package.json.
  - CHANGELOG prose is NOT this session (that is the release step). Leave a decisions/ breadcrumb
    listing what shipped so /release 0.3.0 records it under Added.

===============================================================================
## Torture / gate impact
===============================================================================
- T6 (zero-alloc): EACH new hot surface gets its own 0-B/op + retained-alloc gate --
  seek+cursor read, readRow into a reused out, and (if included) the laneOf hot loop. This is the
  roadmap's explicit rule: "Each new surface gets its own T6 zero-alloc + retained-alloc gate."
- T5 (differential): add cursor-vs-getX (T1) and, if T3 ships, the fast-lane-vs-getX differential
  across the alignment x endianness x type matrix -- the centrepiece proof for T3.
- T2 door matrix / T1 degenerate: add boundary cases -- a too-short readRow out; laneOf on an
  unaligned field and on a big-endian reader (expect null); bytes(row,id) with a bad/oversized
  lengthField value.
- t9 controls: teeth for the new checks -- a mutated elemStride makes the T3 differential fail; a
  too-short out is rejected; the reproduced-todo registry stays EMPTY (all fixed same session).
- The pinned core (getF64..getU8/get/bytes-3arg) stays byte-identical -- reviewer diffs vs v0.2.0.

===============================================================================
## DONE WHEN
===============================================================================
1. Chosen surfaces land, each ADDITIVE, with the 9 numeric bodies + get + 3-arg bytes byte-identical
   to v0.2.0 (reviewer diff).
2. Every new public member is in Reader.d.ts AND test/dts-drift.test.js is green (export + member parity).
3. R_* union is still EXACTLY 10 and the type table still EXACTLY 8 (drift gate asserts both).
4. Each new hot surface proven 0 B/op + 0 retained (its own T6 gate); LBR_TORTURE_BREAK=1 exits 1.
5. If T3 ships: laneOf reads are byte-identical to getX on every eligible cell (T5 differential),
   laneOf returns null on unaligned/big-endian, and a mutated elemStride FAILS the differential (t9).
6. VERSION 0.3.0 in Reader.js + package.json + llms.txt; drift guard enforces Reader.js === package.json.
7. `npm run verify` green (test + torture + controls). decisions/ records: the cursor checked/unchecked
   choice, the readRow out-shape + object-form defer, the lane eligibility rule + API shape, and the
   variable-length descriptor (why no new type/R_* code).

===============================================================================
## NON-GOALS (later sessions -- guard against scope creep)
===============================================================================
- No cooperation tests against REAL lite-bake / lite-bake-stream buffers -- that is S5 (v0.4.0),
  independent of S4 and can run before or after it.
- No lite-query streaming adapter -- that is S6, and it depends on S5.
- No README / llms.txt / CHANGELOG prose beyond the VERSION bump + a decisions/ breadcrumb -- the
  narrative lands at /release time.
- No write path, no schema mutation, no per-read bounds checks on getX or the cursor reads.
- No new R_* code and no new type code -- both unions are frozen invariants this session preserves.
