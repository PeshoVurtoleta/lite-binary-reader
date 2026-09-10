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
  T_F32, T_F64, T_I32, T_I16, T_I8, T_U32, T_U16, T_U8, T_I64, T_U64, VERSION,
} from '../Reader.js';

/** Assert `fn` throws a LiteBinaryReaderError carrying exactly `code`. */
function assertCode(fn, code) {
  assert.throws(fn, (e) => e instanceof LiteBinaryReaderError && e.code === code,
    'expected a LiteBinaryReaderError with code ' + code);
}

test('VERSION is the shipped v1.2.0 string', () => {
  assert.equal(VERSION, '1.2.0');
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
      for (let i = 0; i < 8; i++) assert.ok(Object.is(out[i], rd.get(r, i)), 'readRow cell mismatch r=' + r + ' i=' + i);
      assert.equal(out.length, 8); // never grew
    }
  }
});

test('readRow / cursor are bit-exact for IEEE 754 edge values (NaN, -0, +/-Infinity)', () => {
  // readRow copies getX results with NO transformation; prove it preserves the
  // IEEE 754 edge values that === cannot distinguish, into BOTH an Array and a
  // Float64Array sink, and that the cursor reads them identically. The bytes are
  // hand-placed so each expected value is known exactly (Object.is, not ===).
  const f64vals = [NaN, -0, 0, Infinity, -Infinity, 1.5];
  const f32vals = [NaN, -0, Infinity, -Infinity, 0.5, -0.25];
  const rows = f64vals.length;
  const schema = [
    { name: 'd', type: T_F64, offset: 0 },
    { name: 'f', type: T_F32, offset: 8 },
    { name: 'b', type: T_U8, offset: 12 },
  ];
  const stride = 13;
  const buf = new ArrayBuffer(stride * rows);
  const dv = new DataView(buf);
  for (let r = 0; r < rows; r++) {
    dv.setFloat64(r * stride + 0, f64vals[r], true);
    dv.setFloat32(r * stride + 8, f32vals[r], true);
    dv.setUint8(r * stride + 12, r);
  }
  const rd = new LiteBinaryReader(buf, { schema, stride });
  for (const makeSink of [() => new Array(3), () => new Float64Array(3)]) {
    const out = makeSink();
    for (let r = 0; r < rows; r++) {
      rd.readRow(r, out);
      assert.ok(Object.is(out[0], rd.getF64(r, 0)), 'readRow f64 edge r=' + r);
      assert.ok(Object.is(out[1], rd.getF32(r, 1)), 'readRow f32 edge r=' + r);
      assert.ok(Object.is(out[2], rd.getU8(r, 2)), 'readRow u8 r=' + r);
    }
  }
  for (let r = 0; r < rows; r++) {
    rd.seek(r);
    assert.ok(Object.is(rd.f64(0), rd.getF64(r, 0)), 'cursor f64 edge r=' + r);
    assert.ok(Object.is(rd.f32(1), rd.getF32(r, 1)), 'cursor f32 edge r=' + r);
    assert.ok(Object.is(rd.val(0), rd.get(r, 0)), 'cursor val f64 edge r=' + r);
  }
  // non-vacuity: the NaN and -0 cells really are in the buffer (we tested them, not +0)
  assert.ok(Number.isNaN(rd.getF64(0, 0)) && Object.is(rd.getF64(1, 0), -0), 'edge fixture is vacuous');
});

test('post-construction detach: getX on a detached buffer throws catchably (no native crash), not silent poison', () => {
  // BR-08/BR-09 refuse a buffer detached BEFORE construction with a coded R_BAD_SOURCE.
  // This pins the OTHER timeline: a reader built over a LIVE ArrayBuffer whose buffer
  // is transferred away AFTER construction. The hot path is unchecked by contract, so
  // this is NOT a coded R_* -- but it must be a CATCHABLE JS throw (V8's own DataView
  // guard), never a native crash and never a silently-wrong read. The process staying
  // alive to finish the suite is itself the proof it did not segfault. (A SharedArrayBuffer
  // cannot reach this state at all -- it is non-transferable by spec.)
  const buf = new ArrayBuffer(16);
  new DataView(buf).setFloat64(0, 42.5, true);
  const rd = new LiteBinaryReader(buf, { schema: [{ name: 'x', type: T_F64, offset: 0 }] });
  assert.equal(rd.getF64(0, 0), 42.5); // reads correctly while the buffer is live
  structuredClone(buf, { transfer: [buf] }); // detach buf out from under the reader
  assert.throws(() => rd.getF64(0, 0), (e) => e instanceof Error); // catchable, not a crash
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

test('R_BAD_TYPE on an out-of-range integer type code (-1, 10) at the constructor door', () => {
  // This door correctly rejects an out-of-range INTEGER type. It is distinct from
  // BR-02 (a non-integer type like 2.5 or "1" that WRONGLY passes this same
  // check) -- pin the working half of it at its own call site, not only via the
  // fromLBK1Shard translation table's reuse of the same R_BAD_TYPE code.
  // S9: the type table moved 8 -> 10, so 8 (T_I64) and 9 (T_U64) now CONSTRUCT;
  // the first out-of-range integer is 10, and -1 is still rejected below.
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: -1, offset: 0 }] }), 'R_BAD_TYPE');
  assertCode(() => new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: 10, offset: 0 }] }), 'R_BAD_TYPE');
  // The moved boundary admits 8 and 9 (a 64-bit field constructs cleanly).
  new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: 8, offset: 0 }] });
  new LiteBinaryReader(new ArrayBuffer(64), { schema: [{ name: 'x', type: 9, offset: 0 }] });
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

