# lite-binary-reader Cookbook

Recipes for reading binary with `@zakkster/lite-binary-reader`, beginner to pro.
Every recipe is backed by a passing test in `test/` -- the code here is the shape,
the test is the proof. This file is repo-only (not shipped in the npm tarball).

Conventions used throughout:
- Resolve a field id ONCE with `field(name)` outside any loop, then read by id.
  `getX(row, id)` / `get(row, id)` allocate nothing; `field(name)` is a cold lookup.
- The construction door validates the layout once and throws a coded `R_*`; the
  read hot path trusts it. Fail closed at the door, read fast in the loop.
- ASCII only: `->`, `<=`, `x` (times), "degrees".

---

## R1 (beginner) -- read a raw or foreign buffer

You have an `ArrayBuffer` (or a view) that nothing in the suite wrote: a wire frame,
a memory-mapped struct, WASM linear memory, a GPU readback. Describe its layout and
read it -- at any byte offset, with explicit endianness.

```js
import { LiteBinaryReader } from '@zakkster/lite-binary-reader';

// A 16-byte record: u32 id @0, f32 x @4, f32 y @8, u16 flags @12.
const reader = new LiteBinaryReader(buffer, {
  schema: [
    { name: 'id',    type: 5, offset: 0 },   // T_U32
    { name: 'x',     type: 0, offset: 4 },   // T_F32
    { name: 'y',     type: 0, offset: 8 },   // T_F32
    { name: 'flags', type: 6, offset: 12 },  // T_U16
  ],
  stride: 16,
  littleEndian: false,   // big-endian on the wire; the reader byte-swaps for you
});

const x = reader.field('x');
let sum = 0;
for (let r = 0; r < reader.count; r++) sum += reader.getF32(r, x);
```

The type codes are the exported `T_*` constants (`T_F32=0 .. T_U8=7`). An unaligned
`offset` or a big-endian `littleEndian:false` is handled -- that is the whole point.

Proven by: `test/Reader.test.js` (read fidelity across every type code and both
endiannesses, plus the full fail-closed door).

---

## R2 (beginner) -- read a buffer baked by lite-bake

`@zakkster/lite-bake` compiles in-memory records into a flat baked buffer. Its type
table is byte-for-byte this reader's, so its schema drops in unchanged.

```js
import { bake, Types } from '@zakkster/lite-bake';
import { LiteBinaryReader } from '@zakkster/lite-binary-reader';

// lite-bake's schema-override format is { field: Types.X } (the numeric enum),
// not a string. Omit a field to let lite-bake infer its smallest exact lane.
const baked = bake(records, { schema: { price: Types.F64, qty: Types.U32 } });
// `baked` is lite-bake's { buffer, stride, count, schema } -- fromBaked reads it
// directly, native-endian, no schema rewrite.
const reader = LiteBinaryReader.fromBaked(baked);

const price = reader.field('price');
let total = 0;
for (let r = 0; r < reader.count; r++) total += reader.getF64(r, price);
```

Offsets and stride come from lite-bake's reported layout (it sorts fields by size and
pads the stride) -- `fromBaked` reads them from `baked`, you never compute them.

Proven by: `test/coop-bake.test.js` -- reads lite-bake's REAL output cell-for-cell
against lite-bake's own Reader, across all 8 lanes plus NaN / +/-Infinity / -0.

---

## R3 (intermediate) -- read one carved lite-bake-stream (LBK1) shard

`@zakkster/lite-bake-stream` frames a self-describing LBK1 container. Carve one
shard's raw payload and read it. `fromLBK1Shard` TRANSLATES LBK1's wire lane codes
to this reader's type codes, so a colliding integer never crosses the boundary.

```js
import { serialize } from '@zakkster/lite-bake-stream';
import { Reader as StreamReader } from '@zakkster/lite-bake-stream/reader';
import { LiteBinaryReader } from '@zakkster/lite-binary-reader';

const container = StreamReader.fromBuffer(serialize(records, { /* ... */ }));
const rowStride = container.strideBytes();

const shard = {
  bytes:    container.shardPayload(0),  // the raw shard payload (a DataView)
  rowStride: rowStride,
  fields:    container.schema.fields,   // [{ name, laneKind, offsetInRow }]
};
const reader = LiteBinaryReader.fromLBK1Shard(shard);

const val = reader.field('val');
const value = reader.getF64(0, val);
```

Ownership boundary: an LBK1 **U32 lane is a string-table INDEX, not a value**. This
reader returns the raw index; resolution stays in bake-stream:

