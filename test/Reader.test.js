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

test('VERSION is the shipped v0.3.0 string', () => {
  assert.equal(VERSION, '0.3.0');
});

// --- S4 (v0.3.0): the cursor, readRow, and variable-length surfaces ----------

/** An 8-field, one-per-type schema + a filled buffer of `rows` records. */
function eightFieldFixture(rows) {
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
  const buf = new ArrayBuffer(stride * rows);
  const dv = new DataView(buf);
  for (let r = 0; r < rows; r++) {
    const b = r * stride;
    dv.setFloat64(b + 0, r * 2.5 - 7.25, true);
    dv.setFloat32(b + 8, r * 0.5 + 0.125, true);
    dv.setInt32(b + 12, r - 32, true);
    dv.setUint32(b + 16, (r * 2654435761) >>> 0, true);
    dv.setInt16(b + 20, r - 300, true);
    dv.setUint16(b + 22, (r * 777) & 0xffff, true);
    dv.setInt8(b + 24, (r & 0xff) - 100);
    dv.setUint8(b + 25, (r + 7) & 0xff);
  }
  return { schema, buf, stride };
}

test('A1: seek(row).<type>(id) === getX(row,id) and val === get across all cells', () => {
  const { schema, buf } = eightFieldFixture(64);
  const rd = new LiteBinaryReader(buf, { schema });
  assert.equal(rd.seek(3), rd); // chainable: seek returns this
  const cursor = [rd.f64, rd.f32, rd.i32, rd.u32, rd.i16, rd.u16, rd.i8, rd.u8];
  const typed = [rd.getF64, rd.getF32, rd.getI32, rd.getU32, rd.getI16, rd.getU16, rd.getI8, rd.getU8];
  let cells = 0;
  for (let r = 0; r < 64; r++) {
    for (let f = 0; f < 8; f++) {
      rd.seek(r);
      assert.ok(Object.is(cursor[f].call(rd, f), typed[f].call(rd, r, f)), 'cursor typed mismatch r=' + r + ' f=' + f);
      assert.equal(rd.seek(r).val(f), rd.get(r, f));
      cells++;
    }
  }
  assert.equal(cells, 512);
});

test('A2: readRow fills out[i]===get(r,i) into a reused Array and a Float64Array sink', () => {
  const { schema, buf } = eightFieldFixture(64);
  const rd = new LiteBinaryReader(buf, { schema });
  for (const makeSink of [() => new Array(8), () => new Float64Array(8)]) {
    const out = makeSink();
    for (let r = 0; r < 64; r++) {
      const ret = rd.readRow(r, out);
      assert.equal(ret, out); // returns the same sink
      for (let i = 0; i < 8; i++) assert.ok(out[i] === rd.get(r, i), 'readRow cell mismatch r=' + r + ' i=' + i);
      assert.equal(out.length, 8); // never grew
    }
  }
});

test('A3: readRow refuses a too-short / non-indexable sink with R_BAD_LENGTH', () => {
  const { schema, buf } = eightFieldFixture(4);
  const rd = new LiteBinaryReader(buf, { schema });
  assertCode(() => rd.readRow(0, new Array(7)), 'R_BAD_LENGTH');
  assertCode(() => rd.readRow(0, null), 'R_BAD_LENGTH');
  assertCode(() => rd.readRow(0, {}), 'R_BAD_LENGTH');
  assert.doesNotThrow(() => rd.readRow(0, new Array(8)));
});