// =============================================================================
// S4b (v0.4.0) -- laneOf boundary suite, the native typed-lane fast path.
//
// Torture already proves (do NOT duplicate here): T5 Oracle E -- lane reads are
// byte-identical to getX across the full alignment x endianness x type matrix,
// decline on opposite-endian and unaligned width>1, width-1 stays eligible; T6 --
// laneOf is 0 B/op and the lane read loop is 0 B/op + 0 retained (the reference-
// identity checks below are the OBSERVABLE proxy for "no new descriptor built per
// call" -- the 0 B/op number itself is torture's job, not re-measured here); T9
// Control 14 -- elemStride+1 / elemOffset+1 diverge, the descriptor is frozen,
// out-of-range id -> null, the decline controls are non-vacuous.
//
// This suite is the boundary MATRIX around laneOf's one entry point (fieldId):
// 0, 1, N-1, N, N+1, negative, non-integer, null, undefined, NaN, -0; plus the
// always-eligible width-1 field, the frozen/same-reference descriptor contract,
// a BR-07 partial+offset view source composed with a nonzero reader byteOffset,
// all 8 type codes together, and adversarial cases outside T5/T6/T9's aim: a
// shared per-type view instance, live buffer aliasing under a mid-loop write, and
// a re-entrant laneOf call mid-iteration. laneOf has no dispose/release surface,
// so "duplicate dispose" and "dispose-during-iteration" are mapped to their
// closest meaningful analogs (repeated idempotent resolution; a reentrant call
// mid-loop) and called out explicitly where used, never silently reinterpreted.
// =============================================================================

/** An 8-field, one-per-type schema laid out so EVERY field is naturally aligned
 *  on a matching-endian reader (stride 32, a multiple of every width). Mirrors
 *  t5-differential's Oracle E aligned layout exactly. */
function alignedLaneSchema() {
  return [
    { name: 'f64', type: T_F64, offset: 0 },
    { name: 'f32', type: T_F32, offset: 8 },
    { name: 'i32', type: T_I32, offset: 12 },
    { name: 'u32', type: T_U32, offset: 16 },
    { name: 'i16', type: T_I16, offset: 20 },
    { name: 'u16', type: T_U16, offset: 22 },
    { name: 'i8', type: T_I8, offset: 24 },
    { name: 'u8', type: T_U8, offset: 25 },
  ];
}

/** Read one cell through the matching typed getX (not the generic get). */
function laneTypedRead(rd, type, row, id) {
  switch (type) {
    case T_F64: return rd.getF64(row, id);
    case T_F32: return rd.getF32(row, id);
    case T_I32: return rd.getI32(row, id);
    case T_U32: return rd.getU32(row, id);
    case T_I16: return rd.getI16(row, id);
    case T_U16: return rd.getU16(row, id);
    case T_I8: return rd.getI8(row, id);
    default: return rd.getU8(row, id);
  }
}

/** Deterministic xorshift32 filler -- no reliance on Math.random for replay. */
function fillRandomBytes(buf, seed) {
  const u8 = new Uint8Array(buf);
  let x = (seed >>> 0) || 1;
  for (let i = 0; i < u8.length; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x >>>= 0; x ^= x << 5; x >>>= 0;
    u8[i] = x & 0xff;
  }
}

test('S4b: laneOf id 0, 1, N-1 resolve to a lane whose reads equal getX at every row', () => {
  const schema = alignedLaneSchema();
  const stride = 32, rows = 17; // rows so "row 0" and "row count-1" (16) both exercised
  const buf = new ArrayBuffer(stride * rows);
  fillRandomBytes(buf, 12345);
  const rd = new LiteBinaryReader(buf, { schema, stride, littleEndian: IS_LITTLE_ENDIAN });
  const n = rd.fieldCount; // 8
  for (const id of [0, 1, n - 1]) {
    const L = rd.laneOf(id);
    assert.notEqual(L, null, 'field ' + id + ' expected lane-eligible');
    assert.ok('view' in L && 'elemStride' in L && 'elemOffset' in L, 'Lane shape missing a key for id ' + id);
    const t = schema[id].type;
    for (const row of [0, 1, rows - 1]) {
      const laneVal = L.view[row * L.elemStride + L.elemOffset];
      assert.ok(Object.is(laneVal, laneTypedRead(rd, t, row, id)),
        'lane != getX at id=' + id + ' row=' + row);
    }
  }
});

