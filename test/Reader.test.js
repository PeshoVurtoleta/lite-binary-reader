/**
 * @zakkster/lite-binary-reader -- boundary suite (node:test).
 *
 * Pins every semantic and every WORKING door of Reader.js v0.1.0. It does NOT
 * change the reader; S1 makes the good behaviour PINNED and the six findings
 * VISIBLE (the findings ride the torture harness as reproduced-todos, not here).
 *
 * Verified-correct behaviours from ROADMAP section 2 are pinned BY NAME:
 *   P4  unaligned f64 at offset 1 is bit-exact (the D2 headline)
 *   C3  explicit endianness byte-swaps
 *   C4  get(row,id) === getX(row,id) for every type
 *   P12 a pooled/offset view is COPIED; poison outside the window is never read (D7)
 *   C2  R_BUFFER_TOO_SMALL on explicit overflow
 *   C5  R_BAD_STRIDE on stride < maxEnd
 *   P13 R_BAD_OFFSET on a negative byteOffset; C7 on a fractional field offset
 *   P3  R_BAD_COUNT on a fractional count
 *   P9  R_BAD_SCHEMA on missing options / empty schema
 *   P10 R_BAD_SOURCE on a plain array
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LiteBinaryReader, LiteBinaryReaderError, IS_LITTLE_ENDIAN,
  T_F32, T_F64, T_I32, T_I16, T_I8, T_U32, T_U16, T_U8, VERSION,
} from '../Reader.js';

/** Assert `fn` throws a LiteBinaryReaderError carrying exactly `code`. */
function assertCode(fn, code) {
  assert.throws(fn, (e) => e instanceof LiteBinaryReaderError && e.code === code,
    'expected a LiteBinaryReaderError with code ' + code);
}

test('VERSION is the shipped v0.2.0 string', () => {
  assert.equal(VERSION, '0.2.0');
});

test('every getX reads its type bit-exact against a DataView (LE)', () => {
  const schema = [
    { name: 'f64', type: T_F64, offset: 0 },
    { name: 'f32', type: T_F32, offset: 8 },
    { name: 'i32', type: T_I32, offset: 12 },
    { name: 'u32', type: T_U32, offset: 16 },
    { name: 'i16', type: T_I16, offset: 20 },
    { name: 'u16', type: T_U16, offset: 22 },
    { name: 'i8', type: T_I8, offset: 24 },
    { name: 'u8', type: T_U8, offset: 25 },
  ];
  const stride = 26;
  const buf = new ArrayBuffer(stride * 3);
  const dv = new DataView(buf);
  for (let r = 0; r < 3; r++) {
    const b = r * stride;
    dv.setFloat64(b + 0, r * 3.14159 - 1.5, true);
    dv.setFloat32(b + 8, r * 0.5 + 0.25, true);
    dv.setInt32(b + 12, r - 5, true);
    dv.setUint32(b + 16, (r * 1000003) >>> 0, true);
    dv.setInt16(b + 20, r - 300, true);
    dv.setUint16(b + 22, (r * 111) & 0xffff, true);
    dv.setInt8(b + 24, r - 100);
    dv.setUint8(b + 25, r + 7);
  }
  const rd = new LiteBinaryReader(buf, { schema });
  for (let r = 0; r < 3; r++) {
    const b = r * stride;
    assert.equal(rd.getF64(r, 0), dv.getFloat64(b + 0, true));
    assert.equal(rd.getF32(r, 1), dv.getFloat32(b + 8, true));
    assert.equal(rd.getI32(r, 2), dv.getInt32(b + 12, true));
    assert.equal(rd.getU32(r, 3), dv.getUint32(b + 16, true));
    assert.equal(rd.getI16(r, 4), dv.getInt16(b + 20, true));
    assert.equal(rd.getU16(r, 5), dv.getUint16(b + 22, true));
    assert.equal(rd.getI8(r, 6), dv.getInt8(b + 24));
    assert.equal(rd.getU8(r, 7), dv.getUint8(b + 25));
  }
});