test('A4: variable-length bytes(row,id) via a lengthField sibling', () => {
  const schema = [
    { name: 'len', type: T_U32, offset: 0 },
    { name: 'blob', type: T_U8, offset: 4, lengthField: 'len' },
  ];
  const stride = 16, rows = 4;
  const buf = new ArrayBuffer(stride * rows);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  for (let r = 0; r < rows; r++) {
    const b = r * stride;
    const len = r + 1; // 1..4, fits inside the stride
    dv.setUint32(b + 0, len, true);
    for (let k = 0; k < len; k++) u8[b + 4 + k] = (r * 16 + k + 1) & 0xff;
  }
  const rd = new LiteBinaryReader(buf, { schema, stride });
  for (let r = 0; r < rows; r++) {
    const len = r + 1;
    const auto = rd.bytes(r, 1);
    assert.equal(auto.length, len);
    assert.deepEqual(Array.from(auto), Array.from(rd.bytes(r, 1, len)));
  }
  // Door: a length cell of 0xFFFFFFFF overruns the buffer -> R_BUFFER_TOO_SMALL.
  const bigBuf = new ArrayBuffer(16);
  new DataView(bigBuf).setUint32(0, 0xffffffff, true);
  const bigRd = new LiteBinaryReader(bigBuf, { schema, count: 1 });
  assertCode(() => bigRd.bytes(0, 1), 'R_BUFFER_TOO_SMALL');
  // Door: an F64 length source holding 3.5 is not an integer -> R_BAD_LENGTH.
  const fSchema = [
    { name: 'len', type: T_F64, offset: 0 },
    { name: 'blob', type: T_U8, offset: 8, lengthField: 'len' },
  ];
  const fBuf = new ArrayBuffer(16);
  new DataView(fBuf).setFloat64(0, 3.5, true);
  const fRd = new LiteBinaryReader(fBuf, { schema: fSchema, count: 1 });
  assertCode(() => fRd.bytes(0, 1), 'R_BAD_LENGTH');
  // Door: 2-arg bytes() on a field without a lengthField -> R_BAD_LENGTH.
  assertCode(() => rd.bytes(0, 0), 'R_BAD_LENGTH');
  // Construction door: an unknown lengthField NAME -> R_UNKNOWN_FIELD.
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(16), {
    schema: [{ name: 'len', type: T_U32, offset: 0 }, { name: 'blob', type: T_U8, offset: 4, lengthField: 'nope' }],
  }), 'R_UNKNOWN_FIELD');
  // Construction door: a self-referencing lengthField -> R_BAD_SCHEMA.
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(16), {
    schema: [{ name: 'len', type: T_U32, offset: 0 }, { name: 'blob', type: T_U8, offset: 4, lengthField: 'blob' }],
  }), 'R_BAD_SCHEMA');
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

// =============================================================================
// QA S4 -- hole hunt: the cursor / readRow / 2-arg bytes surfaces share _dv,
// _base and _stride with getX BY CONSTRUCTION only if the address arithmetic is
// exercised beyond row 0. No test anywhere in test/Reader.test.js or
// test/torture/*.mjs constructs a cursor/readRow/2-arg-bytes reader with a
// NONZERO byteOffset -- every A1/A2/A4 fixture and t5 Oracle D / t9 control 11
// use byteOffset 0. A missing `_base` term in one of the three new address
// expressions would pass row 0 (base cancels out arithmetically when base===0)
// and only diverge from row 1 onward -- exactly the BR-09-class blind spot the
// existing matrix never crossed. These tests close that gap.
// =============================================================================

test('QA-S4a: seek/readRow/2-arg-bytes agree with getX/get at a NONZERO base, every row', () => {
  const schema = [
    { name: 'len', type: T_U32, offset: 0 },
    { name: 'f64', type: T_F64, offset: 4 },
    { name: 'blob', type: T_U8, offset: 12, lengthField: 'len' },
  ];
  const stride = 20, rows = 6, base = 37; // an odd, non-tidy base on purpose
  const buf = new ArrayBuffer(base + stride * rows + 5); // trailing slack too
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  for (let r = 0; r < rows; r++) {
    const b = base + r * stride;
    const len = r; // 0..5, fits inside the stride's tail room
    dv.setUint32(b + 0, len, true);
    dv.setFloat64(b + 4, r * -3.25 + 1.5, true);
    for (let k = 0; k < len; k++) u8[b + 12 + k] = (r * 20 + k + 1) & 0xff;
  }
  const rd = new LiteBinaryReader(buf, { schema, stride, byteOffset: base, count: rows });
  assert.equal(rd.count, rows);
  for (let r = 0; r < rows; r++) {
    // cursor vs getX/get, every row (not just row 0)
    assert.ok(Object.is(rd.seek(r).u32(0), rd.getU32(r, 0)), 'cursor u32 mismatch at row ' + r);
    assert.ok(Object.is(rd.seek(r).f64(1), rd.getF64(r, 1)), 'cursor f64 mismatch at row ' + r);
    assert.equal(rd.seek(r).val(0), rd.get(r, 0));
    // readRow vs get, every row
    const out = new Array(3);
    rd.readRow(r, out);
    assert.ok(out[0] === rd.get(r, 0) && Object.is(out[1], rd.get(r, 1)) && out[2] === rd.get(r, 2),
      'readRow mismatch at row ' + r);
    // 2-arg bytes lands at base + r*stride + off, every row
    const len = r;
    const v = rd.bytes(r, 2);
    assert.equal(v.length, len);
    for (let k = 0; k < len; k++) assert.equal(v[k], (r * 20 + k + 1) & 0xff);
  }
});