test('S4b: laneOf id N, N+1, negative, and non-integer ids all decline to null', () => {
  const schema = alignedLaneSchema();
  const rd = new LiteBinaryReader(new ArrayBuffer(32 * 4), { schema, stride: 32, littleEndian: IS_LITTLE_ENDIAN });
  const n = rd.fieldCount;
  assert.equal(rd.laneOf(n), null);        // N: exactly one past the last field
  assert.equal(rd.laneOf(n + 1), null);    // N+1
  assert.equal(rd.laneOf(-1), null);       // negative
  assert.equal(rd.laneOf(-1000), null);    // very negative
  assert.equal(rd.laneOf(1.5), null);      // non-integer, in-range value
  assert.equal(rd.laneOf(n - 0.5), null);  // non-integer, boundary-adjacent
});

test('S4b: laneOf(null/undefined/no-arg/NaN) decline; laneOf(-0) aliases field 0 (array-index coercion)', () => {
  const schema = alignedLaneSchema();
  const rd = new LiteBinaryReader(new ArrayBuffer(32 * 4), { schema, stride: 32, littleEndian: IS_LITTLE_ENDIAN });
  assert.equal(rd.laneOf(null), null);
  assert.equal(rd.laneOf(undefined), null);
  assert.equal(rd.laneOf(), null); // no argument at all
  assert.equal(rd.laneOf(NaN), null);
  // -0: ToPropertyKey stringifies -0 to "0", so a plain array read at -0 resolves
  // the SAME slot as 0 -- NOT a decline. A planner who assumed every "falsy-
  // looking" input declines would get this wrong; pin the REAL behaviour.
  const L0 = rd.laneOf(0);
  const LNeg0 = rd.laneOf(-0);
  assert.notEqual(L0, null);
  assert.equal(LNeg0, L0, 'laneOf(-0) must be the IDENTICAL reference to laneOf(0), not merely equal shape');
});

test('S4b: a width-1 field (U8/I8) is lane-eligible on a matching-endian reader regardless of offset/stride parity', () => {
  for (const off of [0, 1, 3, 7]) {
    for (const stride of [off + 1, off + 3, off + 5]) { // odd, non-power-of-two strides too
      const schema = [{ name: 'u8', type: T_U8, offset: off }];
      const rows = 5;
      const buf = new ArrayBuffer(stride * rows);
      fillRandomBytes(buf, off * 97 + stride + 1);
      const rd = new LiteBinaryReader(buf, { schema, stride, littleEndian: IS_LITTLE_ENDIAN });
      const L = rd.laneOf(0);
      assert.notEqual(L, null, 'U8 at offset ' + off + ' stride ' + stride + ' must be eligible');
      for (let row = 0; row < rows; row++) {
        assert.equal(L.view[row * L.elemStride + L.elemOffset], rd.getU8(row, 0));
      }
    }
  }
  // Same immunity for I8 at an odd offset on an odd stride.
  const schemaI8 = [{ name: 'i8', type: T_I8, offset: 3 }];
  const rd2 = new LiteBinaryReader(new ArrayBuffer(7 * 4), { schema: schemaI8, stride: 7, littleEndian: IS_LITTLE_ENDIAN });
  const L2 = rd2.laneOf(0);
  assert.notEqual(L2, null, 'I8 at an odd offset on an odd stride must stay eligible');
  for (let row = 0; row < 4; row++) assert.equal(L2.view[row * L2.elemStride + L2.elemOffset], rd2.getI8(row, 0));
});

test('S4b: the Lane descriptor is frozen and laneOf returns the SAME reference across repeated calls (precompute, not per-call build)', () => {
  const schema = alignedLaneSchema();
  const rd = new LiteBinaryReader(new ArrayBuffer(32 * 4), { schema, stride: 32, littleEndian: IS_LITTLE_ENDIAN });
  const L1 = rd.laneOf(0);
  const L2 = rd.laneOf(0);
  // A third call -- laneOf has no dispose/release surface (it is a pure lookup
  // over an immutable descriptor), so the closest meaningful "duplicate dispose"
  // analog is repeated resolution never rebuilding or mutating shared state; pin
  // identity across 3+ calls, not just 2.
  const L3 = rd.laneOf(0);
  assert.equal(L1, L2);
  assert.equal(L2, L3);
  assert.ok(Object.isFrozen(L1), 'the Lane descriptor must be frozen');
  // This test file is ESM (strict mode): writing to a frozen object's own
  // property throws a TypeError rather than silently no-op-ing.
  assert.throws(() => { L1.elemStride = 999; }, TypeError);
  assert.throws(() => { L1.elemOffset = 999; }, TypeError);
  assert.throws(() => { L1.view = null; }, TypeError);
  assert.equal(L1.elemStride, L2.elemStride, 'a rejected mutation attempt must not have leaked through');
  assert.notEqual(L1.view, null);
});

