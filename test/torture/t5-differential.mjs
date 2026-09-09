/**
 * t5 -- differential vs oracles.
 *
 * Oracle A (required): a plain DataView reading the same positions, cell-for-cell
 * equal over 100k random (row,field) reads. Divergence prints seed + index.
 *
 * Oracle B (emulated): a lite-bake-shaped buffer (NATIVE endianness, the shared
 * Types table) proven read cell-identically through fromBaked vs a direct native
 * DataView read (real sibling buffers arrive in S5).
 *
 * Oracle C (emulated): a carved LBK1 shard (LE, lane_kind 1=F64 / 3=U32) proven
 * read through fromLBK1Shard -- F64 exact, U32 index exact -- BECAUSE lane_kind is
 * translated (D3). The T9 no-translate control proves the collision bites.
 *
 * The harness TYPE_BYTES table is the reader's TYPE_BYTES [4,8,4,2,1,4,2,1]; this
 * tier is where a drift between them would surface as a stride/oracle mismatch.
 */

import { LiteBinaryReader, IS_LITTLE_ENDIAN } from '../../Reader.js';
import { makePrng, SEED, check, oracleRead, TYPE_BYTES } from './harness.mjs';

const SCHEMA = [
  { name: 'f64', type: 1, offset: 0 },
  { name: 'f32', type: 0, offset: 8 },
  { name: 'i32', type: 2, offset: 12 },
  { name: 'u32', type: 5, offset: 16 },
  { name: 'i16', type: 3, offset: 20 },
  { name: 'u16', type: 6, offset: 22 },
  { name: 'i8', type: 4, offset: 24 },
  { name: 'u8', type: 7, offset: 25 },
];
const STRIDE = 26;
const COUNT = 4096;
const READS = 100000;