test('QA-S4b: partial/offset-view (BR-07 class) reader -- cursor, readRow, 2-arg bytes stay in-window', () => {
  const pool = new Uint8Array(96);
  pool.fill(0xee); // poison outside the reader's window
  const winStart = 24, winLen = 40; // an offset AND partial view (not full-span)
  const stride = 20, rows = 2;
  const dvPool = new DataView(pool.buffer);
  for (let r = 0; r < rows; r++) {
    const b = winStart + r * stride;
    dvPool.setUint32(b + 0, r + 1, true); // len
    dvPool.setFloat64(b + 4, r * 9.5 - 1, true);
    for (let k = 0; k <= r; k++) pool[b + 12 + k] = (r * 5 + k + 9) & 0xff;
  }
  const schema = [
    { name: 'len', type: T_U32, offset: 0 },
    { name: 'f64', type: T_F64, offset: 4 },
    { name: 'blob', type: T_U8, offset: 12, lengthField: 'len' },
  ];
  const view = new Uint8Array(pool.buffer, winStart, winLen); // offset + partial
  const rd = new LiteBinaryReader(view, { schema, stride, count: rows });
  // resolved buffer is exactly the window: no poison bytes are reachable at all
  assert.equal(rd.buffer.byteLength, winLen);
  assert.notEqual(rd.buffer, pool.buffer);
  for (let r = 0; r < rows; r++) {
    assert.ok(Object.is(rd.seek(r).u32(0), rd.getU32(r, 0)));
    assert.ok(Object.is(rd.seek(r).f64(1), rd.getF64(r, 1)));
    assert.equal(rd.getU32(r, 0), r + 1);
    const out = new Array(3);
    rd.readRow(r, out);
    assert.ok(out[0] === rd.get(r, 0) && Object.is(out[1], rd.get(r, 1)));
    const v = rd.bytes(r, 2);
    assert.equal(v.length, r + 1);
    for (let k = 0; k <= r; k++) assert.equal(v[k], (r * 5 + k + 9) & 0xff);
    // the borrowed view aliases ONLY the copied window, never the poisoned pool
    assert.equal(v.buffer, rd.buffer);
  }
});

test('QA-S4c: lengthField edge values -- negative I32, exact-boundary success, one-past failure, -0', () => {
  // A negative I32 length source -> R_BAD_LENGTH (len < 0).
  {
    const schema = [{ name: 'len', type: T_I32, offset: 0 }, { name: 'blob', type: T_U8, offset: 4, lengthField: 'len' }];
    const buf = new ArrayBuffer(16);
    new DataView(buf).setInt32(0, -1, true);
    const rd = new LiteBinaryReader(buf, { schema, count: 1 });
    assertCode(() => rd.bytes(0, 1), 'R_BAD_LENGTH');
  }
  // A length that lands the span EXACTLY at the buffer end must SUCCEED; one
  // byte more must throw R_BUFFER_TOO_SMALL (the boundary is precise, not off-by-one).
  {
    const schema = [{ name: 'len', type: T_U32, offset: 0 }, { name: 'blob', type: T_U8, offset: 4, lengthField: 'len' }];
    const buf = new ArrayBuffer(20); // blob starts at 4, so a span of 16 ends exactly at 20
    const rd = new LiteBinaryReader(buf, { schema, stride: 20, count: 1 });
    const dv = new DataView(buf);
    dv.setUint32(0, 16, true);
    assert.equal(rd.bytes(0, 1).length, 16);
    dv.setUint32(0, 17, true);
    assertCode(() => rd.bytes(0, 1), 'R_BUFFER_TOO_SMALL');
  }
  // An F64 length source holding -0: Number.isInteger(-0) is true and -0 >= 0,
  // so the door accepts it as a valid (zero-length) span -- document the value.
  {
    const schema = [{ name: 'len', type: T_F64, offset: 0 }, { name: 'blob', type: T_U8, offset: 8, lengthField: 'len' }];
    const buf = new ArrayBuffer(16);
    new DataView(buf).setFloat64(0, -0, true);
    const rd = new LiteBinaryReader(buf, { schema, count: 1 });
    const v = rd.bytes(0, 1);
    assert.equal(v.length, 0);
  }
});