test('C4: generic get() equals the typed getX() for every type', () => {
  const schema = [
    { name: 'f64', type: T_F64, offset: 0 },
    { name: 'f32', type: T_F32, offset: 8 },
    { name: 'i32', type: T_I32, offset: 12 },
    { name: 'u32', type: T_U32, offset: 16 },
    { name: 'i16', type: T_I16, offset: 20 },
    { name: 'u16', type: T_U16, offset: 22 },
    { name: 'i8', type: T_I8, offset: 24 },
    { name: 'u8', type: T_U8, offset: 25 },
  ];
  const buf = new ArrayBuffer(26 * 4);
  const dv = new DataView(buf);
  for (let i = 0; i < buf.byteLength; i++) dv.setUint8(i, (i * 37 + 11) & 0xff);
  const rd = new LiteBinaryReader(buf, { schema });
  const getters = [rd.getF64, rd.getF32, rd.getI32, rd.getU32, rd.getI16, rd.getU16, rd.getI8, rd.getU8];
  for (let r = 0; r < rd.count; r++) {
    for (let f = 0; f < schema.length; f++) {
      assert.ok(Object.is(rd.get(r, f), getters[f].call(rd, r, f)), 'get != getX at r=' + r + ' f=' + f);
    }
  }
});

test('P4: an unaligned f64 at byte offset 1 is bit-exact (the D2 headline)', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 1 }]; // stride 9
  const vals = [Math.PI, -0.0, 1e-300, 1e300, Number.MAX_SAFE_INTEGER + 0.5];
  const buf = new ArrayBuffer(9 * vals.length + 8);
  const dv = new DataView(buf);
  for (let i = 0; i < vals.length; i++) dv.setFloat64(i * 9 + 1, vals[i], true);
  const rd = new LiteBinaryReader(buf, { schema });
  for (let i = 0; i < vals.length; i++) {
    assert.ok(Object.is(rd.getF64(i, 0), vals[i]), 'unaligned f64 mismatch at row ' + i);
  }
  // A Float64Array view cannot even be constructed at offset 1 -- the capability.
  assert.throws(() => new Float64Array(buf, 1, 1), RangeError);
});

test('C3: explicit endianness byte-swaps; matching order is exact', () => {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, 0x01020304, true); // LE bytes: 04 03 02 01
  const schema = [{ name: 'u', type: T_U32, offset: 0 }];
  const le = new LiteBinaryReader(buf, { schema, littleEndian: true });
  const be = new LiteBinaryReader(buf, { schema, littleEndian: false });
  assert.equal(le.getU32(0, 0), 0x01020304);
  assert.equal(be.getU32(0, 0), 0x04030201);
  assert.notEqual(le.getU32(0, 0), be.getU32(0, 0));
  assert.equal(le.littleEndian, true);
  assert.equal(be.littleEndian, false);
});

test('default endianness is little-endian (the sane wire default)', () => {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, 0x0a0b0c0d, true);
  const rd = new LiteBinaryReader(buf, { schema: [{ name: 'u', type: T_U32, offset: 0 }] });
  assert.equal(rd.littleEndian, true);
  assert.equal(rd.getU32(0, 0), 0x0a0b0c0d);
});

test('field()/typeOf()/offsetOf() agree with the schema (bijection)', () => {
  const schema = [
    { name: 'alpha', type: T_F64, offset: 0 },
    { name: 'beta', type: T_U16, offset: 8 },
    { name: 'gamma', type: T_I8, offset: 10 },
  ];
  const rd = new LiteBinaryReader(new ArrayBuffer(11 * 5), { schema });
  for (let i = 0; i < schema.length; i++) {
    const id = rd.field(schema[i].name);
    assert.equal(id, i);
    assert.equal(rd.typeOf(id), schema[i].type);
    assert.equal(rd.offsetOf(id), schema[i].offset);
  }
  assert.equal(rd.fieldCount, 3);
});

test('field() throws R_UNKNOWN_FIELD for a name not in the schema', () => {
  const rd = new LiteBinaryReader(new ArrayBuffer(8), { schema: [{ name: 'x', type: T_F64, offset: 0 }] });
  assertCode(() => rd.field('nope'), 'R_UNKNOWN_FIELD');
});

