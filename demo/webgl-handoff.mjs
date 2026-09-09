// @zakkster/lite-binary-reader -- WebGL hand-off demo (the zero-copy story).
//
//   node demo/webgl-handoff.mjs
//
// The most persuasive use of `laneOf` for a graphics/systems audience: a reader
// over an interleaved vertex buffer is ALREADY a GPU-ready VBO. You upload
// `reader.buffer` as-is -- 0 copies, 0 unpack loops, 0 allocations -- and `laneOf`
// hands you the exact `gl.vertexAttribPointer` arithmetic for every attribute.
//
// What laneOf actually gives you (no hand-waving): a SCALAR per-field lane,
// `{ view, elemStride, elemOffset }`, where the reads are host-endian and aligned.
// It PROVES the buffer is uploadable (right endianness + alignment) and yields:
//     byteStride = elemStride * view.BYTES_PER_ELEMENT   (== the record stride)
//     byteOffset = elemOffset * view.BYTES_PER_ELEMENT   (== the field's byte offset)
// A vecN attribute (position, color, uv) is N CONSECUTIVE scalar fields -- laneOf
// does not carry the components dimension, so this demo composes it explicitly and
// VERIFIES the fields are same-type and contiguous before claiming a `size`.
//
// No GL dependency in Node: this asserts eligibility and PRINTS the exact args a
// real `gl.vertexAttribPointer(index, size, type, normalized, stride, offset)` call
// would take against the uploaded `reader.buffer`. The LIVE upload belongs in the
// browser (see demo/index.html), where a real WebGL context exists.
//
// Repo-only demo; not shipped in the npm tarball. Deterministic: no timers.

import { LiteBinaryReader, T_F32, T_U8, T_U16, T_U64, IS_LITTLE_ENDIAN } from "../Reader.js";

const line = (s) => process.stdout.write(s + "\n");

// The WebGL vertex-attribute type enums, keyed by the typed-array a lane exposes.
// These are the ONLY component types GL accepts -- all 32-bit-or-smaller. There is
// deliberately NO entry for Float64Array / BigInt64Array / BigUint64Array: WebGL has
// no double or 64-bit vertex attribute, so a lane over those cannot feed the GPU.
const GL_TYPE = new Map([
    [Float32Array, { name: "gl.FLOAT", value: 0x1406 }],
    [Int8Array, { name: "gl.BYTE", value: 0x1400 }],
    [Uint8Array, { name: "gl.UNSIGNED_BYTE", value: 0x1401 }],
    [Int16Array, { name: "gl.SHORT", value: 0x1402 }],
    [Uint16Array, { name: "gl.UNSIGNED_SHORT", value: 0x1403 }],
    [Int32Array, { name: "gl.INT", value: 0x1404 }],
    [Uint32Array, { name: "gl.UNSIGNED_INT", value: 0x1405 }],
]);

// Compose a vecN attribute from `size` consecutive scalar fields (names[0..size-1]).
// Returns the exact vertexAttribPointer args, or an honest decline. laneOf proves
// eligibility + gives the arithmetic; we verify same-type + contiguity ourselves,
// because laneOf is scalar and never asserts a components dimension for us.
function attribOf(reader, names, { normalized = false } = {}) {
    const first = reader.field(names[0]);
    const lane = reader.laneOf(first);
    // 1. laneOf's decline contract: opposite-endian or unaligned -> not uploadable as-is.
    if (!lane) return { ok: false, why: "laneOf declined -- opposite-endian buffer or an unaligned field/stride; the bytes need a repack before the GPU can read them" };
    // 2. GL type contract: some eligible lanes (f64 / i64 / u64) have no GL attribute type.
    const glt = GL_TYPE.get(lane.view.constructor);
    if (!glt) return { ok: false, why: `${lane.view.constructor.name} has no WebGL attribute type -- GL vertex attributes are 32-bit max (no double, no 64-bit int)` };
    // 3. vecN contiguity contract: the components must be same-type, tightly packed.
    const width = lane.view.BYTES_PER_ELEMENT;
    const t0 = reader.typeOf(first);
    const off0 = reader.offsetOf(first);
    for (let k = 1; k < names.length; k++) {
        const id = reader.field(names[k]);
        if (reader.typeOf(id) !== t0) return { ok: false, why: `component '${names[k]}' has a different type than '${names[0]}' -- a vecN attribute must be homogeneous` };
        if (reader.offsetOf(id) !== off0 + k * width) return { ok: false, why: `component '${names[k]}' is not contiguous after '${names[k - 1]}' -- upload it as a separate attribute` };
    }
    return {
        ok: true,
        size: names.length,
        type: glt,
        normalized,
        byteStride: lane.elemStride * width, // == record stride
        byteOffset: lane.elemOffset * width, // == byte offset of names[0]
    };
}