test('S4b adversarial: multiple eligible fields of the SAME type share exactly one underlying TypedArray view instance', () => {
  // The planner's descriptor shape does not itself say whether same-type lanes
  // share a view or each gets its own -- T3.2 promises "at most ONE view per
  // PRESENT eligible type"; this is the one falsifiable, directly observable
  // consequence of that promise that no other case in this file checks.
  const schema = [
    { name: 'u32a', type: T_U32, offset: 0 },
    { name: 'u32b', type: T_U32, offset: 4 },
    { name: 'u32c', type: T_U32, offset: 8 },
    { name: 'f64', type: T_F64, offset: 16 }, // a different type -> a different view
  ];
  const stride = 24;
  const rd = new LiteBinaryReader(new ArrayBuffer(stride * 6), { schema, stride, littleEndian: IS_LITTLE_ENDIAN });
  const La = rd.laneOf(0), Lb = rd.laneOf(1), Lc = rd.laneOf(2), Ld = rd.laneOf(3);
  assert.notEqual(La, null); assert.notEqual(Lb, null); assert.notEqual(Lc, null); assert.notEqual(Ld, null);
  assert.equal(La.view, Lb.view, 'two eligible U32 fields must share one Uint32Array view');
  assert.equal(Lb.view, Lc.view, 'three eligible U32 fields must share the SAME Uint32Array view');
  assert.notEqual(La.view, Ld.view, 'a different type must NOT share the U32 view');
  assert.ok(La.view instanceof Uint32Array);
  assert.ok(Ld.view instanceof Float64Array);
  // distinct elemOffset per field despite the shared view.
  assert.notEqual(La.elemOffset, Lb.elemOffset);
  assert.notEqual(Lb.elemOffset, Lc.elemOffset);
});

test('S4b: a BR-07 partial/offset view source composed with a nonzero reader byteOffset -- laneOf still equals getX (base+copy composed correctly)', () => {
  const schema = alignedLaneSchema();
  const stride = 32, rows = 5, base = 8; // base=8 is a multiple of every field width (8,4,2,1)
  const winStart = 40, winLen = base + stride * rows;
  const pool = new Uint8Array(winStart + winLen + 16);
  pool.fill(0xee); // poison outside the reader's window
  const windowBytes = new Uint8Array(winLen);
  fillRandomBytes(windowBytes.buffer, 555);
  pool.set(windowBytes, winStart);
  const view = new Uint8Array(pool.buffer, winStart, winLen); // nonzero offset -> COPIED (BR-07)
  const rd = new LiteBinaryReader(view, { schema, stride, byteOffset: base, littleEndian: IS_LITTLE_ENDIAN });
  // the resolved buffer is the OWNED copy, not the poisoned pool -- proves the
  // lane views below are built over the copy, not the original backing store.
  assert.equal(rd.buffer.byteLength, winLen);
  assert.notEqual(rd.buffer, pool.buffer);
  const n = rd.fieldCount;
  let eligible = 0;
  for (let f = 0; f < n; f++) {
    const L = rd.laneOf(f);
    if (L === null) continue;
    eligible++;
    const t = schema[f].type;
    for (let row = 0; row < rows; row++) {
      assert.ok(Object.is(L.view[row * L.elemStride + L.elemOffset], laneTypedRead(rd, t, row, f)),
        'lane != getX over BR-07 window+base at f=' + f + ' row=' + row);
    }
  }
  assert.equal(eligible, n, 'base=8 keeps every field aligned -- a non-vacuous, fully-eligible positive case');
});

test('S4b: all 8 type codes are lane-eligible together and match getX across every row (compact loop)', () => {
  const schema = alignedLaneSchema();
  const stride = 32, rows = 50;
  const buf = new ArrayBuffer(stride * rows);
  fillRandomBytes(buf, 424242);
  const rd = new LiteBinaryReader(buf, { schema, stride, littleEndian: IS_LITTLE_ENDIAN });
  let eligibleCount = 0;
  for (let f = 0; f < schema.length; f++) {
    const L = rd.laneOf(f);
    assert.notEqual(L, null, 'field ' + f + ' (type ' + schema[f].type + ') expected eligible');
    eligibleCount++;
    const t = schema[f].type;
    for (let row = 0; row < rows; row++) {
      assert.ok(Object.is(L.view[row * L.elemStride + L.elemOffset], laneTypedRead(rd, t, row, f)),
        'type ' + t + ' lane != getX at row ' + row);
    }
  }
  assert.equal(eligibleCount, 8, 'all 8 type codes must be represented and eligible in this fixture');
});

test('S4b: an F32 at an odd offset declines while a U8 on the same reader stays eligible; a stride not a multiple of width declines', () => {
  // Odd offset: F32 (width 4) at offset 1 -> its first byte (base 0 + 1) is not
  // a multiple of 4 -> declines. A U8 at offset 0 on the SAME reader stays
  // eligible (width-1 is immune to offset parity).
  const schema1 = [
    { name: 'u8', type: T_U8, offset: 0 },
    { name: 'f32', type: T_F32, offset: 1 },
  ];
  const rd1 = new LiteBinaryReader(new ArrayBuffer(5 * 8), { schema: schema1, stride: 5, littleEndian: IS_LITTLE_ENDIAN });
  assert.notEqual(rd1.laneOf(0), null, 'U8 at offset 0 must stay eligible');
  assert.equal(rd1.laneOf(1), null, 'F32 at an odd offset must decline');

  // Stride not a multiple of width: F32 at offset 0 (aligned at row 0) but
  // stride 6 (not a multiple of 4) misaligns row 1 onward -> declines.
  const schema2 = [{ name: 'f32', type: T_F32, offset: 0 }];
  const rd2 = new LiteBinaryReader(new ArrayBuffer(6 * 8), { schema: schema2, stride: 6, littleEndian: IS_LITTLE_ENDIAN });
  assert.equal(rd2.laneOf(0), null, 'a stride not a multiple of the field width must decline');
});