test('stride is derived as the tight pack (maxEnd) when omitted', () => {
  const schema = [
    { name: 'a', type: T_U32, offset: 0 }, // end 4
    { name: 'b', type: T_F64, offset: 4 }, // end 12 -> maxEnd
    { name: 'c', type: T_U8, offset: 12 }, // end 13 -> maxEnd
  ];
  const rd = new LiteBinaryReader(new ArrayBuffer(13 * 10), { schema });
  assert.equal(rd.stride, 13);
  assert.equal(rd.count, 10);
});

test('count is derived from the buffer size when omitted', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }]; // stride 8
  const rd = new LiteBinaryReader(new ArrayBuffer(80), { schema });
  assert.equal(rd.count, 10);
  // A trailing partial record is floored away.
  const rd2 = new LiteBinaryReader(new ArrayBuffer(83), { schema });
  assert.equal(rd2.count, 10);
});

test('an explicit stride larger than maxEnd is honored', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  const rd = new LiteBinaryReader(new ArrayBuffer(16 * 4), { schema, stride: 16 });
  assert.equal(rd.stride, 16);
  assert.equal(rd.count, 4);
});

test('fromBaked reads a lite-bake-shaped buffer at NATIVE endianness', () => {
  const schema = [
    { name: 'a', type: T_F64, offset: 0 },
    { name: 'b', type: T_U32, offset: 8 },
  ];
  const stride = 12, count = 8;
  const buf = new ArrayBuffer(stride * count);
  const dv = new DataView(buf);
  for (let i = 0; i < count; i++) {
    dv.setFloat64(i * stride, i * 1.5 - 2, IS_LITTLE_ENDIAN);
    dv.setUint32(i * stride + 8, (i * 97 + 1) >>> 0, IS_LITTLE_ENDIAN);
  }
  const baked = { buffer: buf, stride, count, schema };
  const rd = LiteBinaryReader.fromBaked(baked);
  assert.equal(rd.littleEndian, IS_LITTLE_ENDIAN);
  assert.equal(rd.count, count);
  for (let i = 0; i < count; i++) {
    assert.ok(Object.is(rd.getF64(i, 0), dv.getFloat64(i * stride, IS_LITTLE_ENDIAN)));
    assert.equal(rd.getU32(i, 1), dv.getUint32(i * stride + 8, IS_LITTLE_ENDIAN));
  }
});

test('fromLBK1Shard translates lane_kind to our type codes (D3) and reads LE', () => {
  const rowStride = 12, count = 6;
  const buf = new ArrayBuffer(rowStride * count);
  const dv = new DataView(buf);
  for (let i = 0; i < count; i++) {
    dv.setFloat64(i * rowStride, i * -0.5 + 3, true);       // LBK1 is LE by spec
    dv.setUint32(i * rowStride + 8, (i * 11 + 2) >>> 0, true); // U32 = string-table index
  }
  const shard = {
    bytes: buf,
    rowStride,
    fields: [
      { name: 'val', laneKind: 1, offsetInRow: 0 }, // 1 -> T_F64
      { name: 'str', laneKind: 3, offsetInRow: 8 }, // 3 -> T_U32
    ],
  };
  const rd = LiteBinaryReader.fromLBK1Shard(shard);
  assert.equal(rd.typeOf(rd.field('val')), T_F64);
  assert.equal(rd.typeOf(rd.field('str')), T_U32); // translated, NOT the raw lane_kind 3 (I16)
  assert.equal(rd.littleEndian, true);
  for (let i = 0; i < count; i++) {
    assert.ok(Object.is(rd.getF64(i, 0), dv.getFloat64(i * rowStride, true)));
    assert.equal(rd.getU32(i, 1), dv.getUint32(i * rowStride + 8, true)); // the raw index number
  }
});

test('fromLBK1Shard rejects an unsupported lane_kind with R_BAD_TYPE', () => {
  const shard = { bytes: new ArrayBuffer(8), rowStride: 8, fields: [{ name: 'x', laneKind: 99, offsetInRow: 0 }] };
  assertCode(() => LiteBinaryReader.fromLBK1Shard(shard), 'R_BAD_TYPE');
});