test('QA-S4d: 2-arg bytes() with an out-of-contract row fails CLOSED (throws, never returns a view)', () => {
  const schema = [{ name: 'len', type: T_U32, offset: 0 }, { name: 'blob', type: T_U8, offset: 4, lengthField: 'len' }];
  const buf = new ArrayBuffer(16);
  new DataView(buf).setUint32(0, 4, true);
  const rd = new LiteBinaryReader(buf, { schema, count: 1 });
  for (const badRow of [1000000, -1, -1000]) {
    let threw = null;
    let result;
    try { result = rd.bytes(badRow, 1); } catch (e) { threw = e; }
    assert.equal(result, undefined, 'bytes(' + badRow + ',1) returned a value instead of throwing');
    assert.ok(threw instanceof Error, 'bytes(' + badRow + ',1) did not throw at all');
    // Per the brief, a per-read row bounds check is a NON-GOAL: a raw RangeError
    // (uncoded) is acceptable here. What is NOT acceptable is silently returning
    // a view over memory outside the buffer -- confirmed above by `result` staying
    // undefined on every throwing path.
  }
});

test('QA-S4e: readRow TOCTOU -- a hostile `out.length` getter cannot cause a short write or read-past', () => {
  const schema = [{ name: 'a', type: T_U32, offset: 0 }, { name: 'b', type: T_U8, offset: 4 }];
  const stride = 16, rows = 2;
  const buf = new ArrayBuffer(stride * rows);
  const dv = new DataView(buf);
  dv.setUint32(0, 111, true); dv.setUint8(4, 1);
  dv.setUint32(stride, 222, true); dv.setUint8(stride + 4, 2);
  const rd = new LiteBinaryReader(buf, { schema, stride });

  // Case 1: the getter reports a length >= fieldCount on EVERY read (never lies
  // downward) -- the fill loop must still bind on this._fieldCount, not on a
  // fresh out.length read, so a length that later balloons cannot cause the loop
  // to write past fieldCount cells either.
  {
    let lengthReads = 0;
    const writes = [];
    const backing = [];
    const hostile = new Proxy(backing, {
      get(target, prop, recv) {
        if (prop === 'length') { lengthReads++; return 1000; } // always "huge"
        return Reflect.get(target, prop, recv);
      },
      set(target, prop, value, recv) {
        writes.push(String(prop));
        return Reflect.set(target, prop, value, recv);
      },
    });
    const ret = rd.readRow(0, hostile);
    assert.equal(ret, hostile);
    assert.deepEqual(writes.sort(), ['0', '1'], 'readRow wrote a different index set than [0,1] (' + writes + ')');
    assert.equal(backing[0], rd.get(0, 0));
    assert.equal(backing[1], rd.get(0, 1));
    assert.ok(lengthReads >= 1, 'the door never read out.length at all');
  }

  // Case 2: the getter passes the door once (length >= fieldCount) and then
  // reports a too-short length on every subsequent read. Since the fill loop
  // never re-reads out.length (it binds n = this._fieldCount ONCE, before the
  // loop), this can never manifest as a partial/short write -- prove it doesn't.
  {
    let calls = 0;
    const backing = new Array(2);
    const hostile = new Proxy(backing, {
      get(target, prop, recv) {
        if (prop === 'length') { calls++; return calls <= 2 ? 2 : 0; } // shrinks after the door
        return Reflect.get(target, prop, recv);
      },
    });
    const ret = rd.readRow(1, hostile);
    assert.equal(ret, hostile);
    assert.equal(backing[0], rd.get(1, 0));
    assert.equal(backing[1], rd.get(1, 1));
  }

  // Case 3: a sink that is rejected at the door (length shrinks to below
  // fieldCount on the SECOND read, so the door itself throws) must leave NO
  // partial fill behind -- the door runs entirely before the first write.
  {
    let calls = 0;
    const backing = ['untouched', 'untouched'];
    const hostile = new Proxy(backing, {
      get(target, prop, recv) {
        if (prop === 'length') { calls++; return calls === 1 ? 2 : 0; } // passes typeof check, fails the size check
        return Reflect.get(target, prop, recv);
      },
    });
    assertCode(() => rd.readRow(0, hostile), 'R_BAD_LENGTH');
    assert.deepEqual(backing, ['untouched', 'untouched'], 'a door-rejected sink was partially written before the throw');
  }
});

