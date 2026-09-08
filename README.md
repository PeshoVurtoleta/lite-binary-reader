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
  - [The bytes escape hatch](#the-bytes-escape-hatch)
  - [Sibling cooperation](#sibling-cooperation)
  - [Type codes](#type-codes)
  - [Error codes](#error-codes)
- [Composability with the ecosystem](#composability-with-the-ecosystem)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

---

## Why this exists

Reading foreign binary in JavaScript has two problems no small library solves at once:

1. **Unaligned fields and foreign endianness.** A typed-array lane (`new Float32Array(buf, off)`) throws on a misaligned view and only ever reads host byte order. Real wire formats and C structs pack fields at whatever offset is convenient and choose their own endianness. A `DataView` reads any type at any offset with an explicit `littleEndian` flag -- so this reader can address a field at offset 2, and read a big-endian buffer on a little-endian host. `lite-bake`, native-endian by construction, cannot.

2. **A hot read loop that does not allocate.** Materializing a `{ id, temp, status }` object per record, per frame, hands the GC a bag of short-lived garbage -- and the pauses land as visible jitter in a preview or a scrub. This reader materializes nothing: a read is one `DataView.getX(base + row*stride + off, le)` returning a number. One reader owns the `DataView` and the compacted schema tables; every read after construction allocates zero.

Existing options: hand-rolled `DataView` offset arithmetic (correct, but you re-derive stride and re-check bounds by hand at every call site, and a typo reads past the buffer silently), a typed-array view per field (throws on unaligned offsets, host-endian only), or a full schema/parser library (heavyweight, allocates a parsed object graph). This reader is the API for exactly this job: a described layout, read in place.

---

## What you get

- **`new LiteBinaryReader(source, options)`** -- the reader. `source` is an `ArrayBuffer` or any view (`TypedArray` or `DataView`); `options` is the `{ schema, stride?, count?, littleEndian?, byteOffset? }` layout. The constructor validates and compacts the schema into SoA tables, resolves the owned buffer, and freezes the shape. Build it once per `(source, layout)`; reuse it across the read loop.
  - **`getF64`..`getU8`(row, fieldId)** -- eight typed reads, one per type code. Each call site is monomorphic and branch-free: `reader.getF32(i, x)` pays no type switch.
  - **`get(row, fieldId)`** -- the generic read; dispatches on the field's stored type code (one branch). Reach for it when the type is data-driven (a mixed-schema walk, tooling, debug); reach for a typed `getX` in a tight loop.
  - **`bytes(row, fieldId, len)`** -- a borrowed `Uint8Array` view over `len` raw bytes: the escape hatch for a blob or variable-length field. Copy what you keep.
  - **`field` / `typeOf` / `offsetOf`** -- name-to-id resolution and per-field introspection.
- **`LiteBinaryReader.fromBaked(baked, options?)`** and **`fromLBK1Shard(shard, options?)`** -- two cold constructors that read a sibling's output directly (see [Sibling cooperation](#sibling-cooperation)).
- **Type-code constants** -- `T_F32`..`T_U8` (0..7), byte-for-byte `lite-bake`'s table, plus `IS_LITTLE_ENDIAN` and `VERSION`.
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
get(row, fieldId): number      // generic; dispatches on the stored type code
```

`row` is in `[0, count)` and `fieldId` is a valid id -- **unchecked for speed**. Validation lives at the door, not per read. One method per type keeps each call site monomorphic; use a typed `getX` in a tight loop and `get` only when the type is data-driven. Every one of these allocates **nothing**.

### The bytes escape hatch

```ts
bytes(row: number, fieldId: number, len: number): Uint8Array
```

A zero-copy `Uint8Array` view over `len` raw bytes at a field position -- for a blob, a variable-length field, or a foreign sub-record. The view **aliases the buffer**: it is borrowed, valid until the buffer changes. Copy what you keep. This allocates one small view wrapper (it is the one non-zero-GC method) -- do not call it on the frame hot path. A bad `len` throws `R_BAD_LENGTH`; a span past the buffer throws `R_BUFFER_TOO_SMALL` (never a raw `RangeError` without a `.code`).

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

Byte-for-byte `@zakkster/lite-bake`'s `Types` table, so a `lite-bake` schema drops into this reader unchanged. `IS_LITTLE_ENDIAN` (the host byte order, detected once) and `VERSION` (`'0.2.0'`) are also exported.

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

---

## Zero-GC design notes

<details>
<summary>What the read path allocates (nothing), and how it stays that way.</summary>

One `LiteBinaryReader` does all its allocation in the constructor: it compacts the schema into two SoA typed arrays (an `Int32Array` of offsets, a `Uint8Array` of type codes) and a name-to-id `Map`, resolves the owned buffer, and constructs the single `DataView`. Every field of the instance is set once, in a fixed order, so all readers share one hidden class. After construction, a read is pure address arithmetic and one `DataView.getX` -- it touches only the pre-allocated tables and the caller's buffer.

| Operation | Steady-state allocations |
| --------- | ------------------------ |
| `getF64`..`getU8`  | **0** |
| `get` (generic)    | **0** |
| `field` / `typeOf` / `offsetOf` | **0** |
| `bytes(row, field, len)` | one `Uint8Array` view wrapper (documented; not for the frame hot path) |
| constructor        | once, per `(source, layout)` -- SoA tables + `DataView`; a non-full-span view also copies to an owned window |

The one cold branch is the throw path: a coded error is built (and its message concatenated) only when a read is invalid, never in steady state. The torture gate (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`, run under `--expose-gc`) proves **0 B/op** and **0 retained bytes** across the read loop and prints exactly `ok`. A `LBR_TORTURE_BREAK=1` control injects a retained allocation into that same loop and the alloc gate rejects it with a non-zero exit -- a gate that cannot fail is decorative.

</details>

---

## Design decisions worth knowing

- **A non-full-span view is copied, not aliased (BR-07).** An `ArrayBuffer` and a full-span zero-offset view unwrap zero-copy. But a pooled/offset view, or a zero-offset PARTIAL view (`new Uint8Array(buf, 0, 8)`), is copied to its own window. Otherwise a derived or explicit `count` could address bytes past the window the view actually owns. The resolved buffer is therefore always exactly the bytes the caller handed over.
- **A detached buffer fails closed, not with a raw TypeError (BR-08, BR-09).** A transferred-away `ArrayBuffer` still passes `instanceof ArrayBuffer` yet blows up at `new DataView`. It is refused with a coded `R_BAD_SOURCE` first. Detection uses `ArrayBuffer.prototype.detached` on Node 21+ and a guarded `DataView` construction on the `node>=18` floor; a legitimately zero-length buffer is never misclassified. A `DataView` source needs extra care -- its `byteOffset`/`byteLength` getters THROW on a detached buffer (a `TypedArray`'s return 0) -- so the view branch probes the underlying buffer for detachment before reading any of the view's own getters.
- **`null` is not zero.** `byteOffset` is checked with an explicit `=== undefined`, never `|| 0`, so a `NaN`, `false`, or fractional offset reaches the integer guard and throws `R_BAD_OFFSET` instead of silently reading at offset 0.
- **The read path is unchecked, on purpose.** All validation and all allocation happen at the construction door. `row` and `fieldId` are trusted in the hot getters, one method per type, so a read is monomorphic and branch-free. Correctness is bought once, at construction, not re-paid every read.
- **The sibling type table is shared, not re-declared.** `T_F32`..`T_U8` are byte-for-byte `lite-bake`'s table, so a `lite-bake` schema needs no translation. LBK1's colliding `lane_kind` table is translated explicitly in `fromLBK1Shard`, so a single ambiguous integer never crosses the boundary silently.
- **The shipped `.d.ts` is gated against drift.** `Reader.d.ts` is hand-written, but `test/dts-drift.test.js` reads the text of the source, the types, and `package.json` and fails if the `R_*` code union, the export set, or the version drift apart -- with mutation controls proving the gate has teeth.

---

## Testing

**49 deterministic tests, all pass**, plus a torture gate that proves leak-freedom and a controls run that proves the door.

```bash
npm test                 # 49 node:test cases (contract + boundary + drift guard)
npm run torture          # @zakkster/lite-leak + lite-gc-profiler: 0 B/op, prints "ok"
npm run torture:controls # the door + coherence controls (every gate can fail)
npm run verify           # test + torture + controls, the publish gate
```

The suites cover: read fidelity across every type code and both endiannesses; the full fail-closed construction door (every `R_*` path, including detached-buffer BR-08/BR-09, the unaligned-offset read, the derived-vs-explicit stride and count, and the partial-view copy BR-07); the `bytes()` escape hatch and its bounds; the sibling constructors against malformed input; and the `.d.ts` drift guard (code-union, export, and version parity, with mutation controls). The torture harness runs read-fidelity, degenerate-layout, an adversarial source-x-count-x-offset door matrix asserting throws-iff-incoherent across every source kind (including detached and `DataView`), a differential check against reference oracles, and a zero-alloc / retained-alloc / soak witness. `LBR_TORTURE_BREAK=1` injects a retained allocation to prove the gate can fail; no gate output is a FAIL.

---

## What this is not

- **Not a schema/IDL parser.** It reads a layout YOU describe (offsets and types). It does not parse a `.proto`, a FlatBuffers schema, or a self-describing header. `lite-bake-stream` owns the self-describing LBK1 container.
- **Not a writer or an encoder.** It only reads. `@zakkster/lite-bake` bakes a column store; `@zakkster/lite-bake-stream` frames a stream. This reads their output and any other bytes.
- **Not a string decoder.** Reads return numbers. A string field is a raw byte span -- use `bytes()` to borrow it and decode it yourself (or resolve a `lite-bake-stream` string index in that package).
- **Not a bounds-checked read on the hot path.** `row`/`fieldId` are trusted in the getters by design; the bounds are proven once at the door. Pass an out-of-range `row` and you get whatever `DataView` does, not a coded error. Keep `row` in `[0, count)`.
- **Not a variable-length record reader.** The model is fixed `stride`. A variable-length or nested record is out of scope for the hot path; reach into it with `bytes()` and parse the span yourself.
- **Not a mutation API.** It is a reader. There is no `setX`. Write with the sibling writers, or your own `DataView`.

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