function report(label, index, reader, names, opts) {
    const a = attribOf(reader, names, opts);
    if (!a.ok) {
        line(`  [${label}] DECLINED: ${a.why}`);
        return;
    }
    line(`  [${label}] gl.vertexAttribPointer(`);
    line(`      index=${index}, size=${a.size}, type=${a.type.name} (0x${a.type.value.toString(16)}),`);
    line(`      normalized=${a.normalized}, stride=${a.byteStride}, offset=${a.byteOffset})`);
}

// ---------------------------------------------------------------------------
// 1. An interleaved vertex buffer (AoS) -- host-endian, naturally aligned.
// ---------------------------------------------------------------------------
// One vertex (stride 20), the shape a mesh loader or GPU readback hands you:
//   f32 x  @0   f32 y  @4   f32 z  @8      position (vec3)
//   u8  r  @12  u8  g  @13  u8  b  @14  u8 a @15   color (vec4, normalized)
//   u16 u  @16  u16 v  @18                 uv (vec2)
line("== 1. interleaved vertex buffer -> laneOf -> vertexAttribPointer args ==");

const STRIDE = 20;
const VERTS = 3;
const vbuf = new ArrayBuffer(STRIDE * VERTS);
const vdv = new DataView(vbuf);
const mesh = [
    { x: -1, y: -1, z: 0, r: 255, g: 0, b: 0, a: 255, u: 0, v: 0 },
    { x: 1, y: -1, z: 0, r: 0, g: 255, b: 0, a: 255, u: 65535, v: 0 },
    { x: 0, y: 1, z: 0, r: 0, g: 0, b: 255, a: 255, u: 32768, v: 65535 },
];
for (let i = 0; i < VERTS; i++) {
    const b = i * STRIDE;
    vdv.setFloat32(b + 0, mesh[i].x, IS_LITTLE_ENDIAN);
    vdv.setFloat32(b + 4, mesh[i].y, IS_LITTLE_ENDIAN);
    vdv.setFloat32(b + 8, mesh[i].z, IS_LITTLE_ENDIAN);
    vdv.setUint8(b + 12, mesh[i].r);
    vdv.setUint8(b + 13, mesh[i].g);
    vdv.setUint8(b + 14, mesh[i].b);
    vdv.setUint8(b + 15, mesh[i].a);
    vdv.setUint16(b + 16, mesh[i].u, IS_LITTLE_ENDIAN);
    vdv.setUint16(b + 18, mesh[i].v, IS_LITTLE_ENDIAN);
}

const vbo = new LiteBinaryReader(vbuf, {
    schema: [
        { name: "x", type: T_F32, offset: 0 }, { name: "y", type: T_F32, offset: 4 }, { name: "z", type: T_F32, offset: 8 },
        { name: "r", type: T_U8, offset: 12 }, { name: "g", type: T_U8, offset: 13 }, { name: "b", type: T_U8, offset: 14 }, { name: "a", type: T_U8, offset: 15 },
        { name: "u", type: T_U16, offset: 16 }, { name: "v", type: T_U16, offset: 18 },
    ],
    stride: STRIDE,
    littleEndian: IS_LITTLE_ENDIAN,
});

line(`  reader over ${vbo.count} vertices, stride ${vbo.stride}B -- upload reader.buffer (${vbo.buffer.byteLength}B) as-is:`);
report("position", 0, vbo, ["x", "y", "z"]);
report("color", 1, vbo, ["r", "g", "b", "a"], { normalized: true });
report("uv", 2, vbo, ["u", "v"]);
line("  -> 0 copies, 0 unpack loops, 0 allocations: the interleaved buffer IS the VBO.");

// ---------------------------------------------------------------------------
// 2. The decline contract is part of the story (not an error to hide).
// ---------------------------------------------------------------------------
line("");
line("== 2. when the hand-off is NOT free, laneOf/GL say so honestly ==");

// (a) A 64-bit field: lane-eligible by alignment, but GL has no 64-bit attribute.
const idbuf = new ArrayBuffer(8 * 2);
const idr = new LiteBinaryReader(idbuf, {
    schema: [{ name: "id", type: T_U64, offset: 0 }],
    stride: 8,
    littleEndian: IS_LITTLE_ENDIAN,
});
report("u64 id", 0, idr, ["id"]);

// (b) A big-endian buffer: laneOf declines outright -- the bytes need a repack.
const bebuf = new ArrayBuffer(4 * 2);
const ber = new LiteBinaryReader(bebuf, {
    schema: [{ name: "h", type: T_F32, offset: 0 }],
    stride: 4,
    littleEndian: !IS_LITTLE_ENDIAN, // opposite of host -> not uploadable as-is
});
report("BE height", 0, ber, ["h"]);
line("  -> the decline is the useful answer: laneOf never hands back a wrong-endian or");
line("     GPU-incompatible lane, so a passing attribute is a PROOF the upload is valid.");