test('P12/D7: a pooled offset view is COPIED; poison outside the window is never read', () => {
  const pool = new Uint8Array(64);
  pool.fill(0xff); // poison everywhere
  const winStart = 16;
  new DataView(pool.buffer, winStart, 8).setFloat64(0, 98765.4321, true);
  const view = new Uint8Array(pool.buffer, winStart, 8);
  const rd = new LiteBinaryReader(view, { schema: [{ name: 'x', type: T_F64, offset: 0 }] });
  assert.equal(rd.getF64(0, 0), 98765.4321);
  assert.equal(rd.count, 1);
  // The copy is exactly the window length -- there is no poison to reach.
  assert.equal(rd.buffer.byteLength, 8);
  assert.notEqual(rd.buffer, pool.buffer);
});

test('a full-span typed view unwraps to its buffer zero-copy', () => {
  const buf = new ArrayBuffer(16);
  new DataView(buf).setFloat64(0, 42.5, true);
  const view = new Uint8Array(buf); // byteOffset 0, full span
  const rd = new LiteBinaryReader(view, { schema: [{ name: 'x', type: T_F64, offset: 0 }] });
  assert.equal(rd.buffer, buf); // same backing store, no copy
  assert.equal(rd.getF64(0, 0), 42.5);
});

test('BR-07: a zero-offset PARTIAL view is COPIED to its own window; it never reads past it', () => {
  const buf16 = new ArrayBuffer(16);
  const dv = new DataView(buf16);
  dv.setFloat64(0, 111.111, true); // the only bytes the 8-byte view owns
  dv.setFloat64(8, 999.999, true); // POISON beyond the view's window
  const view = new Uint8Array(buf16, 0, 8); // byteOffset 0 but byteLength 8 < 16
  const rd = new LiteBinaryReader(view, { schema: [{ name: 'x', type: T_F64, offset: 0 }] });
  // the resolved buffer is exactly the window, not the full 16-byte backing store
  assert.equal(rd.buffer.byteLength, 8);
  assert.notEqual(rd.buffer, buf16);
  // the in-window row reads correctly
  assert.equal(rd.getF64(0, 0), 111.111);
  // a derived count covers ONLY the window: 8 bytes / 8-byte stride === 1 row
  assert.equal(rd.count, 1);
  // subarray form of a zero-offset partial view is copied identically
  const sub = new Uint8Array(buf16).subarray(0, 8);
  const rd2 = new LiteBinaryReader(sub, { schema: [{ name: 'x', type: T_F64, offset: 0 }] });
  assert.equal(rd2.count, 1);
  assert.equal(rd2.getF64(0, 0), 111.111);
  // an explicit count past the window is refused, never reads the poison
  assertCode(() => new LiteBinaryReader(view, { schema: [{ name: 'x', type: T_F64, offset: 0 }], count: 2 }),
    'R_BUFFER_TOO_SMALL');
});

test('a null / non-object schema field throws a coded R_BAD_SCHEMA (not a raw TypeError)', () => {
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(16), { schema: [null] }), 'R_BAD_SCHEMA');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(16), {
    schema: [{ name: 'x', type: T_F64, offset: 0 }, 42],
  }), 'R_BAD_SCHEMA');
});

test('bytes() returns a borrowed view aliasing the buffer', () => {
  const buf = new ArrayBuffer(16);
  new Uint8Array(buf).set([1, 2, 3, 4, 5, 6, 7, 8], 0);
  const rd = new LiteBinaryReader(buf, { schema: [{ name: 'x', type: T_U8, offset: 0 }], stride: 8 });
  const v = rd.bytes(0, 0, 4);
  assert.ok(v instanceof Uint8Array);
  assert.deepEqual(Array.from(v), [1, 2, 3, 4]);
  assert.equal(v.buffer, rd.buffer); // borrowed, not copied
});

// --- the WORKING doors, pinned by name --------------------------------------

test('C2: R_BUFFER_TOO_SMALL on an explicit count*stride over the buffer', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }]; // stride 8
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, count: 9 }), 'R_BUFFER_TOO_SMALL');
});

test('C5: R_BAD_STRIDE when stride < the largest field end', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }]; // maxEnd 8
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, stride: 4 }), 'R_BAD_STRIDE');
});

test('R_BAD_STRIDE on a non-positive or fractional stride', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, stride: 0 }), 'R_BAD_STRIDE');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, stride: 8.5 }), 'R_BAD_STRIDE');
});

