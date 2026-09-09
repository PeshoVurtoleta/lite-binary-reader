# 0004 -- API sugar (v0.3.0): the row cursor, readRow, and variable-length bytes

Status: accepted (v0.3.0). Context: S4 ships THREE additive ergonomic surfaces
(T1 cursor, T2 readRow, T4 variable-length `bytes`) that all REUSE the existing
DataView read path. The fourth roadmap surface, T3 (the native typed-lane fast
path), is DEFERRED to its own focused session (provisionally S4b / v0.4.0): it is
a SECOND read path whose differential + fallback matrix deserves undivided review,
and a bug there reads WRONG BYTES silently (an S1-class defect), whereas T1/T2/T4
at worst throw. Bundling a silent-corruption-risk feature with three safe wrappers
would dilute the review attention T3 needs. See BRIEF.md.

The nine numeric read bodies (`getF64..getU8`), `get`, and the four existing
statements of `bytes()` stay BYTE-IDENTICAL to v0.2.0. The ONLY edit inside a
v0.2.0 pinned body is a single new prologue line in `bytes()` (see below).

## Decision 1 -- seek(row) is UNCHECKED

`seek(row) { this._cursor = row; return this; }`. No bounds check. This matches
the getX trust model exactly: the read hot path is unchecked BY DESIGN (validation
lives at the construction door), and the cursor is the same contract in a stateful
shape. `_cursor` is initialized to `0` in the frozen field block and moved ONLY by
`seek`. It is a caller contract that `row` stays a small non-negative integer (a
Smi); a fractional or huge value is a caller bug, not a runtime-checked state --
the same latitude getF64(row, id) already takes with `row`. Cost symmetry, not a
guard, is the reason: a check here would make the cursor stricter than the getX it
mirrors, for no matching benefit.

The cursor reads INLINE the exact `getF64..getU8` / `get` address arithmetic with
`_cursor` substituted for `row` -- they never delegate through getX (which would
cost a second frame per read). This duplicates eight one-line read expressions and
the `get` switch; that duplication is the intended cost of a zero-overhead cursor.
The cursor API is STATEFUL and documented as such; the row-passing getX/get form
stays STATELESS and is the recommended shape for random access. Both APIs read the
SAME bytes with the SAME arithmetic (proven by t5 Oracle D and Reader.test A1).

## Decision 2 -- readRow(row, out) is index-by-id ONLY (object form deferred)

`readRow` writes every field of one row into a CALLER-OWNED sink indexed by field
id: `out[i] = <field i at row>` for i in [0,fieldCount). No record object is
allocated (the caller owns `out`); the fill loop is one type switch per field.
`out` may be an Array or ANY TypedArray -- both are length-carrying and
integer-indexable.

Cold door: `out == null || typeof out.length !== "number" || out.length <
this._fieldCount` throws `R_BAD_LENGTH`. Rationale: an Array too short would
auto-GROW on the first out-of-range write -- a per-call allocation that would break
the zero-GC promise -- and a TypedArray too short would silently DROP cells. The
door refuses the too-short sink up front so neither can happen through the API (t9
Control 12 proves the growth path allocates and that the length-8 path does not).

The OPTIONAL object form (`out[name] = value`) is DEFERRED. Writing string keys
into a caller object risks hidden-class churn and key materialization that would
complicate the zero-alloc proof; array-by-id is the fastest, cleanest surface and
ships alone this session. A later session may add the object form over a
pre-shaped sink if a caller need appears.

## Decision 3 -- variable-length via a `lengthField` sibling NAME

A `Field` may carry an optional `lengthField`: the NAME (or number-name) of a
sibling field whose integer value at the same row is this field's byte run length.
This is resolved COLD, ONCE, at construction into `this._lenOf = new Int32Array(n)
.fill(-1)`: for each field carrying `lengthField`, `lid = name.get(lf)`; an
undefined name is `R_UNKNOWN_FIELD`; a self-reference (`lid === i`) is
`R_BAD_SCHEMA`; otherwise `_lenOf[i] = lid`. `-1` means "no lengthField" (the
common case).