test('S4b: an opposite-endian reader has an EMPTY lane universe -- every field declines, none eligible', () => {
  const schema = alignedLaneSchema();
  const rd = new LiteBinaryReader(new ArrayBuffer(32 * 4), { schema, stride: 32, littleEndian: !IS_LITTLE_ENDIAN });
  const n = rd.fieldCount;
  let anyEligible = false;
  for (let f = 0; f < n; f++) if (rd.laneOf(f) !== null) anyEligible = true;
  assert.equal(anyEligible, false, 'an opposite-endian reader must offer NO lane at all (the empty case)');
  // getX still serves every read correctly despite the empty lane universe.
  assert.equal(typeof rd.getF64(0, 0), 'number');
});

test('S4b: a re-entrant laneOf call mid-iteration does not disturb an outer lane-read loop (dispose-during-iteration analog)', () => {
  // laneOf has no dispose/release surface to reenter into; the nearest
  // meaningful analog is resolving ANOTHER lane (and re-resolving the SAME one)
  // mid-loop while an outer loop is mid-iteration over its own already-resolved
  // lane, and confirming the outer loop's view/elemStride/elemOffset stay intact.
  const schema = alignedLaneSchema();
  const stride = 32, rows = 10;
  const buf = new ArrayBuffer(stride * rows);
  fillRandomBytes(buf, 9001);
  const rd = new LiteBinaryReader(buf, { schema, stride, littleEndian: IS_LITTLE_ENDIAN });
  const outer = rd.laneOf(0); // F64 lane, resolved once, outside the loop
  const outerView = outer.view, outerStride = outer.elemStride, outerOffset = outer.elemOffset;
  let reentered = false;
  let sum = 0;
  for (let row = 0; row < rows; row++) {
    if (!reentered && row === 3) {
      reentered = true;
      const inner = rd.laneOf(1); // a DIFFERENT field, resolved mid-iteration
      assert.notEqual(inner, null);
      assert.equal(outer.view, outerView, 'the reentrant call mutated the outer lane view');
      assert.equal(outer.elemStride, outerStride, 'the reentrant call mutated the outer elemStride');
      assert.equal(outer.elemOffset, outerOffset, 'the reentrant call mutated the outer elemOffset');
      // re-resolving the SAME field mid-iteration returns the SAME reference.
      assert.equal(rd.laneOf(0), outer);
    }
    sum += outerView[row * outerStride + outerOffset];
  }
  let expected = 0;
  for (let row = 0; row < rows; row++) expected += rd.getF64(row, 0);
  assert.ok(Object.is(sum, expected), 'the outer loop must read identically to getX after the reentrant call');
});

test('S4b: the lane view aliases the LIVE buffer -- a mid-loop write (either direction) is visible on the very next read (no snapshot/caching)', () => {
  const schema = [{ name: 'u32', type: T_U32, offset: 0 }];
  const stride = 4, rows = 4;
  const buf = new ArrayBuffer(stride * rows);
  const dv = new DataView(buf);
  for (let r = 0; r < rows; r++) dv.setUint32(r * stride, r + 1, true);
  const rd = new LiteBinaryReader(buf, { schema, stride, littleEndian: IS_LITTLE_ENDIAN });
  const L = rd.laneOf(0);
  assert.notEqual(L, null);
  assert.equal(L.view[0 * L.elemStride + L.elemOffset], 1);
  // re-entrant write: mutate row 0's bytes THROUGH the DataView mid-"loop".
  dv.setUint32(0, 0xdeadbeef, true);
  assert.equal(L.view[0 * L.elemStride + L.elemOffset], 0xdeadbeef >>> 0, 'the lane view must see a DataView write immediately');
  assert.equal(rd.getU32(0, 0), 0xdeadbeef >>> 0); // getX agrees -- same live bytes
  // and the reverse direction: writing THROUGH the lane view is visible to getX.
  L.view[2 * L.elemStride + L.elemOffset] = 777;
  assert.equal(rd.getU32(2, 0), 777, 'getX must see a write made through the lane view immediately');
});

