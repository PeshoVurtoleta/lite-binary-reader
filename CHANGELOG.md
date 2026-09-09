# Changelog

All notable changes to `@zakkster/lite-binary-reader`.

## 0.5.0

A PROOF release: no runtime change. `Reader.js` moves only its `VERSION` const; the
cold cooperation constructors (`fromBaked`, `fromLBK1Shard`) and every read body are
byte-identical to 0.4.0. This release proves those constructors against the siblings'
REAL output instead of emulated bytes.

### Added
- `test/coop-bake.test.js`: `fromBaked` reads `@zakkster/lite-bake`'s real baked
  output cell-for-cell against lite-bake's own `Reader`, across all 8 lanes. Offsets
  and stride are read from lite-bake's reported layout, never recomputed.
- `test/coop-lbk1.test.js`: `fromLBK1Shard` reads a real `@zakkster/lite-bake-stream`
  shard -- F64 cells bit-exact (`Object.is`), a U32 lane read as the raw string-table
  INDEX (string resolution stays in bake-stream, by contract). Includes the D3
  no-translate CONTROL: reading the LBK1 U32 lane without the wire-to-ours code
  translation (wire 3 read raw as our T_I16) must diverge -- teeth on the translation.
- `test/coop-multireader.test.js`: a test-only `ShardUnion` mapping a global row to
  (shard, localRow) over same-schema shards, matched against bake-stream's own reader.
- `test/coop-join.test.js`: a query-builder PARENT + CHILDREN result -- each table
  baked separately, one `LiteBinaryReader` per table, joined parent-to-children by key
  in caller code (different schemas joined by key is a recipe, not a shipped API).
- `test/no-import-edge.test.js`: asserts `Reader.js` and `Reader.d.ts` import no
  sibling (`from "@zakkster/..."`) -- the D10 no-import-edge law, enforced not claimed.
- `test/mock/fixtures.js`: named flat fixtures (single-lane, all-8-lane, nested-then-
  flattened, NaN/+/-Infinity/-0 on F64, a real-data sample) driving both coop paths.
- `Cookbook.md` (repo-only, not shipped): five recipes beginner to pro, each citing
  its passing test; the flagship is the parent/children multi-reader join.
- `decisions/0006-cooperation-proof.md`: the rulings, the D3 wire-code map, the
  U32-is-a-string-index ownership boundary, and the `payload_len`/count risk + guard.

### Changed
- Test count 73 -> 81 (the cooperation-proof suites above).
- `VERSION` 0.4.0 -> 0.5.0 (`Reader.js`, `package.json`, `llms.txt`).
- `@zakkster/lite-bake` and `@zakkster/lite-bake-stream` added as `file:`
  devDependencies -- consumed by the TEST only; excluded from the published tarball.
- The torture harness is unchanged and stays sibling-free: `node --expose-gc
  test/torture.mjs` still runs standalone with its emulated oracles.

## 0.4.0

### Added
- `laneOf(fieldId)`: an opt-in native typed-array lane offered alongside `getX` for
  the hot loop over one column. A lane-eligible field returns a precomputed, frozen
  `{ view, elemStride, elemOffset }` read as `view[row*elemStride + elemOffset]` (no
  `DataView` call, no branch); an ineligible field, or an out-of-range id, returns
  `null` and is served by `getX`. Resolve it once outside the loop, like `field()`;
  the call is a lookup that allocates nothing and returns the same descriptor each time.
- Eligibility is computed cold at construction: a field is lane-eligible iff the
  reader is host-endian (`littleEndian === IS_LITTLE_ENDIAN`), the field's first byte
  is aligned (`(byteOffset + field.offset) % width === 0`), and the stride keeps every
  row aligned (`stride % width === 0`). A width-1 field (`T_U8`/`T_I8`) is always
  eligible on a host-endian reader. There is no unaligned lane and no in-lane
  endianness swap: `laneOf` hands back a host-order typed read or declines.
- At most one typed view per present eligible type is built cold over the owned
  buffer; this is the only new construction-time allocation.
- `Reader.d.ts`: a `Lane` interface (the eight TypedArray view types plus `elemStride`
  and `elemOffset`) and `laneOf(fieldId): Lane | null` on the class.

### Changed
- Test count 60 -> 73 (the `laneOf` boundary suite: eligibility across all 8 types,
  the decline contract on unaligned/odd-stride/opposite-endian/out-of-range fields,
  frozen-descriptor identity, and lane-vs-`getX` parity including a BR-07 partial-window
  source).
- Torture: a t5 lane-vs-`getX` differential across the alignment x endianness x type
  matrix, a t6 zero-alloc + retained gate for the `laneOf` call and the lane read loop,
  and a t9 control that mutates a lane's `elemStride`/`elemOffset` to prove the
  differential has teeth (plus non-vacuous decline checks).
- The drift gate's class-member floor raised 31 -> 32 for `laneOf`. The `R_*` union
  stays exactly 10 and the type-code table exactly 8 (no new code of either kind).
- The v0.3.0 numeric read bodies (`getF64`..`getU8`/`get`/`bytes`/`seek` + `f64`..`u8`/
  `val`/`readRow`) are byte-identical: `laneOf` is a second read path added beside them,
  with no per-read eligibility branch in any pinned getter.