`bytes(row, id)` (2-arg) dispatches on `len === undefined` (NOT `arguments.length`
-- an explicit `undefined` third arg reads as "resolve from the sibling", the same
latitude every other `=== undefined` door in this file takes). It resolves the
length via `_lenAt(row, fieldId)` -- `const lid = this._lenOf[fieldId]; if (!(lid
>= 0)) fail("R_BAD_LENGTH", ...); return this.get(row, lid);` -- then falls into
the EXISTING coded `bytes()` door byte-for-byte: `R_BAD_LENGTH` if the resolved
length is not a non-negative integer (e.g. an F64 source holding 3.5), and
`R_BUFFER_TOO_SMALL` if the span overruns the buffer.

`_lenAt` is underscore-prefixed on purpose: it is cold, internal to the 2-arg
dispatch, and stays OUT of the public `classMembers` inventory the drift gate
counts.

## Why the two unions stay frozen (no new type code, no new R_* code)

The variable-length feature adds NEITHER a new type code NOR a new R_* code. The
length-source field keeps a NORMAL numeric type (U8/U32/... ); the variable field
is marked purely by `lengthField` PRESENCE, so `TYPE_COUNT` and the `TYPE_BYTES`
width table stay at exactly 8. Every failure reuses an existing tag:
`R_UNKNOWN_FIELD` (unknown sibling name -- the SAME class as `field(name)` on a
missing name), `R_BAD_SCHEMA` (a self-referencing lengthField -- an incoherent
schema, the same class as an empty schema), `R_BAD_LENGTH` (a non-integer/negative
resolved length OR a 2-arg call on a field without a lengthField), and
`R_BUFFER_TOO_SMALL` (an overrun span -- the same door the 3-arg form already
uses). Minting an 11th code would split one concept across two greppable tags for
no caller benefit. The R_* union staying exactly 10 and the type table staying
exactly 8 are hard suite invariants the drift gate now asserts directly
(`/const TYPE_COUNT = 8;/` and a TYPE_BYTES-has-8-entries check in check (a)).

## The one pinned-body deviation

`bytes()` gains EXACTLY ONE new statement, as its FIRST line:
`if (len === undefined) len = this._lenAt(row, fieldId);`. Its four existing
statements (the R_BAD_LENGTH len guard, the `pos` computation, the
R_BUFFER_TOO_SMALL span guard, and the `return new Uint8Array(...)`) stay
byte-identical and in order. `getF64..getU8` and `get` are NOT touched at all --
the reviewer diffs them against v0.2.0. `bytes()` remains the one intentional
non-zero-GC method (it allocates a Uint8Array view wrapper); the borrowed-view
"copy what you keep" contract is unchanged.

## Zero-GC proof

Each new hot surface gets its OWN T6 gate -- an ops window (maxMajor 0,
maxPauseMs 4, maxArrayBuffersGrowth 0) AND a retained-alloc window
(bytesPerCall <= 1, settled), strictly sequential (lite-gc-profiler is
one-measurement-at-a-time):
  - Gate 2: `seek(i&MASK)` + the 8 typed cursor reads + `val(0)` into a hoisted
    Float64Array(1).
  - Gate 3: `readRow(i&MASK, out)` into a module-hoisted `out = new Array(8)`,
    plus an `out.length === 8` post-check (readRow never grows the sink).
Both assert `_dv` identity and `buffer.byteLength` unchanged across the window.
t5 Oracle D differentials the cursor against a DataView oracle over 100k random
(row,fid). t7 soaks the cursor + readRow-into-a-reused-out + a 2-arg bytes view
per cycle, with the WeakRef census watching the dropped variable-length views.

## /release 0.3.0 breadcrumb (records under Added)

- Row cursor: `seek(row)` (chainable, unchecked) + `f64/f32/i32/u32/i16/u16/i8/u8
  (fieldId)` + `val(fieldId)` -- read at the cursor with no per-read row argument.
- `readRow(row, out)` -- fill a caller-owned Array/TypedArray sink by field id
  (the SoA->AoS bridge); a null/non-indexable/too-short sink throws R_BAD_LENGTH.
- Variable-length `bytes(row, id)` (2-arg overload) -- read the run length from a
  field's `lengthField` sibling; reuses the existing coded `bytes()` door. Field
  descriptors gain an optional `lengthField` (name or number-name).
- Reader.d.ts: `seek`, the 8 cursor reads, `val`, `readRow`, the 2-arg `bytes`
  overload, and the optional `Field.lengthField` are all declared; the drift gate
  (export + member parity, now >= 31 members) enforces the sync.
- VERSION 0.2.0 -> 0.3.0 in Reader.js, package.json, and llms.txt.