test('S4b: laneOf coexists with the pinned getX/get/seek+cursor/readRow/bytes surfaces on the same reader', () => {
  const schema = [
    { name: 'len', type: T_U32, offset: 0 },
    { name: 'f64', type: T_F64, offset: 8 },
    { name: 'blob', type: T_U8, offset: 16, lengthField: 'len' },
  ];
  const stride = 24, rows = 3;
  const buf = new ArrayBuffer(stride * rows);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  for (let r = 0; r < rows; r++) {
    const b = r * stride;
    dv.setUint32(b + 0, r + 1, true);
    dv.setFloat64(b + 8, r * 1.25 - 2, true);
    for (let k = 0; k <= r; k++) u8[b + 16 + k] = (r * 10 + k + 1) & 0xff;
  }
  const rd = new LiteBinaryReader(buf, { schema, stride, littleEndian: IS_LITTLE_ENDIAN });
  const Lf64 = rd.laneOf(1);
  assert.notEqual(Lf64, null);
  for (let r = 0; r < rows; r++) {
    assert.ok(Object.is(Lf64.view[r * Lf64.elemStride + Lf64.elemOffset], rd.getF64(r, 1)));
    assert.ok(Object.is(rd.get(r, 1), rd.getF64(r, 1)));
    assert.ok(Object.is(rd.seek(r).f64(1), rd.getF64(r, 1)));
    const out = new Array(3);
    rd.readRow(r, out);
    assert.ok(Object.is(out[1], rd.getF64(r, 1)));
    const v = rd.bytes(r, 2);
    assert.equal(v.length, r + 1);
  }
});

// --- S9 (v1.1.0): 64-bit integer lanes (i64 / u64 via BigInt) ----------------
// The type table moved 8 -> 10; codes 8 (T_I64) / 9 (T_U64) read as BigInt.
// BigInt is a heap value by spec, so these two lanes ALLOCATE (the second
// documented exception alongside bytes()) -- the torture t6 gate proves it. Here
// we pin fidelity: every 64-bit read path is bit-exact vs a DataView oracle
// across LE and BE, at the signed/unsigned boundaries, with Object.is.

const IVALS = [0n, -1n, -(2n ** 63n), 2n ** 63n - 1n, -42n];          // signed range
const UVALS = [0n, 1n, 2n ** 64n - 1n, 2n ** 63n, 9007199254740993n]; // unsigned range

/** A 2-field 64-bit fixture (i64 @0, u64 @8; stride 16) filled by a DataView
 *  oracle at byte order `le`, one boundary pair per row. */
function sixtyFourFixture(le) {
  const rows = IVALS.length;
  const stride = 16;
  const buf = new ArrayBuffer(rows * stride);
  const dv = new DataView(buf);
  for (let r = 0; r < rows; r++) {
    dv.setBigInt64(r * stride + 0, IVALS[r], le);
    dv.setBigUint64(r * stride + 8, UVALS[r], le);
  }
  const schema = [{ name: 'i', type: T_I64, offset: 0 }, { name: 'u', type: T_U64, offset: 8 }];
  const rd = new LiteBinaryReader(buf, { schema, stride, littleEndian: le });
  return { rd, dv, rows, stride, le };
}

test('S9: getI64/getU64 are bit-exact at the 64-bit boundaries, LE and BE', () => {
  for (const le of [true, false]) {
    const { rd, dv, rows, stride } = sixtyFourFixture(le);
    for (let r = 0; r < rows; r++) {
      const oi = dv.getBigInt64(r * stride + 0, le);
      const ou = dv.getBigUint64(r * stride + 8, le);
      // typed getters
      assert.ok(Object.is(rd.getI64(r, 0), oi), 'getI64 le=' + le + ' r=' + r);
      assert.ok(Object.is(rd.getU64(r, 1), ou), 'getU64 le=' + le + ' r=' + r);
      // data-driven get()
      assert.ok(Object.is(rd.get(r, 0), oi), 'get i64 le=' + le + ' r=' + r);
      assert.ok(Object.is(rd.get(r, 1), ou), 'get u64 le=' + le + ' r=' + r);
      // cursor (i64/u64 + data-driven val)
      assert.ok(Object.is(rd.seek(r).i64(0), oi), 'cursor i64 le=' + le + ' r=' + r);
      assert.ok(Object.is(rd.seek(r).u64(1), ou), 'cursor u64 le=' + le + ' r=' + r);
      assert.ok(Object.is(rd.seek(r).val(0), oi), 'cursor val i64 le=' + le + ' r=' + r);
      assert.ok(Object.is(rd.seek(r).val(1), ou), 'cursor val u64 le=' + le + ' r=' + r);
      // readRow into an Array sink (holds number|bigint)
      const out = rd.readRow(r, new Array(2));
      assert.ok(Object.is(out[0], oi) && Object.is(out[1], ou), 'readRow le=' + le + ' r=' + r);
    }
    // non-vacuity: the fixture really carries the extreme values.
    assert.ok(Object.is(rd.getI64(2, 0), -(2n ** 63n)), 'INT64_MIN present');
    assert.ok(Object.is(rd.getU64(2, 1), 2n ** 64n - 1n), 'UINT64_MAX present');
  }
});

