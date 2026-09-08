# 0001 -- structure: a DataView reader over a caller-supplied offsets/type table

Status: accepted (v0.1.0). Context: the suite already has `lite-bake` (in-memory
`{buffer,stride,count,schema}`, native-endian, 8 lanes) and `lite-bake-stream`
(self-describing `LBK1` container, F64/U32 lanes, its own magic). Neither reads
**arbitrary or foreign** bytes against a table the caller supplies. That is this
module's one job.

## The decisions

**D1 -- the gap defines the module.** `lite-binary-reader` reads RAW bytes (a wire
protocol, a mmap'd C struct, WASM linear memory, an SoA column dump, a foreign
record layout) against `schema = [{name, type, offset}]` + `stride`. It does not
own a file format and it does not compete with the bakers -- it reads what they
cannot: bytes with no self-description and no shared magic. Confirmed by research:
"there is no API interop in either direction" and arbitrary shapes are opaque
blobs to both siblings.

**D2 -- DataView is the primary read path, not typed-array lanes.** A typed-array
lane can only start at an offset that is a multiple of its element size
(`new Float64Array(buf, 1)` THROWS -- Learning/TypedArrays.md gotcha #6). Foreign
and packed layouts routinely put fields at odd offsets. `DataView.getX(pos, le)`
has no alignment constraint, so it reads a field at ANY byte offset. This is the
capability that makes the module possible, not a convenience. (An optional
native-endian typed-lane fast path is a roadmap item, S3 -- valid only when a
field happens to be aligned AND host-endian.)

**D3 -- type codes are lite-bake's `Types`, LBK1 is translated.** Our codes are
byte-for-byte lite-bake's table (F32=0, F64=1, I32=2, I16=3, I8=4, U32=5, U16=6,
U8=7), so a lite-bake `schema` drops in unchanged. LBK1's `lane_kind` is a
DIFFERENT table that collides by value -- only F64==1 is shared (LBK1 U32=3 vs our
U32=5). A single integer is therefore ambiguous across formats, so
`fromLBK1Shard` TRANSLATES `lane_kind` at the boundary; an ambiguous code never
crosses.

**D4 -- endianness is explicit; default little-endian.** This is the portability
hole both siblings leave unowned (lite-bake is native-endian with no marker). A
raw/foreign reader must not assume host order, so every read takes `_le` and the
caller sets it. `fromBaked` sets it to the HOST order (that is what lite-bake
wrote); `fromLBK1Shard` sets little-endian (LBK1 spec). Default is little-endian,
the sane wire default.

**D5 -- schema compiled to SoA tables; fields addressed by integer id.** The
schema becomes an `Int32Array` of byte offsets + a `Uint8Array` of type codes + a
name->id `Map` used only at setup. In the hot loop you index by the id
(resolve the name ONCE with `field(name)`), the ecosystem's `get(index, field)`
shape. SoA + integer ids = cache-friendly, GC-invisible, monomorphic.

**D6 -- one read method per type, plus a generic dispatch.** `getF64/getF32/.../
getU8` keep each call site monomorphic and branch-free (Learning/V8.md) -- the
tight-loop path. `get(row, id)` switches on the stored type code for data-driven
walks and tooling. Both are zero-alloc.

**D7 -- input coercion mirrors the siblings.** `ArrayBuffer` used as-is
(zero-copy); a FULL-SPAN typed view unwraps to its buffer (zero-copy); a
pooled/offset view (nonzero `byteOffset`) is COPIED so we never read outside its
window; anything else fails closed. Identical rule to lite-bake's
`Reader.fromBytes` / `Views.js`.

**D8 -- fail closed at the door, unchecked on the hot path.** Every incoherent
input throws a coded `R_*` error at construction (bad source/schema/type/offset/
stride/count, buffer too small, unknown field). The read methods are UNCHECKED for
zero cost, with a stated contract (`row` in `[0,count)`, `id` valid) -- the same
choice lite-bake makes for its lanes. Validation is cold; reads are hot.

**D9 -- borrowed bytes: "copy what you keep".** `bytes(row, id, len)` returns a
zero-copy `Uint8Array` VIEW aliasing the buffer -- valid until the buffer changes.
The caller copies what it retains. This matches lite-query's pooled-record and
bake-stream's `bytesAt` contracts. (It allocates one small view wrapper, so it is
not for the frame hot path -- numeric reads are.)

**D10 -- cooperation is import-free.** lite-query has no decode hook (its
`transform` was deliberately removed; derived views are the caller's `computed()`
job), so cooperation happens INSIDE the caller's `streamQuery` `stream:` generator
or a `query` `fetcher`. `lite-binary-reader` is therefore an OPTIONAL peer with
ZERO import edges in either direction -- the same no-coupling rule bake-stream and
lite-studio follow with lite-query.

## Consequences

- Reads any layout at any offset with any byte order -> the raw/foreign niche.
- A lite-bake buffer (`fromBaked`) and a carved LBK1 shard (`fromLBK1Shard`) both
  read through the same core -> cooperation without coupling.
- The one thing it does NOT do (v0.1.0): resolve LBK1 U32 string indices to
  strings (that needs the shard's string table -- bake-stream's job), variable-
  length/nested fields (S3), and a native-endian typed-lane fast path (S3).
