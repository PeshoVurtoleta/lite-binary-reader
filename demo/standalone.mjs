// @zakkster/lite-binary-reader -- standalone demo.
//
//   node demo/standalone.mjs   (or: npm run demo)
//
// The headline: this reads bytes NOBODY ELSE in the suite can touch -- a foreign
// wire packet at an UNALIGNED offset in BIG-ENDIAN order (two things a typed-array
// lane and lite-bake cannot address) -- and it reads them allocating nothing. Then
// it shows the `laneOf` fast path for the host-endian aligned column case.
//
// Repo-only demo; not shipped in the npm tarball.

import { LiteBinaryReader, T_U8, T_F32, T_U16, T_U64, T_I64, IS_LITTLE_ENDIAN } from "../Reader.js";

const line = (s) => process.stdout.write(s + "\n");

// ---------------------------------------------------------------------------
// 1. A FOREIGN wire packet: big-endian, with an UNALIGNED f32.
// ---------------------------------------------------------------------------
// Record layout (stride 8), as some sensor/protocol laid it out on the wire:
//   u8  kind   @0
//   f32 value  @1   <- UNALIGNED (offset 1 is not a multiple of 4)
//   u16 seq    @5
// Big-endian byte order. A Float32Array cannot start at byte 1, and lite-bake
// would never emit this layout -- but a DataView reads it, and so do we.
line("== 1. foreign big-endian wire packet (unaligned f32 @1) ==");

const STRIDE = 8;
const ROWS = 4;
const buf = new ArrayBuffer(STRIDE * ROWS);
const dv = new DataView(buf);
const samples = [
    { kind: 1, value: 3.5, seq: 1000 },
    { kind: 2, value: -12.25, seq: 1001 },
    { kind: 1, value: 0.125, seq: 1002 },
    { kind: 7, value: 99.5, seq: 1003 },
];
for (let i = 0; i < ROWS; i++) {
    const base = i * STRIDE;
    dv.setUint8(base + 0, samples[i].kind);
    dv.setFloat32(base + 1, samples[i].value, false); // false = BIG-endian, at odd offset 1
    dv.setUint16(base + 5, samples[i].seq, false);
}

const wire = new LiteBinaryReader(buf, {
    schema: [
        { name: "kind", type: T_U8, offset: 0 },
        { name: "value", type: T_F32, offset: 1 },   // unaligned
        { name: "seq", type: T_U16, offset: 5 },
    ],
    stride: STRIDE,
    littleEndian: false,                             // big-endian wire; the reader byte-swaps for you
});

// Resolve field ids ONCE, outside the loop -- then every read is zero-allocation.
const KIND = wire.field("kind");
const VALUE = wire.field("value");
const SEQ = wire.field("seq");

for (let r = 0; r < wire.count; r++) {
    line(`  row ${r}: kind=${wire.getU8(r, KIND)} value=${wire.getF32(r, VALUE)} seq=${wire.getU16(r, SEQ)}`);
}
line(`  (host is ${IS_LITTLE_ENDIAN ? "little" : "big"}-endian; the reader byte-swapped every f32/u16 for you)`);

// ---------------------------------------------------------------------------
// 2. The laneOf fast path: host-endian + aligned -> raw typed-array reads.
// ---------------------------------------------------------------------------
// A host-endian, naturally-aligned SoA buffer (two f32 columns). laneOf hands back
// a real Float32Array view + pre-shifted strides, so the hot loop is a plain
// typed-array index -- no DataView call, no branch, zero allocation.
line("");
line("== 2. laneOf fast path (host-endian, aligned) ==");

const N = 5;
const soa = new Float32Array(N * 2);
for (let i = 0; i < N; i++) { soa[i * 2] = i * 1.5; soa[i * 2 + 1] = i * i; }
const soaReader = new LiteBinaryReader(soa.buffer, {
    schema: [{ name: "x", type: T_F32, offset: 0 }, { name: "y", type: T_F32, offset: 4 }],
    stride: 8,
    littleEndian: IS_LITTLE_ENDIAN,                  // host order -> lane-eligible
});

