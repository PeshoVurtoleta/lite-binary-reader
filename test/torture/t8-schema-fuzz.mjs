/**
 * t8 -- schema-space fuzz (S7b).
 *
 * t0/t5 fuzz VALUES and (row,field) READS over a FIXED schema; t1 hand-writes a
 * few degenerate layouts. Neither fuzzes the SCHEMA SPACE. This tier draws
 * thousands of RANDOM LEGAL schemas -- random field count, a random subset/order
 * of the 8 type codes, random inter-field padding (so offsets are arbitrary and
 * often unaligned), a random tail pad on the stride, and LE or BE at random --
 * builds a reader plus a reference DataView from the SAME random layout, and
 * asserts every read agrees cell-for-cell (Object.is, so NaN/-0 cannot slip).
 * A single mismatch prints the seed for replay. The layout arithmetic
 * (base + row*stride + offset, per-field width, derived count) is what this
 * exercises that the fixed-schema tiers cannot.
 *
 * Non-vacuity is asserted: the draws must span all 8 lanes AND both endiannesses,
 * and a deliberate wrong-offset control must DIVERGE (the equality has teeth).
 */

import { LiteBinaryReader } from '../../Reader.js';
import { makePrng, SEED, check, die, oracleRead, typedRead, TYPE_BYTES } from './harness.mjs';

const N_SCHEMAS = 3000;
const READS_PER_SCHEMA = 40;
const MAX_FIELDS = 8;
const MAX_PAD = 3;         // arbitrary inter-field / tail padding -> unaligned offsets
const MAX_COUNT = 48;

export async function run() {
  const prng = makePrng(SEED);
  const rnd = (n) => prng() % n;

  const lanesSeen = new Array(8).fill(false);
  const endianSeen = { true: false, false: false };
  let comparisons = 0;
  let rrCells = 0;
  // Reused readRow sinks (an Array and a TypedArray path), sized to MAX_FIELDS.
  const rrArr = new Array(MAX_FIELDS);
  const rrF64 = new Float64Array(MAX_FIELDS);

  for (let s = 0; s < N_SCHEMAS; s++) {
    const nFields = 1 + rnd(MAX_FIELDS);
    const schema = [];
    let cursor = 0;
    for (let k = 0; k < nFields; k++) {
      const type = rnd(8);                 // 0..7, any lane, repeats allowed (names differ)
      cursor += rnd(MAX_PAD + 1);          // random pre-pad -> arbitrary, often unaligned offset
      schema.push({ name: 'f' + k, type, offset: cursor });
      cursor += TYPE_BYTES[type];
      lanesSeen[type] = true;
    }
    const stride = cursor + rnd(MAX_PAD + 1);   // >= largest field end, plus a random tail pad
    const le = rnd(2) === 1;
    endianSeen[le] = true;
    const count = 1 + rnd(MAX_COUNT);

    const buf = new ArrayBuffer(count * stride);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bytes[i] = prng() & 0xff;

    let reader;
    try {
      reader = new LiteBinaryReader(buf, { schema, stride, littleEndian: le });
    } catch (e) {
      die('t8: a LEGAL random schema threw at construction (seed ' + SEED + ', draw ' + s +
        '): ' + (e && e.code ? e.code + ' ' + e.message : e));
    }
    check(reader.count === count, () => 't8: derived count ' + reader.count + ' != ' + count +
      ' (stride ' + stride + ', seed ' + SEED + ', draw ' + s + ')');

    const refDv = new DataView(buf);
    for (let r = 0; r < READS_PER_SCHEMA; r++) {
      const fid = rnd(nFields);
      const row = rnd(count);
      const type = schema[fid].type;
      const pos = row * stride + schema[fid].offset;
      const got = typedRead(reader, type, row, fid);
      const want = oracleRead(refDv, type, pos, le);
      check(Object.is(got, want), () => 't8: MISMATCH field ' + fid + ' type ' + type +
        ' row ' + row + ' -> got ' + got + ' want ' + want +
        ' (stride ' + stride + ', off ' + schema[fid].offset + ', le ' + le +
        ', seed ' + SEED + ', draw ' + s + ')');
      comparisons++;
    }

    // readRow fuzz: fill BOTH sink kinds at a random row and assert every cell is
    // bit-exact (Object.is) vs the oracle -- readRow copies getX results with no
    // transformation, so NaN/-0 (which the random bytes produce on float lanes)
    // must survive into an Array AND a Float64Array sink identically.
    {
      const row = rnd(count);
      const sink = (s & 1) ? rrArr : rrF64;
      const ret = reader.readRow(row, sink);
      check(ret === sink, () => 't8: readRow did not return its sink (seed ' + SEED + ', draw ' + s + ')');
      for (let i = 0; i < nFields; i++) {
        const want = oracleRead(refDv, schema[i].type, row * stride + schema[i].offset, le);
        check(Object.is(sink[i], want), () => 't8: readRow MISMATCH field ' + i + ' type ' +
          schema[i].type + ' row ' + row + ' -> got ' + sink[i] + ' want ' + want +
          ' (' + ((s & 1) ? 'Array' : 'Float64Array') + ' sink, off ' + schema[i].offset +
          ', le ' + le + ', seed ' + SEED + ', draw ' + s + ')');
        rrCells++;
      }
    }
  }

  // --- non-vacuity: the draws must have spanned all 8 lanes and both endiannesses
  for (let t = 0; t < 8; t++) {
    check(lanesSeen[t], () => 't8: lane type ' + t + ' never exercised -- fuzz coverage gap');
  }
  check(endianSeen.true && endianSeen.false, () => 't8: not both endiannesses exercised');
  check(comparisons >= N_SCHEMAS * READS_PER_SCHEMA * 0.99,
    () => 't8: only ' + comparisons + ' comparisons -- suspiciously few');
  check(rrCells >= N_SCHEMAS, () => 't8: only ' + rrCells + ' readRow cells -- coverage gap');

  // --- teeth: a deliberately WRONG offset must DIVERGE from the oracle ---------
  // Two distinct U32 fields; reading field 1's oracle position for field 0's
  // value must NOT match (proves the offset arithmetic is load-bearing, not that
  // the buffer is uniform). Uses distinct byte patterns so a shift changes value.
  {
    const buf = new ArrayBuffer(8);
    const dv = new DataView(buf);
    dv.setUint32(0, 0x01020304, true);
    dv.setUint32(4, 0x0a0b0c0d, true);
    const r = new LiteBinaryReader(buf, {
      schema: [{ name: 'a', type: 5, offset: 0 }, { name: 'b', type: 5, offset: 4 }],
      stride: 8, littleEndian: true,
    });
    check(r.getU32(0, 0) === 0x01020304 && r.getU32(0, 1) === 0x0a0b0c0d,
      () => 't8 control: correct reads wrong (a=' + r.getU32(0, 0) + ' b=' + r.getU32(0, 1) + ')');
    check(r.getU32(0, 0) !== oracleRead(dv, 5, 4, true),
      () => 't8 control: field 0 matched field 1s position -- the offset gate is vacuous');
  }
}