test('P13: R_BAD_OFFSET on a negative byteOffset; C7: on a fractional field offset', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, byteOffset: -1 }), 'R_BAD_OFFSET');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: T_F64, offset: 1.5 }] }), 'R_BAD_OFFSET');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: T_F64, offset: -4 }] }), 'R_BAD_OFFSET');
});

test('P3: R_BAD_COUNT on a fractional (or negative) count', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, count: 2.5 }), 'R_BAD_COUNT');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, count: -1 }), 'R_BAD_COUNT');
});

test('R_BAD_TYPE on an out-of-range integer type code (-1, 8) at the constructor door', () => {
  // This door correctly rejects an out-of-range INTEGER type. It is distinct from
  // BR-02 (a non-integer type like 2.5 or "1" that WRONGLY passes this same
  // check) -- pin the working half of it at its own call site, not only via the
  // fromLBK1Shard translation table's reuse of the same R_BAD_TYPE code.
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: -1, offset: 0 }] }), 'R_BAD_TYPE');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: 8, offset: 0 }] }), 'R_BAD_TYPE');
});

test('P9: R_BAD_SCHEMA on missing options / a non-array or empty schema', () => {
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), undefined), 'R_BAD_SCHEMA');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema: [] }), 'R_BAD_SCHEMA');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema: 'nope' }), 'R_BAD_SCHEMA');
});

test('P10: R_BAD_SOURCE on a plain array (not an ArrayBuffer or view)', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  assertCode(() => new LiteBinaryReader([1, 2, 3], { schema }), 'R_BAD_SOURCE');
  assertCode(() => new LiteBinaryReader(null, { schema }), 'R_BAD_SOURCE');
  assertCode(() => new LiteBinaryReader({}, { schema }), 'R_BAD_SOURCE');
});

test('an ArrayBuffer source is used as-is (zero-copy)', () => {
  const buf = new ArrayBuffer(16);
  const rd = new LiteBinaryReader(buf, { schema: [{ name: 'x', type: T_F64, offset: 0 }] });
  assert.equal(rd.buffer, buf);
});

// --- S2 fail-closed door: the newly-coded doors (BR-01..BR-06) --------------

test('BR-04: R_DUPLICATE_FIELD when two schema fields share a name', () => {
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), {
    schema: [{ name: 'x', type: T_F64, offset: 0 }, { name: 'x', type: T_F64, offset: 8 }],
  }), 'R_DUPLICATE_FIELD');
  // A distinct-named pair with the same shape still constructs (not a false positive).
  const rd = new LiteBinaryReader(new ArrayBuffer(64), {
    schema: [{ name: 'x', type: T_F64, offset: 0 }, { name: 'y', type: T_F64, offset: 8 }],
  });
  assert.equal(rd.fieldCount, 2);
});

test('BR-05: bytes() throws R_BAD_LENGTH on a negative or fractional len', () => {
  const rd = new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: T_U8, offset: 0 }], stride: 8 });
  assertCode(() => rd.bytes(0, 0, -1), 'R_BAD_LENGTH');
  assertCode(() => rd.bytes(0, 0, 1.5), 'R_BAD_LENGTH');
  assertCode(() => rd.bytes(0, 0, NaN), 'R_BAD_LENGTH');
});

test('BR-05: bytes() reading past the buffer throws a coded R_BUFFER_TOO_SMALL', () => {
  const rd = new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: T_U8, offset: 0 }], stride: 8 });
  assertCode(() => rd.bytes(7, 0, 100), 'R_BUFFER_TOO_SMALL');
  // A valid span still returns a borrowed view.
  const v = rd.bytes(0, 0, 4);
  assert.ok(v instanceof Uint8Array);
  assert.equal(v.length, 4);
});

test('BR-06: fromBaked has coded doors (R_BAD_SOURCE / R_BAD_SCHEMA)', () => {
  assertCode(() => LiteBinaryReader.fromBaked(null), 'R_BAD_SOURCE');
  assertCode(() => LiteBinaryReader.fromBaked(42), 'R_BAD_SOURCE');
  assertCode(() => LiteBinaryReader.fromBaked({ buffer: new ArrayBuffer(16), stride: 8, count: 1 }), 'R_BAD_SCHEMA');
  assertCode(() => LiteBinaryReader.fromBaked({ buffer: new ArrayBuffer(16), stride: 8, count: 1, schema: [] }), 'R_BAD_SCHEMA');
});