test('S9: readRow sink edge -- a Float64Array cannot hold a BigInt (documented, throws)', () => {
  const { rd } = sixtyFourFixture(true);
  // A mixed/64-bit row into a Float64Array sink: assigning a BigInt cell throws a
  // raw TypeError. This is the API contract, NOT a bug -- use an Array sink for a
  // mixed 64-bit row, or a BigInt64Array sink for an all-64-bit signed row.
  assert.throws(() => rd.readRow(0, new Float64Array(2)), TypeError);
  // An Array sink holds both cell kinds fine.
  const arr = rd.readRow(0, new Array(2));
  assert.ok(Object.is(arr[0], rd.getI64(0, 0)) && Object.is(arr[1], rd.getU64(0, 1)));
  // A BigInt64Array sink works for an ALL-i64 row (both cells are signed BigInts).
  const buf = new ArrayBuffer(16), dv = new DataView(buf);
  dv.setBigInt64(0, -(2n ** 63n), true);
  dv.setBigInt64(8, 2n ** 63n - 1n, true);
  const rd2 = new LiteBinaryReader(buf, {
    schema: [{ name: 'a', type: T_I64, offset: 0 }, { name: 'b', type: T_I64, offset: 8 }], stride: 16,
  });
  const bi = rd2.readRow(0, new BigInt64Array(2));
  assert.ok(Object.is(bi[0], rd2.getI64(0, 0)) && Object.is(bi[1], rd2.getI64(0, 1)), 'BigInt64Array sink');
});

test('S9: laneOf over a host-endian 64-bit field returns a BigInt view that matches getI64/getU64', () => {
  const { rd, rows } = sixtyFourFixture(IS_LITTLE_ENDIAN); // host order -> lane eligible, 8-aligned
  const Li = rd.laneOf(0), Lu = rd.laneOf(1);
  assert.notEqual(Li, null, 'i64 lane eligible (host-endian, 8-aligned)');
  assert.notEqual(Lu, null, 'u64 lane eligible');
  assert.ok(Li.view instanceof BigInt64Array, 'i64 lane view is a BigInt64Array');
  assert.ok(Lu.view instanceof BigUint64Array, 'u64 lane view is a BigUint64Array');
  for (let r = 0; r < rows; r++) {
    assert.ok(Object.is(Li.view[r * Li.elemStride + Li.elemOffset], rd.getI64(r, 0)), 'i64 lane r=' + r);
    assert.ok(Object.is(Lu.view[r * Lu.elemStride + Lu.elemOffset], rd.getU64(r, 1)), 'u64 lane r=' + r);
  }
  // Opposite-endian reader declines the 64-bit lane (never a wrong-endian lane).
  const opp = sixtyFourFixture(!IS_LITTLE_ENDIAN).rd;
  assert.equal(opp.laneOf(0), null, 'opposite-endian 64-bit lane declines to null');
});

// --- S10 (v1.2.0): per-field endianness --------------------------------------
// A schema field may carry its OWN `littleEndian`; absent inherits the reader
// flag. We pin: a mixed-endian record reads each field at its own byte order,
// bit-exact vs a DataView oracle across every read path and BOTH reader defaults;
// a field without an override inherits the reader flag (pre-S10 schemas intact);
// a `false` is honored (not swallowed); laneOf's host-endian gate is per field;
// and a non-boolean field littleEndian is a coded R_BAD_SCHEMA.

// A 4-field mixed-endian record (stride 24): a BE u32 and a BE i64 interleaved
// with an LE f32 and an LE u64 -- each value chosen so its LE and BE readings
// differ (so a byte-order mistake cannot pass unnoticed).
const MIX = [
  { name: 'be32', type: T_U32, offset: 0, le: false },
  { name: 'le32', type: T_F32, offset: 4, le: true },
  { name: 'bei64', type: T_I64, offset: 8, le: false },
  { name: 'leu64', type: T_U64, offset: 16, le: true },
];
const MIX_STRIDE = 24;

/** Build the mixed-endian fixture. `readerLE` is the reader-level DEFAULT; every
 *  field carries its own `le`, so the reader default must not change any read. */
function mixedFixture(readerLE) {
  const buf = new ArrayBuffer(MIX_STRIDE);
  const dv = new DataView(buf);
  dv.setUint32(0, 0x01020304, false);                 // BE
  dv.setFloat32(4, 3.5, true);                        // LE
  dv.setBigInt64(8, 0x0102030405060708n, false);      // BE
  dv.setBigUint64(16, 0x1122334455667788n, true);     // LE
  const schema = MIX.map((f) => ({ name: f.name, type: f.type, offset: f.offset, littleEndian: f.le }));
  const rd = new LiteBinaryReader(buf, { schema, stride: MIX_STRIDE, littleEndian: readerLE });
  return { rd, dv };
}

test('S10: a mixed-endian record reads each field at its OWN byte order (all paths, both reader defaults)', () => {
  for (const readerLE of [true, false]) {
    const { rd, dv } = mixedFixture(readerLE);
    // oracle: each field read at ITS declared endianness.
    const oracle = [dv.getUint32(0, false), dv.getFloat32(4, true), dv.getBigInt64(8, false), dv.getBigUint64(16, true)];
    for (let id = 0; id < MIX.length; id++) {
      assert.ok(Object.is(rd.get(0, id), oracle[id]), 'get id=' + id + ' readerLE=' + readerLE);
      assert.ok(Object.is(rd.seek(0).val(id), oracle[id]), 'val id=' + id + ' readerLE=' + readerLE);
    }
    // typed getters + cursor reads.
    assert.equal(rd.getU32(0, 0), oracle[0]); assert.ok(Object.is(rd.getF32(0, 1), oracle[1]));
    assert.ok(Object.is(rd.getI64(0, 2), oracle[2])); assert.ok(Object.is(rd.getU64(0, 3), oracle[3]));
    assert.equal(rd.seek(0).u32(0), oracle[0]); assert.ok(Object.is(rd.seek(0).f32(1), oracle[1]));
    assert.ok(Object.is(rd.seek(0).i64(2), oracle[2])); assert.ok(Object.is(rd.seek(0).u64(3), oracle[3]));
    // readRow into an Array sink (holds number|bigint).
    const out = rd.readRow(0, new Array(4));
    for (let id = 0; id < 4; id++) assert.ok(Object.is(out[id], oracle[id]), 'readRow id=' + id + ' readerLE=' + readerLE);
    // non-vacuity: the BE field is NOT its LE interpretation, and the reader
    // default (which flipped across the loop) changed nothing (per-field wins).
    assert.notEqual(rd.getU32(0, 0), dv.getUint32(0, true), 'be32 is a real BE read, not LE');
  }
});

