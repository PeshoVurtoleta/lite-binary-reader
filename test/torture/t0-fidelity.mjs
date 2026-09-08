/**
 * t0 -- read-fidelity laws.
 *
 * For each of the 8 type codes: write N values with a DataView, read them back
 * with the matching getX -- exact for ints, bit-exact for f32/f64 round-trips.
 * Read at an UNALIGNED offset (f64 at offset 1) -- the D2 headline. get(row,id)
 * equals the typed getX(row,id) for every type. Both endiannesses: LE bytes read
 * BE are byte-swapped; round-trip in the matching order is exact. field(name)
 * bijection; typeOf/offsetOf agree with the schema. The full invariant is
 * checked by validate() against an independent DataView oracle.
 */

import { LiteBinaryReader } from '../../Reader.js';
import { makePrng, SEED, check, validate, oracleRead } from './harness.mjs';

// All eight types, one per field, packed at UNALIGNED byte offsets on purpose
// (the D2 claim: a DataView reader tolerates any byte offset a typed-array lane
// cannot). f64 sits at offset 1.
const SCHEMA = [
  { name: 'f64', type: 1, offset: 1 },
  { name: 'f32', type: 0, offset: 9 },
  { name: 'i32', type: 2, offset: 13 },
  { name: 'u32', type: 5, offset: 17 },
  { name: 'i16', type: 3, offset: 21 },
  { name: 'u16', type: 6, offset: 23 },
  { name: 'i8', type: 4, offset: 25 },
  { name: 'u8', type: 7, offset: 26 },
];
const STRIDE = 27; // tight: maxEnd = 26 + 1
const COUNT = 512;

/** Write a row of pseudo-random values through a DataView at the given order. */
function writeRow(dv, base, prng, le) {
  dv.setFloat64(base + 1, (prng() - 2147483648) * 1e-3, le);
  dv.setFloat32(base + 9, (prng() >>> 8) * 1e-2, le);
  dv.setInt32(base + 13, prng() | 0, le);
  dv.setUint32(base + 17, prng() >>> 0, le);
  dv.setInt16(base + 21, (prng() & 0xffff) - 32768, le);
  dv.setUint16(base + 23, prng() & 0xffff, le);
  dv.setInt8(base + 25, (prng() & 0xff) - 128);
  dv.setUint8(base + 26, prng() & 0xff);
}

export async function run() {
  for (const le of [true, false]) {
    const prng = makePrng(SEED);
    const buf = new ArrayBuffer(STRIDE * COUNT);
    const dv = new DataView(buf);
    for (let r = 0; r < COUNT; r++) writeRow(dv, r * STRIDE, prng, le);

    const reader = new LiteBinaryReader(buf, { schema: SCHEMA, littleEndian: le });

    // stride + count derivation
    check(reader.stride === STRIDE, () => 't0: derived stride ' + reader.stride + ' != ' + STRIDE);
    check(reader.count === COUNT, () => 't0: derived count ' + reader.count + ' != ' + COUNT);
    check(reader.littleEndian === le, () => 't0: littleEndian flag lost');

    // field() bijection + typeOf/offsetOf agree with the schema
    for (let i = 0; i < SCHEMA.length; i++) {
      const id = reader.field(SCHEMA[i].name);
      check(id === i, () => 't0: field(' + SCHEMA[i].name + ')=' + id + ' != ' + i);
      check(reader.typeOf(id) === SCHEMA[i].type, () => 't0: typeOf mismatch at ' + SCHEMA[i].name);
      check(reader.offsetOf(id) === SCHEMA[i].offset, () => 't0: offsetOf mismatch at ' + SCHEMA[i].name);
    }

    // full read-fidelity invariant vs an independent DataView oracle
    const v = validate(reader, SCHEMA);
    check(v === null, () => 't0: validate() reported "' + v + '" (le=' + le + ', seed=' + SEED + ')');
  }

  // --- both endiannesses: LE bytes read BE are byte-swapped -------------------
  // Write ONE order, read it in the OTHER order, and prove the reader honors the
  // flag (a symmetric value would hide the swap, so pick an asymmetric u32).
  const swapBuf = new ArrayBuffer(8);
  const swapDv = new DataView(swapBuf);
  swapDv.setUint32(0, 0x01020304, true); // little-endian bytes 04 03 02 01
  const leReader = new LiteBinaryReader(swapBuf, { schema: [{ name: 'u', type: 5, offset: 0 }], littleEndian: true });
  const beReader = new LiteBinaryReader(swapBuf, { schema: [{ name: 'u', type: 5, offset: 0 }], littleEndian: false });
  check(leReader.getU32(0, 0) === 0x01020304, () => 't0: LE read of LE bytes wrong: ' + leReader.getU32(0, 0));
  check(beReader.getU32(0, 0) === 0x04030201, () => 't0: BE read of LE bytes not byte-swapped: ' + beReader.getU32(0, 0));
  check(leReader.getU32(0, 0) !== beReader.getU32(0, 0), () => 't0: endianness flag ignored (LE == BE)');

  // --- get(row,id) equals typed getX(row,id) via the oracle, both orders ------
  const oracleDv = new DataView(swapBuf);
  for (const le of [true, false]) {
    const r = new LiteBinaryReader(swapBuf, { schema: [{ name: 'u', type: 5, offset: 0 }], littleEndian: le });
    check(r.get(0, 0) === r.getU32(0, 0), () => 't0: get() != getU32()');
    check(r.get(0, 0) === oracleRead(oracleDv, 5, 0, le), () => 't0: get() != oracle (le=' + le + ')');
  }
}
