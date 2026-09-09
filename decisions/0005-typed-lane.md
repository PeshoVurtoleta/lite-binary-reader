# 0005 -- native typed-lane fast path (v0.4.0): laneOf

Status: accepted (v0.4.0). Context: S4b ships T3, the fourth roadmap surface that
S4 deliberately deferred (decisions/0004): a SECOND read path -- a native
typed-array lane -- offered ALONGSIDE the DataView getX path, opt-in via
`laneOf(fieldId)`. A lane-eligible field hands the caller a precomputed
`{ view, elemStride, elemOffset }` so the hot loop is `view[row*elemStride +
elemOffset]` -- one multiply, one add, one indexed load, zero branch, zero alloc,
no DataView call. An ineligible field returns `null` and is served by getX exactly
as before. The v0.3.0 pinned core (getF64..getU8 / get / bytes / seek + f64..u8 /
val / readRow) stays BYTE-IDENTICAL: no eligibility branch enters any read body.

## The feature

- A record is `stride` bytes; field `i` sits at byte `offset` within the record;
  a lane view is a TypedArray of the field's own element type laid over the WHOLE
  buffer, indexed in ELEMENTS. For an eligible field `view[row*elemStride +
  elemOffset]` reads the same bytes DataView.getX(base + row*stride + off) reads,
  because the field is naturally aligned on every row (see the eligibility rule).
- `laneOf(fieldId) -> Lane | null`. Called ONCE outside the loop like `field()`.
  The typed views and the per-field descriptors are all built COLD at
  construction; the call is a pure array lookup returning a reference.

## Ruling 1 -- precompute (NOT lazy)

The descriptors are built in the COLD constructor pass, placed in the fixed
frozen-field order AFTER `this._lenOf` (so every reader assigns `this._lanes` in
the same hidden-class slot). Rejected the lazy "build on first laneOf(id)"
alternative: precompute is a handful of small objects at the construction DOOR
(matching the "all allocation at the door" law), keeps `laneOf` a pure lookup
(zero work, zero alloc on the call), and needs no first-call mutation that would
deopt the call site. At most ONE typed view is built per PRESENT eligible type
over `this._buffer` (e.g. one `Float32Array(buffer)` shared by every eligible F32
field); only views an eligible field actually needs are constructed.

## Ruling 2 -- frozen ONCE at construction

Each `Lane` descriptor is `Object.freeze`'d ONCE at construction, never per call.
Freezing makes the shared descriptor tamper-evident (a caller cannot silently
corrupt `elemStride`/`elemOffset` for the next reader of the same field) at zero
per-call cost. The shape is exactly `{ view, elemStride, elemOffset }` --
`elemStride = stride / width`, `elemOffset = (base + offset) / width`, both
integers BECAUSE the field passed eligibility.

## Ruling 3 -- out-of-range id returns null (no new R_* code)

`laneOf` on an out-of-range id returns `null`, not a throw. `this._lanes[fieldId]`
is a bounds-safe JS array read: an out-of-range index yields `undefined`, and
`undefined || null` is `null`. This matches the getX trust model (getX is
UNCHECKED on a garbage id today) while still failing CLOSED -- a caller that asks
for a lane it cannot have gets the decline answer, never a wrong-bytes lane. NO
new R_* code is minted: the R_* union stays exactly 10.

## Why laneOf DECLINES (returns null) rather than throwing

Ineligibility is a NORMAL answer, not an error. A lane is an OPTIMIZATION over an
existing field, not a new capability: the field is always readable via getX. Three
routine, non-erroneous conditions make a field ineligible -- the reader reads the
opposite byte order, the field's first byte is unaligned, or the stride is
unaligned -- and in every one of them getX serves the read correctly. Throwing
would force every caller to wrap `laneOf` in try/catch for a condition that is not
a fault; returning `null` lets the caller branch once (`const L = r.laneOf(id); if
(L) {...} else {...}`) and fall back to getX. This is the same "null is a valid
verdict, a wrong lane is not" discipline the door uses -- fail closed, never
fail wrong.

## Why NO new R_*/type code (a lane is an optimization over an existing field)