const xLane = soaReader.laneOf(soaReader.field("x"));
if (xLane) {
    let sum = 0;
    for (let r = 0; r < soaReader.count; r++) sum += xLane.view[r * xLane.elemStride + xLane.elemOffset];
    line(`  laneOf('x') -> a ${xLane.view.constructor.name} view; sum of x = ${sum} (read with ZERO DataView calls)`);
} else {
    line("  laneOf declined (not host-endian/aligned) -- getX would serve instead");
}

// The unaligned/BE reader from section 1 correctly DECLINES a lane:
const declined = wire.laneOf(VALUE);
line(`  wire.laneOf('value') -> ${declined} (unaligned + big-endian: laneOf declines, getX still serves it)`);

// ---------------------------------------------------------------------------
// 3. An event-log record: 64-bit ids/deltas + a variable-length tag blob.
// ---------------------------------------------------------------------------
// One record layout (stride 24), the kind of thing a binary log or IPC frame uses:
//   u64 id      @0    monotonic id -- routinely past 2^53, so it CANNOT be a JS number
//   i64 deltaNs @8    signed 64-bit time delta
//   u8  len     @16   length of the tag that follows
//   u8  tag     @17   variable-length ASCII tag (lengthField: "len")
// This exercises the two SHIPPED escape hatches from the zero-GC number path:
// getU64/getI64 (return a bigint) and the 2-arg bytes(row, id) (a borrowed view).
line("");
line("== 3. 64-bit fields + a variable-length tag (getU64 / getI64 / bytes) ==");

const E_STRIDE = 24;
const events = [
    { id: 2n ** 63n + 5n, deltaNs: -1500n, tag: "boot" },
    { id: 2n ** 63n + 6n, deltaNs: 42n, tag: "tick" },
    { id: 2n ** 63n + 7n, deltaNs: 9007199254740993n, tag: "reset" }, // > 2^53: needs BigInt
];
const ebuf = new ArrayBuffer(E_STRIDE * events.length);
const edv = new DataView(ebuf);
const enc = new TextEncoder();
for (let i = 0; i < events.length; i++) {
    const base = i * E_STRIDE;
    edv.setBigUint64(base + 0, events[i].id, IS_LITTLE_ENDIAN);
    edv.setBigInt64(base + 8, events[i].deltaNs, IS_LITTLE_ENDIAN);
    const tagBytes = enc.encode(events[i].tag);
    edv.setUint8(base + 16, tagBytes.length);
    new Uint8Array(ebuf, base + 17, tagBytes.length).set(tagBytes);
}

const log = new LiteBinaryReader(ebuf, {
    schema: [
        { name: "id", type: T_U64, offset: 0 },
        { name: "deltaNs", type: T_I64, offset: 8 },
        { name: "len", type: T_U8, offset: 16 },
        { name: "tag", type: T_U8, offset: 17, lengthField: "len" }, // variable-length span
    ],
    stride: E_STRIDE,
    littleEndian: IS_LITTLE_ENDIAN,
});

const ID = log.field("id");
const DELTA = log.field("deltaNs");
const TAG = log.field("tag");
const dec = new TextDecoder();

for (let r = 0; r < log.count; r++) {
    const id = log.getU64(r, ID);       // -> a bigint (allocates); note below
    const delta = log.getI64(r, DELTA); // -> a bigint (allocates)
    const span = log.bytes(r, TAG);     // -> a BORROWED Uint8Array view over the tag bytes
    line(`  event ${r}: id=${id} deltaNs=${delta} tag="${dec.decode(span)}" (${span.length}B borrowed)`);
}
line("  note: getU64/getI64 each allocate a BigInt -- a JS BigInt is a heap value by spec.");
line("  This is the SECOND documented allocation exception alongside bytes(); the eight");
line("  primitive-number lanes (getF32..getU8) remain unqualified zero-GC.");
line("  bytes(r, TAG) returns a view that ALIASES the buffer -- copy what you keep.");

line("");
line("Sections 1-2 allocated nothing per read: one reader owns the DataView + schema");
line("tables, field ids are resolved once, and every primitive getX/lane read returns a");
line("number. Section 3's 64-bit reads and bytes() view are the two documented exceptions.");
