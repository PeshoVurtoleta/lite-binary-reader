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

import { LiteBinaryReader, T_U8, T_F32, T_U16, IS_LITTLE_ENDIAN } from "../Reader.js";

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

line("");
line("Nothing above allocated per read: one reader owns the DataView + schema tables,");
line("field ids are resolved once, and every getX/lane read returns a primitive.");
