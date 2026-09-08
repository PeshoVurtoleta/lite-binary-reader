/**
 * t1 -- degenerate layouts.
 *
 * Odd strides (1,3,7,9), a single-field record, a record with a base byteOffset
 * into a larger buffer, count===0, stride===maxEnd (tight pack), a field at the
 * very end of the record, a buffer sized to EXACTLY count*stride, and byteOffset
 * EXACTLY equal to byteLength (must derive count===0, ROADMAP P1c). Every case is
 * proven with the full read-fidelity invariant via validate().
 */

import { LiteBinaryReader } from '../../Reader.js';
import { makePrng, SEED, check, validate, checkCoherence } from './harness.mjs';

export async function run() {
  const prng = makePrng(SEED);

  // --- odd strides with a single U8 field -------------------------------------
  for (const stride of [1, 3, 7, 9]) {
    const count = 64;
    const buf = new ArrayBuffer(stride * count);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i++) bytes[i] = prng() & 0xff;
    const schema = [{ name: 'b', type: 7, offset: 0 }];
    const r = new LiteBinaryReader(buf, { schema, stride });
    check(r.stride === stride, () => 't1: odd stride ' + stride + ' not honored (' + r.stride + ')');
    check(r.count === count, () => 't1: odd-stride count ' + r.count + ' != ' + count);
    const v = validate(r, schema);
    check(v === null, () => 't1: odd stride ' + stride + ' validate: ' + v);
  }

  // --- single-field record, stride===maxEnd (tight pack), field at record end -
  {
    const schema = [{ name: 'x', type: 1, offset: 0 }]; // F64, maxEnd 8
    const buf = new ArrayBuffer(8 * 100);
    const dv = new DataView(buf);
    for (let i = 0; i < 100; i++) dv.setFloat64(i * 8, i * 1.5 - 33.25, true);
    const r = new LiteBinaryReader(buf, { schema });
    check(r.stride === 8, () => 't1: tight-pack stride ' + r.stride + ' != 8');
    check(r.count === 100, () => 't1: tight-pack count ' + r.count + ' != 100');
    check(validate(r, schema) === null, () => 't1: tight-pack validate failed');
  }

  // --- base byteOffset into a larger buffer, buffer EXACTLY count*stride+base --
  {
    const schema = [{ name: 'a', type: 5, offset: 0 }, { name: 'b', type: 6, offset: 4 }]; // U32,U16 -> maxEnd 6
    const stride = 6;
    const count = 10;
    const base = 6; // one record of leading slack
    const buf = new ArrayBuffer(base + stride * count);
    const dv = new DataView(buf);
    for (let i = 0; i < count; i++) {
      dv.setUint32(base + i * stride, (i * 7 + 1) >>> 0, true);
      dv.setUint16(base + i * stride + 4, (i * 3 + 2) & 0xffff, true);
    }
    const r = new LiteBinaryReader(buf, { schema, count, byteOffset: base });
    check(r.count === count, () => 't1: based count ' + r.count + ' != ' + count);
    check(validate(r, schema) === null, () => 't1: based-offset validate failed');
  }

  // --- count===0 explicitly -> a valid empty reader ---------------------------
  {
    const schema = [{ name: 'x', type: 2, offset: 0 }];
    const buf = new ArrayBuffer(64);
    const r = new LiteBinaryReader(buf, { schema, count: 0 });
    check(r.count === 0, () => 't1: explicit count 0 gave ' + r.count);
    check(validate(r, schema) === null, () => 't1: empty reader validate failed');
    check(checkCoherence(buf, { schema, count: 0 }) === null, () => 't1: checkCoherence rejected an empty reader');
  }

  // --- byteOffset EXACTLY equal to byteLength must derive count===0 (P1c) ------
  {
    const schema = [{ name: 'x', type: 1, offset: 0 }];
    const buf = new ArrayBuffer(64);
    const r = new LiteBinaryReader(buf, { schema, byteOffset: 64 });
    check(r.count === 0, () => 't1: byteOffset==byteLength derived count ' + r.count + ' != 0 (P1c)');
    check(checkCoherence(buf, { schema, byteOffset: 64 }) === null,
      () => 't1: checkCoherence rejected byteOffset==byteLength (should be coherent, count 0)');
  }
}
