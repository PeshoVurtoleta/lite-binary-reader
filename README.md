# @zakkster/lite-binary-reader

> Zero-dependency, zero-GC reader for RAW, foreign, or sibling-baked binary buffers. Point it at an `ArrayBuffer` plus a field layout and read fields with no allocation, at any byte offset, with explicit endianness. Reads through a `DataView`, so a field can sit at an odd (unaligned) offset a typed-array lane cannot address, and byte order is a caller decision -- so it reads a buffer whose endianness differs from the host, which `lite-bake` refuses.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-binary-reader.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-binary-reader)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-binary-reader?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-binary-reader)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-binary-reader?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-binary-reader)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-binary-reader?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-binary-reader)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

> Reads at a hand-written `DataView` loop's speed -- `laneOf` beats it -- and allocates **zero bytes per read**. On the same records it decodes ~8.6x faster than `binary-parser` with **0 B/op** against its per-row objects, from one 9.5 KB (gzip) file with zero dependencies. [See the numbers](#performance).

## The foreign-bytes reader the ecosystem was missing

`lite-binary-reader` is the raw-input end of the `@zakkster` binary pipeline. `lite-bake` bakes an in-memory column store; `lite-bake-stream` frames a self-describing LBK1 container. Both WRITE binary the suite already understands. Nothing in the suite READS bytes it did not write: a wire protocol off a socket, an mmap'd C struct, WASM linear memory, an SoA column dump, or a record whose fields sit at odd byte offsets. This package is that piece -- a `DataView`-backed reader over a layout you describe, with byte order you choose.

```bash
npm install @zakkster/lite-binary-reader
```

Zero runtime dependencies -- nothing to install alongside it.

```js
import { LiteBinaryReader, T_F32, T_U16, T_U8 } from '@zakkster/lite-binary-reader';

// A foreign record stream: 10 bytes per record, fields at ODD offsets, LITTLE-endian.
//   [0] u16 id | [2] f32 x | [6] f32 y ... but say the wire packs id, then a
//   temperature f32 at offset 2, then a status u8 at offset 6 -- 7 bytes, no padding.
const wire = new ArrayBuffer(7 * 3);       // 3 records, stride 7
const dv = new DataView(wire);
for (let i = 0; i < 3; i++) {
  dv.setUint16(i * 7 + 0, 1000 + i, true);       // id
  dv.setFloat32(i * 7 + 2, 20.5 + i, true);      // temp
  dv.setUint8(i * 7 + 6, i === 1 ? 0 : 1);       // status
}

const reader = new LiteBinaryReader(wire, {
  schema: [
    { name: 'id',     type: T_U16, offset: 0 },
    { name: 'temp',   type: T_F32, offset: 2 },   // an UNALIGNED f32 -- a typed-array lane cannot address this
    { name: 'status', type: T_U8,  offset: 6 },
  ],
  stride: 7,
  littleEndian: true,
});

// Resolve names to ids ONCE, outside the loop; index by id inside it.
const ID = reader.field('id'), TEMP = reader.field('temp'), OK = reader.field('status');

for (let r = 0; r < reader.count; r++) {
  // Zero allocation per read: one DataView.getX at base + row*stride + offset.
  console.log(reader.getU16(r, ID), reader.getF32(r, TEMP), reader.getU8(r, OK));
}
```