test('QA-S4f: readRow is reentrancy-safe -- a write-trap that calls back into readRow does not corrupt the outer fill', () => {
  const schema = [{ name: 'a', type: T_U32, offset: 0 }, { name: 'b', type: T_U8, offset: 4 }];
  const stride = 16, rows = 2;
  const buf = new ArrayBuffer(stride * rows);
  const dv = new DataView(buf);
  dv.setUint32(0, 111, true); dv.setUint8(4, 1);
  dv.setUint32(stride, 222, true); dv.setUint8(stride + 4, 2);
  const rd = new LiteBinaryReader(buf, { schema, stride });
  const out = new Array(2);
  let reentered = false;
  const proxy = new Proxy(out, {
    set(target, prop, value, recv) {
      if (!reentered && prop === '0') {
        reentered = true;
        const otherOut = new Array(2);
        rd.readRow(1, otherOut); // reentrant call, mid-fill, on the SAME reader
        assert.equal(otherOut[0], 222);
        assert.equal(otherOut[1], 2);
      }
      return Reflect.set(target, prop, value, recv);
    },
  });
  rd.readRow(0, proxy);
  // readRow has no shared mutable loop state (row is a parameter, pos/n/i are
  // locals per call) -- the outer fill for row 0 must be intact after the
  // reentrant row-1 call completed inside the write trap.
  assert.equal(out[0], 111);
  assert.equal(out[1], 1);
});

test('QA-S4g: seek/getX stay symmetric even on a garbage row (NaN/undefined/null/-0) -- unchecked-by-design, but never diverging', () => {
  // seek()/getX are BOTH unchecked by contract (BRIEF T1); DataView's ToIndex
  // coerces NaN/undefined/null to 0, so a garbage row silently reads row 0
  // rather than throwing on EITHER surface. This is a pre-existing (v0.2.0)
  // getX behaviour, not new to S4 -- the adversarial question is whether the
  // NEW cursor surface stays byte-identical to getX under the same garbage
  // input, or whether it (wrongly) diverges/throws differently.
  const schema = [{ name: 'x', type: T_U32, offset: 0 }];
  const buf = new ArrayBuffer(32);
  new DataView(buf).setUint32(0, 0xdeadbeef >>> 0, true);
  const rd = new LiteBinaryReader(buf, { schema, stride: 8, count: 4 });
  for (const bad of [NaN, undefined, null, -0]) {
    let cursorResult, cursorThrew = null;
    try { cursorResult = rd.seek(bad).u32(0); } catch (e) { cursorThrew = e; }
    let getXResult, getXThrew = null;
    try { getXResult = rd.getU32(bad, 0); } catch (e) { getXThrew = e; }
    assert.equal(cursorThrew, getXThrew, 'cursor/getX diverged on throw-ness for row=' + bad);
    if (cursorThrew === null) assert.ok(Object.is(cursorResult, getXResult), 'cursor/getX diverged in value for row=' + bad);
  }
});