A lane adds NEITHER a new type code NOR a new R_* code. The field keeps its normal
type code (0..7); `laneOf` reads that SAME field faster when alignment permits.
There is no new failure class to name: the only "failure" is ineligibility, which
is the `null` return, not a coded throw. `TYPE_COUNT` stays 8, `TYPE_BYTES` stays
8 entries, the R_* union stays 10 -- all three are hard suite invariants the
dts-drift gate asserts directly. `TYPE_CTOR` (the type-code -> TypedArray
constructor table) is an internal cold-only table, not a new public type surface.

## The eligibility rule (endianness x alignment)

A field is lane-eligible iff ALL hold, evaluated once in the cold pass with
`width = TYPE_BYTES[type]`:

- `this._le === IS_LITTLE_ENDIAN` -- a TypedArray reads HOST byte order only. A
  reader reading the OPPOSITE order (e.g. a big-endian wire frame on a
  little-endian host) has NO eligible field; getX serves all its reads. There is
  NO in-lane endianness swap and NO unaligned "fast" path -- laneOf either hands
  back a raw host-order typed read or declines. Those two non-goals keep the fast
  path a pure speed win with zero fidelity surface area.
- `(this._base + offset) % width === 0` -- the field's FIRST byte is naturally
  aligned (a TypedArray view over the buffer indexes in elements; an unaligned
  base would misalign element 0).
- `this._stride % width === 0` -- so EVERY row's cell stays aligned, not just row
  0. A width-2 field on an odd stride is aligned at row 0 and misaligned at row 1,
  so it declines.

A width-1 field (U8/I8) is trivially eligible on a matching-endian reader
(everything is 1-aligned).

## Zero-GC proof (torture)

- T5 (differential): for every eligible field and every row,
  `Object.is(laneOf(id).view[row*elemStride+elemOffset], getX(row,id))` across the
  alignment x endianness x type matrix (all 8 types; an aligned layout where all 8
  fields are eligible; a deliberately-unaligned base where width>1 fields decline
  and width-1 fields still match; an odd stride where a width-2 field declines;
  matching- and opposite-endian readers). The positive case is asserted
  non-vacuous (>= 1 eligible field), and laneOf is asserted `null` for a
  deliberately unaligned field AND for an opposite-endian reader.
- T6 (zero-alloc): the `laneOf` call is 0 B/op (a lookup), and the lane read loop
  `view[row*elemStride+elemOffset]` is 0 B/op + 0 retained over a large row count,
  its own ops window + retained-alloc window (matching the existing t6 gate
  thresholds/shape), plus the structural invariants (buffer.byteLength and _dv
  identity unchanged across the window).
- T9 (controls): the correct lane matches getX on every row (non-vacuity); a lane
  with `elemStride+1` diverges from getX and a lane with `elemOffset+1` diverges
  (teeth); the descriptor is asserted frozen; and the decline contract is
  non-vacuous (an eligible field exists; an opposite-endian reader and a
  deliberately unaligned width-2 field both decline). `LBR_TORTURE_BREAK=1` still
  exits 1 (the whole-suite alloc control trips at T6 Gate 1, ahead of the lane
  gate).

## /release 0.4.0 breadcrumb (records under Added)

- `laneOf(fieldId) -> Lane | null` -- the native typed-lane fast path. For a
  lane-eligible field returns a precomputed frozen `{ view, elemStride, elemOffset
  }`; read `view[row*elemStride+elemOffset]` in the hot loop (zero DataView, zero
  branch, zero alloc). Returns `null` for an ineligible field (opposite
  endianness, or an unaligned field/stride) or an out-of-range id -- fall back to
  getX. Resolve ONCE outside the loop, like `field()`.
- A field is lane-eligible iff `littleEndian === IS_LITTLE_ENDIAN` (host byte
  order), `(byteOffset + field.offset) % width === 0`, and `stride % width === 0`.
  No in-lane endianness swap, no unaligned fast path: laneOf hands back a host-order
  typed read or declines.
- Reader.d.ts: a `Lane` interface (the eight TypedArray view types + `elemStride`
  + `elemOffset`) and `laneOf(fieldId): Lane | null` on the class; the drift gate
  (export + member parity, floor raised to >= 32) enforces the sync.
- NO new type code, NO new R_* code -- a lane is an optimization over an existing
  field. TYPE_COUNT stays 8, the R_* union stays 10 (both gated).
- VERSION 0.3.0 -> 0.4.0 in Reader.js, package.json, and llms.txt.