```js
const tag = reader.field('tag');
const index = reader.getU32(0, tag);
const str = container.shardStringTable(0).get(index);   // bake-stream resolves it
```

Proven by: `test/coop-lbk1.test.js` -- F64 cells bit-exact vs bake-stream's own
Reader; U32 indices resolve through the shard string table; and a no-translate
control (wire U32=3 read raw as `T_I16`) is asserted to diverge (the D3 collision has
teeth).

---

## R4 (advanced) -- union many same-schema shards into one row space

A multi-shard container is N shards sharing one schema. Map a GLOBAL row index to
`(shard, localRow)` and dispatch to the per-shard reader. Keep this in YOUR code --
it is a thin caller-side helper, not a reader API.

```js
class ShardUnion {
  constructor(readers) {
    this.readers = readers;
    this.rowStarts = [];
    let start = 0;
    for (const r of readers) { this.rowStarts.push(start); start += r.count; }
    this.totalRows = start;
  }
  locate(globalRow) {
    for (let s = this.readers.length - 1; s >= 0; s--) {
      if (globalRow >= this.rowStarts[s]) {
        return { s, localRow: globalRow - this.rowStarts[s] };
      }
    }
    return { s: -1, localRow: -1 };
  }
  get(globalRow, fieldId) {
    const { s, localRow } = this.locate(globalRow);
    return this.readers[s].get(localRow, fieldId);
  }
}

// Build one LiteBinaryReader per shard (all share the schema), then union them.
const readers = [];
for (let s = 0; s < container.shardCount; s++) {
  readers.push(LiteBinaryReader.fromLBK1Shard({
    bytes: container.shardPayload(s),
    rowStride: container.strideBytes(),
    fields: container.schema.fields,
  }));
}
const union = new ShardUnion(readers);
const value = union.get(globalRow, readers[0].field('val'));
```

Proven by: `test/coop-multireader.test.js` -- every global read matches
bake-stream's own reader over its shards (F64 direct, U32 resolved through the
owning shard's string table).

---

## R5 (pro) -- join a query-builder result: a parent table with children

A real DB / query-builder result is often two tables: a PARENT (e.g. orders) and its
CHILDREN (e.g. line items), keyed back to the parent. Bake each table separately, open
one reader per table, and join by key IN YOUR CODE. This is different schemas joined by
key -- join semantics are yours, so it is a recipe, never a shipped API.

```js
import { bake, Types } from '@zakkster/lite-bake';
import { LiteBinaryReader } from '@zakkster/lite-binary-reader';

// Two tables, each baked on its own schema (Types.X overrides pin the lanes).
const pr = LiteBinaryReader.fromBaked(bake(parents,  { schema: { orderId: Types.U32, totalCents: Types.U32 } }));
const cr = LiteBinaryReader.fromBaked(bake(children, { schema: { parentId: Types.U32, sku: Types.U32, qty: Types.U16 } }));

// Resolve ids once.
const P_ORDER = pr.field('orderId');
const C_PARENT = cr.field('parentId');
const C_SKU = cr.field('sku');
const C_QTY = cr.field('qty');

// Index children by their parent key ONCE (a cold, caller-side map).
const byParent = new Map();
for (let c = 0; c < cr.count; c++) {
  const key = cr.get(c, C_PARENT);
  let bucket = byParent.get(key);
  if (!bucket) { bucket = []; byParent.set(key, bucket); }
  bucket.push(c);
}

// Walk parents, gather each order's line items.
for (let p = 0; p < pr.count; p++) {
  const orderId = pr.get(p, P_ORDER);
  const items = (byParent.get(orderId) || []).map((c) => ({
    sku: cr.get(c, C_SKU),
    qty: cr.get(c, C_QTY),
  }));
  // ... emit { orderId, items }
}
```

Each reader stays zero-alloc in its own loop; the only allocation is the caller-side
join index, built once. Scale the same pattern to N tables (grandchildren, lookup
tables) -- one reader per table, joined by key.

Proven by: `test/coop-join.test.js` -- a parent + child table baked separately, read
through two readers, joined by key, with every cell on both sides asserted cell-exact
against lite-bake's own Reader and every child row reached through the join.

---

## R6 (pro) -- stream a foreign feed into a lite-query `streamQuery`

A remote fixed-stride binary feed that NO baker wrote -- a wire protocol, a sensor
dump, a column-store page -- pulled in windows and decoded zero-GC as each window
arrives. `@zakkster/lite-query`'s `streamQuery` subscribes a cache key to an async
iterable; your `stream:` generator wraps each window in a `LiteBinaryReader` and
yields decoded values. In `latest` mode `data()` is the most recent value, one signal
write per frame, zero allocation.