test('BR-06: fromLBK1Shard has coded doors (R_BAD_SOURCE / R_BAD_SCHEMA)', () => {
  assertCode(() => LiteBinaryReader.fromLBK1Shard(null), 'R_BAD_SOURCE');
  assertCode(() => LiteBinaryReader.fromLBK1Shard('nope'), 'R_BAD_SOURCE');
  assertCode(() => LiteBinaryReader.fromLBK1Shard({ bytes: new ArrayBuffer(8), rowStride: 8 }), 'R_BAD_SCHEMA');
  assertCode(() => LiteBinaryReader.fromLBK1Shard({ bytes: new ArrayBuffer(8), rowStride: 8, fields: [] }), 'R_BAD_SCHEMA');
});

test('BR-01: a byteOffset past the buffer throws R_BAD_OFFSET (was a silent negative count)', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, byteOffset: 1000 }), 'R_BAD_OFFSET');
  // The same input with an explicit count is refused at the base door too.
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, byteOffset: 1000, count: 3 }), 'R_BAD_OFFSET');
});

test('BR-01: byteOffset === byteLength derives an empty reader (count 0)', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  const rd = new LiteBinaryReader(new ArrayBuffer(64), { schema, byteOffset: 64 });
  assert.equal(rd.count, 0);
});

test('BR-02: a non-integer or non-number type throws R_BAD_TYPE (was truncated)', () => {
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(16), {
    schema: [{ name: 'a', type: T_U8, offset: 0 }, { name: 'b', type: 2.5, offset: 4 }],
  }), 'R_BAD_TYPE');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: '1', offset: 0 }] }), 'R_BAD_TYPE');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: NaN, offset: 0 }] }), 'R_BAD_TYPE');
});

test('BR-03: a NaN / Infinity / fractional byteOffset throws R_BAD_OFFSET (was swallowed by || 0)', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, byteOffset: NaN }), 'R_BAD_OFFSET');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, byteOffset: Infinity }), 'R_BAD_OFFSET');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema, byteOffset: 1.5 }), 'R_BAD_OFFSET');
});

test('BR-08: a detached ArrayBuffer throws a coded R_BAD_SOURCE (was a raw DataView TypeError)', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  const ab = new ArrayBuffer(64);
  structuredClone(ab, { transfer: [ab] }); // transfers -> detaches ab
  assertCode(() => new LiteBinaryReader(ab, { schema }), 'R_BAD_SOURCE');
});

test('BR-08: a view over a detached buffer throws a coded R_BAD_SOURCE', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  const buf = new ArrayBuffer(64);
  const view = new Uint8Array(buf);
  structuredClone(buf, { transfer: [buf] }); // detaches the view's backing buffer
  assertCode(() => new LiteBinaryReader(view, { schema }), 'R_BAD_SOURCE');
});

test('BR-08: a legitimately zero-length ArrayBuffer is NOT detached (constructs, count 0)', () => {
  const rd = new LiteBinaryReader(new ArrayBuffer(0), { schema: [{ name: 'x', type: T_U8, offset: 0 }] });
  assert.equal(rd.count, 0);
});

test('BR-09: a DataView over a detached buffer throws a coded R_BAD_SOURCE (was a raw TypeError from a throwing byteOffset getter)', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  const buf = new ArrayBuffer(64);
  const dv = new DataView(buf);
  structuredClone(buf, { transfer: [buf] }); // detaches dv's backing buffer -> its getters now THROW
  assertCode(() => new LiteBinaryReader(dv, { schema }), 'R_BAD_SOURCE');
});

test('BR-09: a DataView over a LIVE buffer constructs normally (full-span, zero-copy unwrap)', () => {
  const schema = [{ name: 'x', type: T_F64, offset: 0 }];
  const buf = new ArrayBuffer(64);
  new DataView(buf).setFloat64(0, 42.5, true);
  const rd = new LiteBinaryReader(new DataView(buf), { schema });
  assert.equal(rd.count, 8);
  assert.equal(rd.getF64(0, 0), 42.5);
});