One `DataView`, any byte offset, endianness you choose, zero allocation on every read. The construction door validates the whole layout up front and fails closed with a coded error; the read path assumes correctness and never branches on a bad state.

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [The read model](#the-read-model)
- [API reference](#api-reference)
  - [The constructor](#the-constructor)
  - [Introspection](#introspection)
  - [The read hot path](#the-read-hot-path)
  - [The row cursor](#the-row-cursor)
  - [Row fill](#row-fill)
  - [The typed-lane fast path](#the-typed-lane-fast-path)
  - [The bytes escape hatch](#the-bytes-escape-hatch)
  - [Sibling cooperation](#sibling-cooperation)
  - [Type codes](#type-codes)
  - [Error codes](#error-codes)
- [Composability with the ecosystem](#composability-with-the-ecosystem)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Performance](#performance)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

---

## Why this exists

Reading foreign binary in JavaScript has two problems no small library solves at once:

1. **Unaligned fields and foreign endianness.** A typed-array lane (`new Float32Array(buf, off)`) throws on a misaligned view and only ever reads host byte order. Real wire formats and C structs pack fields at whatever offset is convenient and choose their own endianness. A `DataView` reads any type at any offset with an explicit `littleEndian` flag -- so this reader can address a field at offset 2, and read a big-endian buffer on a little-endian host. `lite-bake`, native-endian by construction, cannot. When a field IS naturally aligned and host-endian, the typed-array lane is the faster read -- so this reader offers it too, as an opt-in `laneOf` fast path that declines (returns `null`) on exactly the fields a lane cannot serve.

2. **A hot read loop that does not allocate.** Materializing a `{ id, temp, status }` object per record, per frame, hands the GC a bag of short-lived garbage -- and the pauses land as visible jitter in a preview or a scrub. This reader materializes nothing: a read is one `DataView.getX(base + row*stride + off, le)` returning a number. One reader owns the `DataView` and the compacted schema tables; every read after construction allocates zero.

Existing options: hand-rolled `DataView` offset arithmetic (correct, but you re-derive stride and re-check bounds by hand at every call site, and a typo reads past the buffer silently), a typed-array view per field (throws on unaligned offsets, host-endian only), or a full schema/parser library (heavyweight, allocates a parsed object graph). This reader is the API for exactly this job: a described layout, read in place.

---

## What you get

- **`new LiteBinaryReader(source, options)`** -- the reader. `source` is an `ArrayBuffer` or any view (`TypedArray` or `DataView`); `options` is the `{ schema, stride?, count?, littleEndian?, byteOffset? }` layout. The constructor validates and compacts the schema into SoA tables, resolves the owned buffer, and freezes the shape. Build it once per `(source, layout)`; reuse it across the read loop.
  - **`getF64`..`getU8`(row, fieldId)** -- eight typed reads, one per type code. Each call site is monomorphic and branch-free: `reader.getF32(i, x)` pays no type switch.
  - **`getI64` / `getU64`(row, fieldId)** -- the two 64-bit lanes (S9), returning a `bigint`. Identical hot-path shape to the eight above, with one honest difference: a `BigInt` is a heap value, so these **allocate** per read -- the second documented exception alongside `bytes()`. The zero-GC guarantee is unqualified on the 8 primitive-number lanes.
  - **`get(row, fieldId)`** -- the generic read; dispatches on the field's stored type code (one branch). Reach for it when the type is data-driven (a mixed-schema walk, tooling, debug); reach for a typed `getX` in a tight loop. Returns `number | bigint` (a `bigint` for a 64-bit field).
  - **`seek(row)` + `f64`..`u8`(fieldId) + `val(fieldId)`** -- a row cursor for sequential scans: seek a row once, then read its fields without re-passing the row. The cursor reads are the `getX` bodies with the seeked row substituted -- still zero-allocation.
  - **`readRow(row, out)`** -- fills a caller-owned sink (an `Array` or any `TypedArray`) indexed by field id, no record object materialized -- the SoA-to-AoS bridge.
  - **`laneOf(fieldId)`** -- an opt-in typed-array lane for the absolute hot loop: for a naturally aligned, host-endian field it hands back a `{ view, elemStride, elemOffset }` you index directly (`view[row*elemStride + elemOffset]`), skipping the `DataView` call; for any other field it returns `null` and you fall back to `getX`.
  - **`bytes(row, fieldId, len)`** and **`bytes(row, fieldId)`** -- a borrowed `Uint8Array` view over raw bytes: the escape hatch for a blob or variable-length field. The two-argument form reads the span length from a sibling `lengthField`. Copy what you keep.
  - **`field` / `typeOf` / `offsetOf`** -- name-to-id resolution and per-field introspection.
- **`LiteBinaryReader.fromBaked(baked, options?)`** and **`fromLBK1Shard(shard, options?)`** -- two cold constructors that read a sibling's output directly (see [Sibling cooperation](#sibling-cooperation)).
- **Type-code constants** -- `T_F32`..`T_U8` (0..7), byte-for-byte `lite-bake`'s table, plus the 64-bit `T_I64` (8) / `T_U64` (9) lanes (S9), `IS_LITTLE_ENDIAN`, and `VERSION`.
- **`LiteBinaryReaderError`** -- one coded error class; `error.code` carries one of exactly ten greppable `R_*` tags. Every degenerate input throws a coded error at the door, so the read loop assumes a valid state.

Full types ship in [`Reader.d.ts`](./Reader.d.ts), kept in lock-step with the runtime by a drift gate. Every export is declared.

---

## The read model

A record is `stride` bytes. Record `i` starts at `base + i*stride`, where `base` is the optional `byteOffset` into the buffer. Each field has a byte `offset` within the record and a `type` code. A read is:

```
value = DataView.getX(base + row*stride + fieldOffset, littleEndian)
```

No allocation, no parsing, no object materialized. Field access is by integer id: resolve a name to an id ONCE with `field(name)` outside the loop, then index by that id inside it -- the same `get(row, field)` shape the rest of the ecosystem uses.

```js
// Derived stride and count: omit `stride` and it is the tightly-packed minimum
// (the largest field end); omit `count` and it is floor((byteLength - base) / stride).
const r = new LiteBinaryReader(buf, {
  schema: [{ name: 'a', type: T_U32, offset: 0 }, { name: 'b', type: T_F64, offset: 4 }],
});
r.stride;  // 12  (u32 ends at 4, f64 ends at 12)
r.count;   // floor(buf.byteLength / 12)
```

---

## API reference

### The constructor

```ts
new LiteBinaryReader(
  source: ArrayBuffer | ArrayBufferView,
  options: {
    schema: { name: string | number; type: TypeCode; offset: number }[];
    stride?: number;
    count?: number;
    littleEndian?: boolean;
    byteOffset?: number;
  }
): LiteBinaryReader
```

- **`source`** -- an `ArrayBuffer` (used zero-copy) or any view. A full-span, zero-offset view unwraps to its buffer zero-copy; any other view -- a nonzero-`byteOffset` view or a zero-offset PARTIAL view -- is COPIED to its own window, so a derived or explicit count can never read past the bytes the view owns. A detached (transferred-away) buffer, or a view over one, is refused with `R_BAD_SOURCE` before it can throw a raw `DataView` `TypeError`.
- **`schema`** -- a non-empty array of `{ name, type, offset }`. `name` is a string or number; `type` is a `T_*` code (integer 0..7); `offset` is a non-negative integer. A duplicate name throws `R_DUPLICATE_FIELD` (a silent shadow is refused); a bad type throws `R_BAD_TYPE`; a bad offset throws `R_BAD_OFFSET`.
- **`stride`** -- bytes per record. Omitted, it defaults to the tightly-packed minimum (the largest field end). A stride smaller than that end, or a non-positive stride, throws `R_BAD_STRIDE`.
- **`count`** -- record count. Omitted, it defaults to `floor((byteLength - byteOffset) / stride)`. A `count * stride` that exceeds the available bytes throws `R_BUFFER_TOO_SMALL`.
- **`littleEndian`** -- read byte order. Default `true` (the sane wire default). Set `false` for a big-endian buffer.
- **`byteOffset`** -- where the record region starts inside the buffer. Default 0. A NaN/fractional/negative offset, or one past the buffer end, throws `R_BAD_OFFSET` (it is checked with an explicit `=== undefined`, never swallowed by `|| 0`).

The constructor does all validation and all allocation. Rebuild only when the source or the layout changes.

### Introspection

```ts
get count(): number          // record count
get stride(): number         // bytes per record
get fieldCount(): number     // number of schema fields
get littleEndian(): boolean  // the read byte order in effect
get buffer(): ArrayBuffer    // the resolved, owned buffer

field(name: string | number): number   // name -> integer id; throws R_UNKNOWN_FIELD. Call ONCE.
typeOf(fieldId: number): number         // the field's type code
offsetOf(fieldId: number): number       // the field's byte offset within a record
```

### The read hot path

```ts
getF64(row, fieldId): number   getF32(row, fieldId): number
getI32(row, fieldId): number   getU32(row, fieldId): number
getI16(row, fieldId): number   getU16(row, fieldId): number
getI8(row, fieldId): number    getU8(row, fieldId): number
getI64(row, fieldId): bigint   getU64(row, fieldId): bigint   // 64-bit lanes -- ALLOCATE a BigInt
get(row, fieldId): number | bigint   // generic; dispatches on the stored type code
```

`row` is in `[0, count)` and `fieldId` is a valid id -- **unchecked for speed**. Validation lives at the door, not per read. One method per type keeps each call site monomorphic; use a typed `getX` in a tight loop and `get` only when the type is data-driven. The **eight primitive-number getters** (`getF64`..`getU8`) allocate **nothing**. The two 64-bit getters (`getI64`/`getU64`) return a `bigint`, which is a heap value by spec, so they **allocate one BigInt per read** -- the second documented exception alongside `bytes()` (see [64-bit lanes](#64-bit-lanes)).

### The row cursor

```ts
seek(row: number): this   // sets the cursor; returns this (chainable)
f64(fieldId): number   f32(fieldId): number
i32(fieldId): number   u32(fieldId): number
i16(fieldId): number   u16(fieldId): number
i8(fieldId): number    u8(fieldId): number
val(fieldId): number   // generic; dispatches on the stored type code
```

For a sequential scan, `seek(row)` once and then read fields off the cursor -- ergonomic when a loop walks rows in order:

```js
const temp = reader.field('temp'), status = reader.field('status');
for (let r = 0; r < reader.count; r++) {
  reader.seek(r);
  if (reader.u8(status) === 1) sum += reader.f32(temp);
}
```

Each cursor read is the matching `getX` body with the seeked row substituted -- monomorphic, branch-free, and zero-allocation. `seek` is **unchecked** (it only sets the cursor and returns `this`), the same trust model as the row-passing getters; the row-passing `getX(row, fieldId)` API stays stateless and is the recommended form for random access. Both read the same bytes.

### Row fill

```ts
readRow<T extends { length: number; [i: number]: number }>(row: number, out: T): T
```

Fills a **caller-owned** sink indexed by field id -- `out[i]` receives field `i` of `row` -- and returns `out`. No record object is materialized; pass a reused `Array` or a `TypedArray` and the fill is zero-allocation:

```js
const out = new Array(reader.fieldCount);   // allocated once, reused every row
for (let r = 0; r < reader.count; r++) {
  reader.readRow(r, out);                    // out[0..fieldCount) filled in place
  handle(out);
}
```

A sink that is `null`, has no numeric `length`, or is shorter than `fieldCount` throws `R_BAD_LENGTH` **before any write** -- the door exists to protect the zero-allocation claim itself, since a short `Array` would auto-grow. The loop bounds on `fieldCount`, not `out.length`, so a longer sink is fine and a hostile `length` getter cannot force a short write or a read past.

### The typed-lane fast path

```ts
interface Lane { view: TypedArray; elemStride: number; elemOffset: number }

laneOf(fieldId: number): Lane | null
```

For the absolute hot loop over one column, `laneOf` hands back a native typed-array lane so the read is a raw indexed load -- no `DataView` call, no branch. Resolve it ONCE outside the loop, exactly like `field()`: an **eligible** field returns `{ view, elemStride, elemOffset }`; an **ineligible** one returns `null`, and you fall back to `getX`.

```js
const price = reader.field('price');
const L = reader.laneOf(price);
let total = 0;
if (L) {
  const { view, elemStride, elemOffset } = L;   // e.g. a Float64Array over the buffer
  for (let r = 0; r < reader.count; r++) total += view[r * elemStride + elemOffset];
} else {
  for (let r = 0; r < reader.count; r++) total += reader.getF64(r, price);   // lane declined -- getX serves it
}
```

A field is lane-**eligible** only when a typed-array lane reads the exact same bytes `getX` would: the reader is host-endian (`littleEndian === IS_LITTLE_ENDIAN`), the field's first byte is naturally aligned (`(base + offset) % width === 0`), and the stride keeps every row aligned (`stride % width === 0`). A width-1 field (`T_U8`/`T_I8`) is always eligible on a host-endian reader; an unaligned field, an odd stride, or an opposite-endian reader **declines** -- `laneOf` returns `null` for that field (and for every field of an opposite-endian reader), never a lane that would read wrong bytes. An out-of-range `fieldId` returns `null` too.

The eligibility test and the views are computed **once, cold, at construction**; `laneOf` itself is a pure lookup that allocates nothing and returns the **same frozen descriptor** on every call. The lane read loop is zero-allocation and zero-retained -- its own torture gate holds it there. `laneOf` is a strict speed option, never a fidelity one: it either hands back a host-order typed read or declines, so a caller can always run the `if (L) ... else getX` shape above and be correct on every source. There is no unaligned "fast" path (that is just `getX`) and no endianness swap inside a lane.

### The bytes escape hatch

```ts
bytes(row: number, fieldId: number, len: number): Uint8Array   // explicit length
bytes(row: number, fieldId: number): Uint8Array                // length from a sibling lengthField
```

A zero-copy `Uint8Array` view over raw bytes at a field position -- for a blob, a variable-length field, or a foreign sub-record. The view **aliases the buffer**: it is borrowed, valid until the buffer changes. Copy what you keep. This allocates one small view wrapper (it is the one non-zero-GC method) -- do not call it on the frame hot path. A bad `len` throws `R_BAD_LENGTH`; a span past the buffer throws `R_BUFFER_TOO_SMALL` (never a raw `RangeError` without a `.code`).

The two-argument form reads the length from a sibling field: mark a schema field with `lengthField` naming the field that carries its run length, and `bytes(row, fieldId)` resolves that length per row.

```js
const reader = new LiteBinaryReader(buf, {
  schema: [
    { name: 'len',  type: T_U32, offset: 0 },
    { name: 'blob', type: T_U8,  offset: 4, lengthField: 'len' },  // span length is the 'len' field
  ],
  stride: 20,
});
const blob = reader.field('blob');
const span = reader.bytes(0, blob);   // len read from the sibling 'len' field at row 0
```

The resolved length flows through the same coded doors: a length that is not a non-negative integer throws `R_BAD_LENGTH`, and a span past the buffer throws `R_BUFFER_TOO_SMALL`. A `lengthField` naming an unknown field is refused at construction with `R_UNKNOWN_FIELD`, and a self-referencing one with `R_BAD_SCHEMA`. Calling the two-argument form on a field with no `lengthField` throws `R_BAD_LENGTH`. No new type code and no new error code -- a variable-length field is an ordinary field plus a `lengthField` pointer.

### Sibling cooperation

```ts
static fromBaked(baked: { buffer, stride, count, schema }, options?): LiteBinaryReader
static fromLBK1Shard(shard: { bytes, rowStride, fields }, options?): LiteBinaryReader
```

- **`fromBaked`** reads a buffer produced by `@zakkster/lite-bake`. Its `schema` drops in unchanged (the type tables are identical), and it is read as NATIVE endianness, because `lite-bake` writes native with no marker.
- **`fromLBK1Shard`** reads ONE carved LBK1 shard payload from `@zakkster/lite-bake-stream` -- `{ bytes, rowStride, fields:[{ name, laneKind, offsetInRow }] }`. It TRANSLATES LBK1's `lane_kind` to this reader's type code (a single ambiguous integer never crosses the boundary) and reads little-endian (LBK1 is little-endian by spec). An LBK1 U32 lane is a string-table INDEX; this reader returns that index number -- string resolution stays in `lite-bake-stream`.

Both validate the argument SHAPE before any dereference, so a null or malformed sibling object yields a coded `R_BAD_SOURCE` / `R_BAD_SCHEMA`, not a raw `TypeError`.

### Type codes

| Constant | Value | DataView read | Width (bytes) |
| -------- | ----- | ------------- | ------------- |
| `T_F32`  | 0     | `getFloat32`  | 4             |
| `T_F64`  | 1     | `getFloat64`  | 8             |
| `T_I32`  | 2     | `getInt32`    | 4             |
| `T_I16`  | 3     | `getInt16`    | 2             |
| `T_I8`   | 4     | `getInt8`     | 1             |
| `T_U32`  | 5     | `getUint32`   | 4             |
| `T_U16`  | 6     | `getUint16`   | 2             |
| `T_U8`   | 7     | `getUint8`    | 1             |
| `T_I64`  | 8     | `getBigInt64` | 8             |
| `T_U64`  | 9     | `getBigUint64`| 8             |

Codes 0-7 are byte-for-byte `@zakkster/lite-bake`'s `Types` table, so a `lite-bake` schema drops into this reader unchanged. Codes 8-9 are the 64-bit lanes added in 1.1.0 (see [64-bit lanes](#64-bit-lanes)). `IS_LITTLE_ENDIAN` (the host byte order, detected once) and `VERSION` (the shipped version string) are also exported.

### 64-bit lanes

`T_I64` (8) and `T_U64` (9) read a 64-bit integer field. `getI64`/`getU64` (and the cursor `i64`/`u64`, and `get`/`val`/`readRow` on such a field) return a **`bigint`** -- the only representation that carries the full 64-bit range faithfully. A `bigint` is a heap value by spec, so **every 64-bit read allocates one BigInt** (measured ~32 B/read retained). This is deliberate and unavoidable: there is no zero-allocation way to obtain a 64-bit *value* in JS, and every reader that returns 64-bit integers allocates the same way. So `getI64`/`getU64` are the **second documented allocating exception** alongside `bytes()`; the zero-GC guarantee stays **unqualified on the 8 primitive-number lanes** (codes 0-7), which are untouched.

Two edges worth knowing:

- **`readRow` sink.** A mixed 64-bit row yields `number | bigint` cells, and a numeric `TypedArray` sink (e.g. `Float64Array`) **cannot hold a BigInt** -- it throws a `TypeError`. Use an `Array` sink for a mixed row, or a `BigInt64Array` / `BigUint64Array` sink for an all-64-bit row of that signedness.
- **`laneOf`.** A 64-bit field's lane view is a `BigInt64Array` / `BigUint64Array` (same host-endian + 8-aligned eligibility as any other width). Obtaining the view is still 0 B/op and it is the fastest **bulk** 64-bit path, but each element read mints a BigInt -- so it is an **allocating** lane, distinct from the 8 that are truly zero-alloc.

### Error codes

Every failure throws a `LiteBinaryReaderError` whose `.code` is one of exactly ten `R_*` tags. A drift gate holds the union at exactly ten and keeps it in sync with the shipped types.

| Code | Thrown when |
| ---- | ----------- |
| `R_BAD_SOURCE`       | source is not an `ArrayBuffer`/view, or its backing buffer is detached |
| `R_BAD_SCHEMA`       | schema is not a non-empty array of field descriptors |
| `R_BAD_TYPE`         | a `field.type` is not an integer in 0..7 (or an unsupported LBK1 lane_kind) |
| `R_BAD_OFFSET`       | a `field.offset` or `byteOffset` is not a coherent non-negative integer, or `byteOffset` is past the buffer end |
| `R_BAD_STRIDE`       | stride is not a positive integer, or is smaller than the largest field end |
| `R_BAD_COUNT`        | count is not a non-negative integer |
| `R_BAD_LENGTH`       | `bytes()` `len` is not a non-negative integer |
| `R_DUPLICATE_FIELD`  | two schema fields share a name |
| `R_BUFFER_TOO_SMALL` | declared `count*stride` (+ base) exceeds the buffer, or a `bytes()` span reads past it |
| `R_UNKNOWN_FIELD`    | `field(name)` was asked for a name not in the schema |

---

## Composability with the ecosystem

The reader is the input end of the `@zakkster` binary pipeline -- it consumes what the writers produce, and consumes foreign bytes they never touch.

```js
import { LiteBinaryReader } from '@zakkster/lite-binary-reader';

// 1. Read a buffer baked by @zakkster/lite-bake -- schema unchanged, native-endian.
//    `baked` is lite-bake's returned { buffer, stride, count, schema }.
const fromBake = LiteBinaryReader.fromBaked(baked);
const price = fromBake.field('price');
let total = 0;
for (let r = 0; r < fromBake.count; r++) total += fromBake.getF64(r, price);

// 2. Read one carved shard from @zakkster/lite-bake-stream's LBK1 container.
//    Take these primitives from that reader's schema + shardPayload(i) + strideBytes().
const shard = { bytes: payload, rowStride: stride, fields: streamFields };
const fromStream = LiteBinaryReader.fromLBK1Shard(shard);

// 3. Read raw foreign bytes nothing in the suite wrote -- a wire frame, a C struct,
//    WASM linear memory -- with an explicit layout and endianness.
const fromWire = new LiteBinaryReader(socketBuffer, {
  schema: wireSchema, stride: 16, littleEndian: false,  // big-endian on the wire
});
```

Every stage passes a flat `ArrayBuffer` and reads numbers out -- no format translation, no allocation between stages, and (via the shared type table) no schema rewriting to move a `lite-bake` layout into this reader.

As of 0.5.0 this cooperation is PROVEN against the siblings' REAL output, not emulated bytes: `fromBaked` reads `@zakkster/lite-bake`'s baked buffer cell-for-cell against lite-bake's own `Reader` across all 8 lanes, and `fromLBK1Shard` reads a real `@zakkster/lite-bake-stream` shard with F64 cells bit-exact and the LBK1 wire lane codes translated to ours (a no-translate control is asserted to diverge). The siblings are `file:` devDependencies of the TEST only -- there is no import edge, asserted by a test. A real query-builder shape -- a PARENT table with CHILDREN outputs -- bakes each table separately, opens one reader per table, and joins parent to children by key in caller code; because that joins different schemas by key it stays a recipe, never a shipped API. See `Cookbook.md`.

As of 0.6.0 the reader is also PROVEN to feed a `@zakkster/lite-query` `streamQuery` `stream:` generator with zero-GC binary reads: a streamed FOREIGN feed (bytes no baker wrote) is wrapped per window in a `LiteBinaryReader` and yielded as primitives, and a real `@zakkster/lite-bake-stream` shard is read through `fromLBK1Shard` inside the stream -- both abort-clean on detach, with a 0 B/op frame path. lite-query is a `file:` devDependency of the TEST only; there is no import edge. The one contract the adapter must honor: the `stream:` generator wires the abort `signal` to cancel its in-flight source read (an async generator parked on an await cannot otherwise be released on detach). See `Cookbook.md` and `examples/streamQuery-adapter.md`.

---

## Zero-GC design notes

<details>
<summary>What the read path allocates (nothing), and how it stays that way.</summary>

One `LiteBinaryReader` does all its allocation in the constructor: it compacts the schema into two SoA typed arrays (an `Int32Array` of offsets, a `Uint8Array` of type codes) and a name-to-id `Map`, resolves the owned buffer, and constructs the single `DataView`. Every field of the instance is set once, in a fixed order, so all readers share one hidden class. After construction, a read is pure address arithmetic and one `DataView.getX` -- it touches only the pre-allocated tables and the caller's buffer.

| Operation | Steady-state allocations |
| --------- | ------------------------ |
| `getF64`..`getU8`  | **0** |
| `get` (generic, on a primitive field) | **0** |
| `seek` + `f64`..`u8` / `val` (cursor, primitive) | **0** |
| `readRow(row, out)` into a reused sink (primitive row) | **0** |
| `laneOf(fieldId)` call | **0** (a lookup returning a precomputed frozen descriptor) |
| lane read loop (`view[row*elemStride+elemOffset]`, primitive) | **0** |
| `field` / `typeOf` / `offsetOf` | **0** |
| `getI64` / `getU64` / `i64` / `u64` (64-bit lanes) | **one BigInt per read** (documented exception; a BigInt is a heap value) |
| 64-bit lane read loop (`BigInt64Array` element) | **one BigInt per read** (view is 0 B/op; the element read allocates) |
| `bytes(row, field[, len])` | one `Uint8Array` view wrapper (documented; not for the frame hot path) |
| constructor        | once, per `(source, layout)` -- SoA tables + `DataView`; a non-full-span view also copies to an owned window; a lane view per present eligible type |

Each new hot surface carries its own zero-alloc and retained-alloc gate: the cursor reads and `readRow` are held to **0 B/op** and **0 retained bytes** the same way the typed getters are. The two 64-bit lanes are the exception, and the torture suite **proves** rather than assumes it: a dedicated gate retains a batch of `getI64` results and asserts the heap grows well past a 100 KB floor (and strictly above the identical-shape primitive loop), the positive companion to the eight 0-B/op gates.

The one cold branch is the throw path: a coded error is built (and its message concatenated) only when a read is invalid, never in steady state. The torture gate (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`, run under `--expose-gc`) proves **0 B/op** and **0 retained bytes** across the read loop and prints exactly `ok`. A `LBR_TORTURE_BREAK=1` control injects a retained allocation into that same loop and the alloc gate rejects it with a non-zero exit -- a gate that cannot fail is decorative.

</details>

---

## Performance

Numbers exist to prove the four reasons this package exists: it is **fast**, it is **zero-GC**, it is **tiny**, and it makes a compact wire payload **cheap to consume**. Reproduce them:

```bash
npm run bench            # node --expose-gc bench/bench.mjs
```

The harness (`bench/bench.mjs`, repo-only) warms up, brackets each timed loop with `gc()` and `process.hrtime.bigint()`, and reports **both** ns/row and transient/retained bytes per operation. Every contender must decode the **identical** values -- checked cell-for-cell against a `DataView` oracle -- before its timings are trusted; a number measured against wrong or unequal work is not a comparison. Wall-clock figures are **advisory** (they move machine to machine); the **bytes/op** columns are deterministic and are the load-bearing headline. Figures below are representative of one run on Node 26 (LE host, 20,000 records/pass) -- run the command for your own.

### Fast + zero-GC: the read surfaces vs a hand-written `DataView` loop

The plain-`DataView` loop is the honest floor -- the code you would write by hand. The reader matches it and adds the schema door, endianness, and bounds validation for free; `laneOf` goes below it.

| Read surface | ns/row | Allocation |
| ------------ | -----: | ---------- |
| plain `DataView` loop (the floor) | ~0.85 | 0 B/op |
| `getX` (random access) | ~1.0 | **0 B/op** |
| `seek` + cursor | ~1.5 | **0 B/op** |
| `readRow` into a reused sink | ~11 | **0 B/op** |
| `get` (data-driven dispatch) | ~9.5 | **0 B/op** |
| **`laneOf` view read** (aligned f32 column) | **~0.57** | **0 B/op** |
| plain `DataView` loop (same f32 column) | ~0.61 | 0 B/op |

`laneOf` reads a raw `Int16Array`/`Float32Array` view -- it is *faster* than a `DataView` loop and is the path for the absolute hot loop over one aligned column. The `0 B/op` claim is proven independently and more strictly by the torture gate (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler` under `--expose-gc`), which holds every read surface to 0 B/op **and** 0 retained bytes; the bench's coarser `heapUsed`-delta sampling corroborates it.

### Fast + zero-GC: vs comparable read libraries

Same tightly-packed little-endian record (the one layout every library reads natively), decode all records and read four fields. These libraries **materialize a JS object per record by design** -- that allocation is inherent to their model, not a defect; the transient column is the cost of that model on a read-only primitive workload.

| Library | ns/row | Transient/op | vs `lite-binary-reader` |
| ------- | -----: | -----------: | ----------------------- |
| **`lite-binary-reader` `getX`** | **~1.0** | **0 B** | 1.0x |
| `binary-parser` (bulk `.array`) | ~8.6 | ~3 B/row | ~**8.6x** slower, allocates |
| `restructure` (bulk `Array`) | ~590 | ~25 B/row | ~590x slower, allocates |
| `typed-struct` (per-record view) | ~1470 | ~22 B/row | ~1470x slower, allocates |

The fair, marquee comparison is **`binary-parser`** -- a real bulk binary parser built for exactly this: ~8.6x slower and ~3 B/row where the reader allocates nothing. `restructure` (a `DecodeStream`-based format parser) and `typed-struct` (a lazy `Proxy`-accessor view) are reported for completeness; their models are not built for bulk primitive decode, so those multipliers reflect a workload fit, not a like-for-like engine race, and are not leaned on. Write-only encoders and framework-coupled readers are excluded, as is any library that will not install.

### Tiny: footprint + runtime dependencies

| Package | Footprint | Runtime deps |
| ------- | --------- | :----------: |
| **`@zakkster/lite-binary-reader`** | **9.5 KB gzip** (one shipped file; 36 KB tarball, 7 files) | **0** |
| `binary-parser@2.3.0` | ~269 KB installed | 0 |
| `restructure@3.0.2` | ~199 KB installed | 0 |
| `typed-struct@2.7.3` | ~484 KB installed | 0 |

All four are dependency-free; the differentiator is size -- one small file versus a 200-500 KB install.

### Saves traffic: fixed-stride binary vs JSON

The bakers (`lite-bake` / `lite-bake-stream`) *produce* the compact bytes; this reader is what makes *consuming* them zero-copy and zero-GC. For 20,000 of the record above:

| Payload | On the wire | gzipped | Decode 20k records | Alloc |
| ------- | ----------- | ------- | ------------------ | ----- |
| fixed-stride binary (11 B/record) | **220 KB** | ~217 KB | **~1 ns/record** (`getX`) | **0 B** |
| JSON | ~1.13 MB (**5.2x** larger) | ~390 KB (~1.8x) | ~110 ns/record (`JSON.parse` + read) | ~6 B/record |

Compact bytes on the wire, and ~100x cheaper to consume once they arrive -- with no allocation.

### The endianness split-class question, answered with data

A recurring suggestion is to split the getters into hardcoded little-endian and big-endian classes so `DataView.getX` receives a literal byte order instead of the reader's dynamic `_le` flag. The bench measures it directly: a literal-endianness getter is ~4% faster than the dynamic one **in an isolated loop** (repeatable across runs). But the shipped `getF32` -- which reads `this._le` -- already matches a hand-written `DataView` loop every run, so there is no penalty in the method callers actually use, and `laneOf` already beats the `DataView` floor for any hot loop. A split class would roughly double the hot-getter surface (eight types x two byte orders) in a module whose rule is "bytes in a hot body, not instructions," to chase a micro-gain that does not appear in `getF32` and is superseded by `laneOf`. **Not adopted** -- the decision is recorded with its numbers in `decisions/0008-benchmark.md`.

---

## Design decisions worth knowing

- **A non-full-span view is copied, not aliased (BR-07).** An `ArrayBuffer` and a full-span zero-offset view unwrap zero-copy. But a pooled/offset view, or a zero-offset PARTIAL view (`new Uint8Array(buf, 0, 8)`), is copied to its own window. Otherwise a derived or explicit `count` could address bytes past the window the view actually owns. The resolved buffer is therefore always exactly the bytes the caller handed over.
- **A detached buffer fails closed, not with a raw TypeError (BR-08, BR-09).** A transferred-away `ArrayBuffer` still passes `instanceof ArrayBuffer` yet blows up at `new DataView`. It is refused with a coded `R_BAD_SOURCE` first. Detection uses `ArrayBuffer.prototype.detached` on Node 21+ and a guarded `DataView` construction on the `node>=18` floor; a legitimately zero-length buffer is never misclassified. A `DataView` source needs extra care -- its `byteOffset`/`byteLength` getters THROW on a detached buffer (a `TypedArray`'s return 0) -- so the view branch probes the underlying buffer for detachment before reading any of the view's own getters.
- **`null` is not zero.** `byteOffset` is checked with an explicit `=== undefined`, never `|| 0`, so a `NaN`, `false`, or fractional offset reaches the integer guard and throws `R_BAD_OFFSET` instead of silently reading at offset 0.
- **The read path is unchecked, on purpose.** All validation and all allocation happen at the construction door. `row` and `fieldId` are trusted in the hot getters, one method per type, so a read is monomorphic and branch-free. Correctness is bought once, at construction, not re-paid every read.
- **The cursor is the only mutable state, and only `seek` moves it.** The row cursor makes sequential scans ergonomic without giving up the zero-allocation, unchecked-read contract: `seek` sets one field and returns `this`, the cursor reads inline the same address arithmetic as `getX`, and the stateless row-passing API is untouched and remains the recommended form for random access.
- **`readRow`'s door protects the zero-alloc claim, not the caller.** The one per-call check `readRow` makes -- that the sink has a numeric `length` at least `fieldCount` -- exists because a short `Array` would silently auto-grow and allocate. It is justified where a per-read bounds check on `getX` is not, because it guards the property the method advertises.
- **Variable-length adds a pointer, not a code.** A variable-length field is an ordinary numeric field plus a `lengthField` naming the sibling that carries its run length. The length is resolved cold at construction into a per-field table; every failure reuses an existing coded door (`R_UNKNOWN_FIELD`, `R_BAD_LENGTH`, `R_BUFFER_TOO_SMALL`). The `R_*` union stays at exactly ten and the type table at exactly eight -- both gated by the drift test.
- **The typed-lane fast path is opt-in, and declines rather than lies.** `laneOf` is a second read path (a raw typed-array lane) offered ALONGSIDE `getX`, never woven into it -- no per-read eligibility branch taxes the pinned getters. Eligibility (host-endian, naturally aligned, stride a multiple of the width) is computed cold, and an ineligible field returns `null` instead of a lane that would read wrong bytes, so it is a strict speed option and never a fidelity risk. A differential gate proves every eligible lane read is byte-identical to `getX` across the alignment-by-endianness-by-type matrix, and a controls run mutates a lane's stride to prove that gate has teeth.
- **The sibling type table is shared, not re-declared.** `T_F32`..`T_U8` are byte-for-byte `lite-bake`'s table, so a `lite-bake` schema needs no translation. LBK1's colliding `lane_kind` table is translated explicitly in `fromLBK1Shard`, so a single ambiguous integer never crosses the boundary silently.
- **The shipped `.d.ts` is gated against drift.** `Reader.d.ts` is hand-written, but `test/dts-drift.test.js` reads the text of the source, the types, and `package.json` and fails if the `R_*` code union, the export set, or the version drift apart -- with mutation controls proving the gate has teeth.

---

## Demos

Five demos live in `demo/` (repo-only -- not in the npm tarball):

```bash
npm run demo             # standalone (node): a foreign big-endian wire packet with an
                         # UNALIGNED f32, read zero-GC; the laneOf fast path; and a 64-bit
                         # event record read via getU64/getI64 + a variable-length bytes() span
npm run demo:compound    # ecosystem pipeline (node): lite-bake bakes a parent + children
                         # table -> one reader per table via fromBaked -> zero-alloc join by
                         # key (seek + readRow) -> lite-query streamQuery decodes reactively
npm run demo:webgl       # WebGL hand-off (node): laneOf proves an interleaved buffer is
                         # uploadable and prints the exact gl.vertexAttribPointer args
npm run demo:scope       # browser: serves the repo; open the printed URL, then:
                         #   /demo/           -- oscilloscope: a live i16 capture buffer
                         #   /demo/visuals.html -- byte-grid layouts + a live WebGL upload
```

- **Standalone** shows the reason this package exists: it reads bytes a typed-array lane and `lite-bake` cannot address (an unaligned offset, big-endian order) allocating nothing per read, then exercises the two documented allocation exceptions -- `getU64`/`getI64` (a `bigint`) and the borrowed-view `bytes(row, id)` span.
- **Compound** is the real query-builder scenario -- `bake -> read -> reactive stream`, end to end, with the reader importing no sibling (`lite-bake` and `lite-query` are demo-only `file:` devDependencies). The parent/child join is zero-alloc (`seek` + `readRow` into one reused sink), kept structurally separate from the cold string-building print.
- **WebGL hand-off** (`demo/webgl-handoff.mjs`) is the zero-copy story: `laneOf()` proves an interleaved vertex buffer is host-endian and aligned, then hands you `byteStride = elemStride * width`, `byteOffset = elemOffset * width` -- the exact `gl.vertexAttribPointer` args to upload `reader.buffer` as-is (0 copies, 0 unpack loops). It declines honestly where GL has no attribute type (`f64`/`i64`/`u64`) or the buffer is opposite-endian.
- **Oscilloscope** (`demo/index.html`) packs three `i16` channels into an `ArrayBuffer` each frame like an ADC capture and decodes them into live scope traces -- the render loop reads through `laneOf()` (a raw `Int16Array` view, zero `DataView` calls per sample). A toggle switches the source to big-endian "wire" order, where `laneOf` declines and the reader byte-swaps through `getI16` instead.
- **Layout visuals** (`demo/visuals.html`) render byte grids from the reader's *live* `offsetOf`/`typeOf`/`stride` (never hand-drawn): the interleaved VBO with each field span colored and a live WebGL triangle drawn from the same buffer, and the unaligned big-endian record with an endianness-reinterpret toggle plus the padding reframe (a tight unaligned layout vs the 4-aligned padding a typed-array lane would require).

---

## Testing

**101 deterministic tests, all pass**, plus a torture gate that proves leak-freedom (now including a schema-space fuzzer) and a controls run that proves the door.

```bash
npm test                 # 101 node:test cases (contract + boundary + drift guard + cooperation proof + streaming adapter + hardening gates)
npm run torture          # @zakkster/lite-leak + lite-gc-profiler: 0 B/op, prints "ok"
npm run torture:controls # the door + coherence controls (every gate can fail)
npm run verify           # test + torture + controls, the publish gate
npm run bench            # reproducible benchmark (see Performance) -- repo-only, needs --expose-gc
```

The suites cover: read fidelity across every type code and both endiannesses; the full fail-closed construction door (every `R_*` path, including detached-buffer BR-08/BR-09, the unaligned-offset read, the derived-vs-explicit stride and count, and the partial-view copy BR-07); the `bytes()` escape hatch and its bounds; the sibling constructors against malformed input; the cursor, `readRow`, and variable-length surfaces (cursor-vs-`getX` parity, the `readRow` door and its reentrancy, and variable-length spans at nonzero-base and partial-view sources); the typed-lane fast path (`laneOf` eligibility and its decline contract on unaligned, odd-stride, opposite-endian, and out-of-range fields, plus lane-vs-`getX` parity including a BR-07 partial-window source); and the `.d.ts` drift guard (code-union, export, and version parity, with mutation controls). The torture harness runs read-fidelity, degenerate-layout, an adversarial source-x-count-x-offset door matrix asserting throws-iff-incoherent across every source kind (including detached and `DataView`), a cursor-vs-`getX` differential, a lane-vs-`getX` differential across the alignment-x-endianness-x-type matrix (with a stride-mutation control for teeth), per-surface zero-alloc and retained-alloc gates, and a soak witness. `LBR_TORTURE_BREAK=1` injects a retained allocation to prove the gate can fail; no gate output is a FAIL. The cooperation proof (0.5.0) adds node:test suites that read the siblings' REAL output -- `fromBaked` cell-for-cell vs `@zakkster/lite-bake`'s own Reader over mock fixtures spanning all 8 lanes plus NaN/+/-Infinity/-0, `fromLBK1Shard` vs `@zakkster/lite-bake-stream` (F64 bit-exact, U32 as a string-table index, a no-translate control asserted to diverge), a same-schema shard union, a parent/children multi-reader join, and an assertion that `Reader.js` imports no sibling (the siblings are test-only devDependencies). The streaming adapter (0.6.0) adds a peer-surface guard and a `streamQuery` suite: a FOREIGN feed decoded per window through `LiteBinaryReader` and observed in order, abort-on-detach that cancels the in-flight source (no value after abort), reactive-key restart, a `fromLBK1Shard` shard read inside the stream (F64 bit-exact vs bake-stream's own Reader), the structural zero-alloc frame path, and the D9 copy-what-you-keep ownership boundary -- with lite-query a test-only devDependency and no import edge. The 0.6.1 hardening pass adds a torture t8 schema-space fuzzer (thousands of RANDOM legal schemas -- random lane subsets, orders, unaligned offsets, strides, LE/BE -- read cell-for-cell against a `DataView` oracle with a seed-replayable teeth control), a `bytes()` negative gate (it mints a fresh view per call, so it stays a cold-path allocator and can never be quietly folded into the zero-GC hot path), and a README-code subset gate (every `R_*` the docs name is one the reader actually throws). The 0.7.0 pass extends this: the t8 fuzzer now also fills a `readRow` sink at a random row per schema and asserts every cell `Object.is`-equal to the oracle across BOTH an `Array` and a `Float64Array` sink (so `readRow` inherits the same NaN/-0 fidelity `getX` had), a focused unit test pins `readRow` and the cursor bit-exact for the IEEE 754 edge values (`NaN`, `-0`, `+/-Infinity`), and a post-construction-detach test proves that transferring an `ArrayBuffer` away after a reader is built makes a subsequent read throw a CATCHABLE error (no native crash, no silent poison) -- the complement to the construction-time `BR-08`/`BR-09` doors. The 1.1.0 pass (S9, 64-bit lanes) extends every one of these: the harness oracle and the t8 fuzzer now draw lanes 8/9, so 64-bit reads are checked `Object.is`-equal to a `DataView` `getBigInt64`/`getBigUint64` oracle across LE/BE at the signed/unsigned boundaries (`0n`, `-1n`, `INT64_MIN`, `INT64_MAX`, `UINT64_MAX`); a focused unit suite pins `getI64`/`getU64`/`get`/`val`/`readRow`/`laneOf` fidelity, the `readRow` sink edge (a `Float64Array` sink throws on a BigInt cell; `Array` and `BigInt64Array` sinks succeed), and the moved type boundary (code 10 -> `R_BAD_TYPE`, 8/9 construct); and a new torture gate PROVES the 64-bit surface allocates (retained heap far past a 100 KB floor and strictly above the identical-shape primitive loop) while the eight primitive lanes' 0-B/op gates are unchanged -- a positive allocation assertion, not a hand-wave.

---

## What this is not

- **Not a schema/IDL parser.** It reads a layout YOU describe (offsets and types). It does not parse a `.proto`, a FlatBuffers schema, or a self-describing header. `lite-bake-stream` owns the self-describing LBK1 container.
- **Not a writer or an encoder.** It only reads. `@zakkster/lite-bake` bakes a column store; `@zakkster/lite-bake-stream` frames a stream. This reads their output and any other bytes.
- **Not a string decoder.** Reads return numbers (or a `bigint` for a 64-bit lane). A string field is a raw byte span -- use `bytes()` to borrow it and decode it yourself (or resolve a `lite-bake-stream` string index in that package).
- **Not zero-GC on the 64-bit lanes.** `T_I64`/`T_U64` return a `bigint`, a heap value, so `getI64`/`getU64` allocate one BigInt per read -- the second documented exception alongside `bytes()`. This is a JS-language reality (no reader returns a 64-bit *value* without allocating), not a design miss; the zero-GC guarantee is exact on the 8 primitive-number lanes. If you need a zero-alloc 64-bit hot loop, read the two halves as `getU32` pairs yourself.
- **Not a bounds-checked read on the hot path.** `row`/`fieldId` are trusted in the getters by design; the bounds are proven once at the door. Pass an out-of-range `row` and you get whatever `DataView` does, not a coded error. Keep `row` in `[0, count)`.
- **Not a variable-length *record* reader.** The record model is fixed `stride`. A variable-length *field* within a fixed-stride record is supported -- mark it with a `lengthField` and read the span with `bytes(row, id)` -- but a record whose total size varies row to row is out of scope; walk it with your own cursor over `bytes()` spans.
- **Not a mutation API.** It is a reader. There is no `setX`. Write with the sibling writers, or your own `DataView`.
- **Not a concurrency primitive.** It reads over a `SharedArrayBuffer` like any `DataView`, but it provides no atomics and no synchronization -- cross-worker reads while another thread writes are the caller's to coordinate (with `Atomics` on your own SAB). It does not imply thread-safety it does not test.

---

## Ecosystem

Part of the **@zakkster** zero-GC stack:

- [`lite-bake`](https://www.npmjs.com/package/@zakkster/lite-bake) -- bakes an in-memory column store; its baked output reads here via `fromBaked`
- [`lite-bake-stream`](https://www.npmjs.com/package/@zakkster/lite-bake-stream) -- frames a self-describing LBK1 container; one shard reads here via `fromLBK1Shard`
- [`lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal) -- zero-GC reactive graph for hot paths
- **`lite-binary-reader`** -- this package

---

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
