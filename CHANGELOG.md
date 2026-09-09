# Changelog

All notable changes to `@zakkster/lite-binary-reader`.

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