```js
import { streamQuery } from '@zakkster/lite-query/stream';
import { LiteBinaryReader, T_F64 } from '@zakkster/lite-binary-reader';

const SCHEMA = [{ name: 'v', type: T_F64, offset: 0 }];

const feed = streamQuery(qc, {
  key: ['sensor', channel()],
  mode: 'latest',
  stream: async function* ({ signal }) {
    const source = await openWindows(FEED_URL, { signal }); // your cancellable range/socket source
    // THE ONE CONTRACT: wire the abort signal to cancel the in-flight read. An
    // async generator parked on `await source.next()` cannot be released by
    // streamQuery's iterator.return() until that await settles -- so on
    // abort-on-detach you must cancel the source yourself, or it leaks.
    signal.addEventListener('abort', () => source.cancel());

    const sink = new Float64Array(SCHEMA.length);           // hoisted; reused every frame
    for await (const win of source) {
      if (signal.aborted) return;
      const r = new LiteBinaryReader(win, { schema: SCHEMA, stride: 8, littleEndian: true }); // cold per window
      const v = r.field('v');
      for (let i = 0; i < r.count; i++) {
        if (signal.aborted) return;
        r.readRow(i, sink);        // zero-alloc into the reused sink
        yield sink[0];             // one primitive per frame -- never a fresh record object
      }
    }
  },
});
```

Zero-GC frame path: the reader's per-frame work is `readRow` into a reused sink (0 B/op,
gated by torture t6); the per-window `new LiteBinaryReader(...)` is a COLD allocation
amortized across the window's rows; `streamQuery` latest mode adds one signal write per
frame (its own zero-alloc contract). Yield a PRIMITIVE (or a reused out-param) -- a fresh
`{ ... }` record per row would allocate on the hot path. Ownership: a decoded NUMBER is a
value; a `bytes()` span is borrowed -- copy what you keep before the next window overwrites.

Proven by: `test/coop-query.test.js` -- a real `streamQuery` decodes a foreign feed in
order; detaching the last observer cancels the source (no value after abort); a reactive
key change restarts the feed. lite-query is a test-only devDependency (no import edge).

---

## R7 (pro) -- read a lite-bake-stream shard INSIDE a `streamQuery`

The same seam, but the windows are real `@zakkster/lite-bake-stream` shard payloads and
each is read through `fromLBK1Shard` (R3) -- composing the S5 cooperation proof into a
stream.

```js
import { streamQuery } from '@zakkster/lite-query/stream';
import { Reader as StreamReader } from '@zakkster/lite-bake-stream/reader';
import { LiteBinaryReader } from '@zakkster/lite-binary-reader';

const container = StreamReader.fromBuffer(bytes);
const feed = streamQuery(qc, {
  key: ['lbk1', container.id],
  mode: 'latest',
  stream: async function* ({ signal }) {
    const rowStride = container.strideBytes();
    for (let s = 0; s < container.shardCount; s++) {
      if (signal.aborted) return;
      const lbr = LiteBinaryReader.fromLBK1Shard({
        bytes: container.shardPayload(s),
        rowStride,
        fields: container.schema.fields,
      });
      const val = lbr.field('val');
      for (let row = 0; row < lbr.count; row++) {
        if (signal.aborted) return;
        yield lbr.getF64(row, val);         // F64 cells, bit-exact vs bake-stream's own Reader
      }
    }
  },
});
```

Note the same ownership boundary as R3: an LBK1 U32 lane is a string-table INDEX; string
resolution stays in bake-stream (`container.shardStringTable(s).get(index)`).

Proven by: `test/coop-query.test.js` -- every row streamed through `fromLBK1Shard` is
asserted bit-exact against `container.get(globalRow, 'val')`.

---

## Where the boundaries are (so you do not reach for the wrong tool)

- This reader is READ-ONLY: no write path, no schema mutation. To PRODUCE bytes, use
  `@zakkster/lite-bake` (in-memory) or `@zakkster/lite-bake-stream` (LBK1 container).
- `bytes(row, id[, len])` returns a BORROWED view -- copy what you keep.
- An LBK1 U32 lane is a string-table INDEX; string resolution stays in bake-stream.
- The reader never imports a sibling. `fromBaked` / `fromLBK1Shard` consume a plain
  object you build from the sibling's output; the siblings are test-only devDeps here.