## 0.3.0

### Added
- Row cursor: `seek(row)` (chainable, returns `this`) plus `f64`/`f32`/`i32`/`u32`/
  `i16`/`u16`/`i8`/`u8(fieldId)` and `val(fieldId)`, which read at the seeked row
  without re-passing it. The cursor read bodies inline the same address arithmetic
  as `getF64`..`getU8`/`get`; each is zero-allocation in steady state.
- `readRow(row, out)`: fills a caller-owned sink indexed by field id (`Array` or any
  `TypedArray`), no record object materialized; returns `out`. A sink that is null,
  has no numeric `length`, or is shorter than `fieldCount` throws `R_BAD_LENGTH`
  before any write.
- Variable-length `bytes(row, fieldId)`: a two-argument overload that resolves the
  span length from a sibling field named by a new optional `lengthField` on a schema
  field. Dispatched on `len === undefined`; the resolved length flows through the
  existing `R_BAD_LENGTH` / `R_BUFFER_TOO_SMALL` doors. The three-argument
  `bytes(row, fieldId, len)` is unchanged.
- `Reader.d.ts`: declarations for `seek`, the eight cursor reads, `val`, `readRow`,
  the two-argument `bytes` overload, and the optional `Field.lengthField`.

### Changed
- Test count 49 -> 60 (cursor/`readRow`/variable-length boundary and adversarial
  cases, including nonzero-base and partial-view sources, `readRow` door and
  reentrancy, and out-of-contract-row fail-closed).
- Torture: a t5 cursor-vs-`getX` differential, dedicated t6 zero-alloc + retained
  gates for the cursor and `readRow` surfaces, and t9 controls for the cursor,
  the `readRow` door, and the variable-length span.
- The drift gate now also asserts the type-code table stays at 8 entries, alongside
  the existing exactly-10 `R_*` union check.

## 0.2.0

### Added
- `Reader.d.ts`: hand-written ambient TypeScript surface for the full runtime API
  (`VERSION`, `T_*` type-code literals, `IS_LITTLE_ENDIAN`, `Field`/`Options`/`Baked`/`Shard`,
  the reader class with all getters/methods/statics, and `LiteBinaryReaderError` with a
  `code` union of all 10 `R_*` tags).
- `test/dts-drift.test.js`: a drift gate asserting the `.d.ts` error-code union, value
  exports, and version stay in lock-step with `Reader.js` and `package.json`, with mutation
  controls proving the gate has teeth.

### Fixed
- BR-08: a detached `ArrayBuffer` (and a view over a detached buffer) now throws a coded
  `R_BAD_SOURCE` instead of a raw `DataView` `TypeError`. Detection via an
  `ArrayBuffer.prototype.detached` probe (Node 21+) with a guarded `DataView` fallback on
  the `node>=18` floor; a legitimately zero-length buffer is not misclassified as detached.
- BR-09: a `DataView` source over a detached buffer now throws a coded `R_BAD_SOURCE`. A
  `DataView`'s `byteOffset`/`byteLength` getters throw on a detached buffer (unlike a
  `TypedArray`'s, which return 0), so the view branch now probes the underlying buffer for
  detachment before reading any view getter.

### Changed
- Torture door matrix expanded to 2700 cells across 6 source kinds (added a `DataView`
  kind and a detached kind); added a t9 detached-door control (teeth + non-vacuity).
- Test count 37 -> 49.

## 0.1.2

### Fixed
- BR-01: a `byteOffset` past the buffer end now throws `R_BAD_OFFSET` (was a silent
  negative derived count).
- BR-02: a non-integer type code now throws `R_BAD_TYPE` (was a silent retype and read-past).
- BR-03: a `NaN`/`Infinity`/fractional `byteOffset` now throws `R_BAD_OFFSET` (was swallowed
  by `|| 0` and read as offset 0).
- BR-04: a duplicate field name now throws `R_DUPLICATE_FIELD` (was a silent shadow).
- BR-05: `bytes()` past the buffer or with a bad length now throws `R_BUFFER_TOO_SMALL` /
  `R_BAD_LENGTH` (was a raw `RangeError` with no `.code`).
- BR-06: `fromBaked` / `fromLBK1Shard` given a malformed source now throw `R_BAD_SOURCE` /
  `R_BAD_SCHEMA` (was a raw `TypeError` while dereferencing the argument).
- BR-07: a zero-offset partial view no longer reads past its own window; a non-full-span
  view is copied to an owned window so a derived or explicit count can never exceed the
  bytes the view owns.

## 0.1.0

### Added
- Initial `LiteBinaryReader`: a zero-dependency, zero-GC `DataView` reader over a
  caller-supplied `{schema, stride, count, byteOffset, littleEndian}` layout. Typed getters
  (`getF64`..`getU8`), a data-driven `get`, a borrowed-view `bytes()` escape hatch, name
  resolution (`field`/`typeOf`/`offsetOf`), and the `fromBaked` / `fromLBK1Shard` sibling
  cooperation constructors.