test('S10: a field without littleEndian inherits the reader flag (default-absent regression)', () => {
  const buf = new ArrayBuffer(8); const dv = new DataView(buf);
  dv.setUint32(0, 0x0A0B0C0D, true);
  const schema = [{ name: 'x', type: T_U32, offset: 0 }]; // NO per-field endianness
  const le = new LiteBinaryReader(buf, { schema, stride: 8, littleEndian: true });
  const be = new LiteBinaryReader(buf, { schema, stride: 8, littleEndian: false });
  assert.equal(le.getU32(0, 0), dv.getUint32(0, true), 'LE reader inherits LE');
  assert.equal(be.getU32(0, 0), dv.getUint32(0, false), 'BE reader inherits BE');
  assert.notEqual(le.getU32(0, 0), be.getU32(0, 0), 'inheritance actually flips byte order');
  // explicit `undefined` behaves exactly like absent (not swallowed to a value).
  const un = new LiteBinaryReader(buf, {
    schema: [{ name: 'x', type: T_U32, offset: 0, littleEndian: undefined }], stride: 8, littleEndian: false,
  });
  assert.equal(un.getU32(0, 0), be.getU32(0, 0), 'explicit undefined inherits like absent');
});

test('S10: a per-field littleEndian:false is honored, never swallowed', () => {
  const buf = new ArrayBuffer(4); const dv = new DataView(buf);
  dv.setUint32(0, 0x01020304, false); // big-endian on the wire
  // A default-TRUE reader whose field says false must read big-endian (the BR-03
  // discipline: a legitimate `false` is not treated as "omitted").
  const rd = new LiteBinaryReader(buf, {
    schema: [{ name: 'x', type: T_U32, offset: 0, littleEndian: false }], stride: 4, littleEndian: true,
  });
  assert.equal(rd.getU32(0, 0), dv.getUint32(0, false), 'false -> BE read');
  assert.notEqual(rd.getU32(0, 0), dv.getUint32(0, true), 'not the LE interpretation of the same bytes');
});

test('S10: laneOf is per-field -- a non-host field declines while a host sibling serves', () => {
  const buf = new ArrayBuffer(16); const dv = new DataView(buf);
  dv.setUint32(0, 0x11223344, IS_LITTLE_ENDIAN);   // host-endian field @0
  dv.setUint32(4, 0x55667788, !IS_LITTLE_ENDIAN);  // opposite-endian field @4
  const rd = new LiteBinaryReader(buf, {
    schema: [
      { name: 'host', type: T_U32, offset: 0, littleEndian: IS_LITTLE_ENDIAN },
      { name: 'opp', type: T_U32, offset: 4, littleEndian: !IS_LITTLE_ENDIAN },
    ], stride: 8, littleEndian: IS_LITTLE_ENDIAN,
  });
  const Lh = rd.laneOf(0), Lo = rd.laneOf(1);
  assert.notEqual(Lh, null, 'host-endian field is lane-eligible');
  assert.equal(Lo, null, 'opposite-endian field declines in the SAME reader');
  assert.equal(Lh.view[Lh.elemOffset], rd.getU32(0, 0), 'served lane matches getX');
  assert.equal(rd.getU32(0, 1), dv.getUint32(4, !IS_LITTLE_ENDIAN), 'declined field still served by getX');
});

test('S10: a non-boolean field littleEndian throws R_BAD_SCHEMA; absent/true/false accepted', () => {
  const buf = new ArrayBuffer(8);
  // -0 is the sharp one: a NUMBER, so it must throw like the rest (a naive `!fe`
  // truthiness check would wrongly treat -0 as false and accept it).
  for (const v of ['yes', 1, 0, null, NaN, -0]) {
    assertCode(() => new LiteBinaryReader(buf, {
      schema: [{ name: 'x', type: T_U32, offset: 0, littleEndian: v }], stride: 8,
    }), 'R_BAD_SCHEMA');
  }
  for (const v of [undefined, true, false]) {
    const s = { name: 'x', type: T_U32, offset: 0 };
    if (v !== undefined) s.littleEndian = v;
    new LiteBinaryReader(buf, { schema: [s], stride: 8 }); // must NOT throw
  }
});