export async function run() {
  // --- drift note made executable: the harness table must equal the reader's --
  // A single reader built here derives its stride from the reader's own
  // TYPE_BYTES; if the harness copy drifted, the oracle offsets below diverge.
  for (let t = 0; t < 8; t++) {
    check(TYPE_BYTES[t] === [4, 8, 4, 2, 1, 4, 2, 1][t],
      () => 't5: harness TYPE_BYTES drifted at code ' + t);
  }

  // --- Oracle A: DataView over the same positions -----------------------------
  const prng = makePrng(SEED);
  const buf = new ArrayBuffer(STRIDE * COUNT);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bytes[i] = prng() & 0xff; // random raw bytes

  const reader = new LiteBinaryReader(buf, { schema: SCHEMA, littleEndian: true });
  const base = 0;
  for (let k = 0; k < READS; k++) {
    const row = prng() % COUNT;
    const fid = prng() % SCHEMA.length;
    const t = SCHEMA[fid].type;
    const pos = base + row * STRIDE + SCHEMA[fid].offset;
    const oracle = oracleRead(dv, t, pos, true);
    const got = reader.get(row, fid);
    check(Object.is(got, oracle),
      () => 't5 oracle A diverged at k=' + k + ' row=' + row + ' fid=' + fid +
        ' got=' + got + ' oracle=' + oracle + ' (seed=' + SEED + ')');
  }

  // --- Oracle D: the row cursor reads identically to the DataView oracle (A9) --
  // seek(row) then the type-matched cursor read must equal oracleRead cell-for-
  // cell over 100k random (row,fid). The cursor INLINES the getX arithmetic with
  // _cursor substituted for row, so any divergence here is a cursor-address bug.
  {
    const cprng = makePrng((SEED ^ 0x5bd1e995) >>> 0 || 1);
    for (let k = 0; k < READS; k++) {
      const row = cprng() % COUNT;
      const fid = cprng() % SCHEMA.length;
      const t = SCHEMA[fid].type;
      const pos = base + row * STRIDE + SCHEMA[fid].offset;
      const oracle = oracleRead(dv, t, pos, true);
      reader.seek(row);
      let got;
      switch (t) {
        case 1: got = reader.f64(fid); break;
        case 0: got = reader.f32(fid); break;
        case 2: got = reader.i32(fid); break;
        case 5: got = reader.u32(fid); break;
        case 3: got = reader.i16(fid); break;
        case 6: got = reader.u16(fid); break;
        case 4: got = reader.i8(fid); break;
        default: got = reader.u8(fid);
      }
      check(Object.is(got, oracle),
        () => 't5 oracle D (cursor) diverged at k=' + k + ' row=' + row + ' fid=' + fid +
          ' got=' + got + ' oracle=' + oracle + ' (seed=' + SEED + ')');
    }
  }

  // --- Oracle B: an emulated lite-bake buffer (NATIVE endianness) --------------
  // lite-bake writes native order with no marker; fromBaked reads native. Prove
  // every cell equals a direct native DataView read.
  {
    const bakedSchema = [
      { name: 'a', type: 1, offset: 0 },  // F64
      { name: 'b', type: 5, offset: 8 },  // U32
      { name: 'c', type: 0, offset: 12 }, // F32
    ];
    const bStride = 16;
    const bCount = 256;
    const bBuf = new ArrayBuffer(bStride * bCount);
    const bDv = new DataView(bBuf);
    for (let i = 0; i < bCount; i++) {
      bDv.setFloat64(i * bStride, i * 2.5 - 7.5, IS_LITTLE_ENDIAN);
      bDv.setUint32(i * bStride + 8, (i * 131 + 7) >>> 0, IS_LITTLE_ENDIAN);
      bDv.setFloat32(i * bStride + 12, i * 0.25, IS_LITTLE_ENDIAN);
    }
    const baked = { buffer: bBuf, stride: bStride, count: bCount, schema: bakedSchema };
    const br = LiteBinaryReader.fromBaked(baked);
    for (let i = 0; i < bCount; i++) {
      check(Object.is(br.getF64(i, 0), oracleRead(bDv, 1, i * bStride, IS_LITTLE_ENDIAN)),
        () => 't5 oracle B: fromBaked F64 diverged at row ' + i);
      check(Object.is(br.getU32(i, 1), oracleRead(bDv, 5, i * bStride + 8, IS_LITTLE_ENDIAN)),
        () => 't5 oracle B: fromBaked U32 diverged at row ' + i);
      check(Object.is(br.getF32(i, 2), oracleRead(bDv, 0, i * bStride + 12, IS_LITTLE_ENDIAN)),
        () => 't5 oracle B: fromBaked F32 diverged at row ' + i);
    }
  }

  // --- Oracle C: an emulated LBK1 shard (LE, lane_kind translated) -------------
  // LBK1 lane_kind: 1=F64, 3=U32 (a string-table index). fromLBK1Shard TRANSLATES
  // to our type codes; the U32 index is returned as the raw number.
  {
    const rowStride = 12;
    const cCount = 200;
    const cBuf = new ArrayBuffer(rowStride * cCount);
    const cDv = new DataView(cBuf);
    for (let i = 0; i < cCount; i++) {
      cDv.setFloat64(i * rowStride, i * -1.5 + 0.5, true);   // LBK1 is LE by spec
      cDv.setUint32(i * rowStride + 8, (i * 9 + 3) >>> 0, true); // string-table index
    }
    const shard = {
      bytes: cBuf,
      rowStride,
      fields: [
        { name: 'val', laneKind: 1, offsetInRow: 0 }, // F64
        { name: 'str', laneKind: 3, offsetInRow: 8 }, // U32 index
      ],
    };
    const cr = LiteBinaryReader.fromLBK1Shard(shard);
    // The translated type codes: F64=1, U32=5. offsetInRow -> field offset.
    check(cr.typeOf(cr.field('val')) === 1, () => 't5 oracle C: F64 lane not translated');
    check(cr.typeOf(cr.field('str')) === 5, () => 't5 oracle C: U32 lane not translated');
    for (let i = 0; i < cCount; i++) {
      check(Object.is(cr.getF64(i, 0), oracleRead(cDv, 1, i * rowStride, true)),
        () => 't5 oracle C: LBK1 F64 diverged at row ' + i);
      check(cr.getU32(i, 1) === oracleRead(cDv, 5, i * rowStride + 8, true),
        () => 't5 oracle C: LBK1 U32 index diverged at row ' + i);
    }
  }
}
