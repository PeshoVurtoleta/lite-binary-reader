/**
 * t2 -- adversarial + the door matrix + the reproduced-todo registry.
 *
 * Three jobs:
 *   1. Every type placed at a misaligned offset inside a wide record reads
 *      bit-exact (the D2 tolerance).
 *   2. The WORKING doors, pinned by name (ROADMAP section 2 "verified-correct"):
 *      R_BUFFER_TOO_SMALL (C2), R_BAD_STRIDE (C5), R_BAD_OFFSET (P13/C7),
 *      R_BAD_COUNT (P3), R_BAD_SCHEMA (P9), R_BAD_SOURCE (P10). Plus the pooled
 *      offset-view COPY (D7/P12): poison outside the window is never read.
 *   3. checkCoherence returns null on every coherent input in the matrix; the
 *      six findings (BR-01..BR-06), fail-closed at the door since S2, are pinned
 *      here as enforced coded R_* throws (PROMOTED from the S1 reproduced-todos,
 *      whose registry is now EMPTY); and the full door matrix (ROADMAP section 4)
 *      is crossed, every cell asserting that the constructor throws a coded R_*
 *      IFF checkCoherence flags it -- the door <-> checkCoherence agreement.
 */

import { LiteBinaryReader, T_F64, T_U8, T_U32 } from '../../Reader.js';
import { check, checkCoherence, validate } from './harness.mjs';

/** Assert a constructor call throws a LiteBinaryReaderError with the given code. */
function expectCode(fn, code, label) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  check(threw !== null, () => 't2: ' + label + ' did not throw (expected ' + code + ')');
  check(threw.code === code,
    () => 't2: ' + label + ' threw code ' + (threw && threw.code) + ', expected ' + code);
}

export async function run() {
  // --- 1. every type at a misaligned offset in a wide record ------------------
  const schema = [
    { name: 'f64', type: 1, offset: 3 },
    { name: 'f32', type: 0, offset: 11 },
    { name: 'i32', type: 2, offset: 15 },
    { name: 'u32', type: 5, offset: 19 },
    { name: 'i16', type: 3, offset: 23 },
    { name: 'u16', type: 6, offset: 25 },
    { name: 'i8', type: 4, offset: 27 },
    { name: 'u8', type: 7, offset: 28 },
  ];
  const stride = 29;
  const count = 128;
  const buf = new ArrayBuffer(stride * count);
  const dv = new DataView(buf);
  for (let r = 0; r < count; r++) {
    const b = r * stride;
    dv.setFloat64(b + 3, r * 3.5 - 1.25, true);
    dv.setFloat32(b + 11, r * 0.5, true);
    dv.setInt32(b + 15, r - 64, true);
    dv.setUint32(b + 19, (r * 97 + 1) >>> 0, true);
    dv.setInt16(b + 23, r - 200, true);
    dv.setUint16(b + 25, (r * 3) & 0xffff, true);
    dv.setInt8(b + 27, (r & 0xff) - 128);
    dv.setUint8(b + 28, r & 0xff);
  }
  const wide = new LiteBinaryReader(buf, { schema });
  check(validate(wide, schema) === null, () => 't2: misaligned wide record validate failed');
  check(checkCoherence(buf, { schema }) === null, () => 't2: checkCoherence rejected a valid wide record');

  // --- 2. the WORKING doors, pinned by name -----------------------------------
  const okSchema = [{ name: 'x', type: T_F64, offset: 0 }];
  const buf64 = new ArrayBuffer(64);

  // R_BUFFER_TOO_SMALL (C2): count*stride one byte over the buffer.
  expectCode(() => new LiteBinaryReader(buf64, { schema: okSchema, count: 9 }),
    'R_BUFFER_TOO_SMALL', 'C2 explicit-count overflow');
  // R_BAD_STRIDE (C5): stride < maxEnd.
  expectCode(() => new LiteBinaryReader(buf64, { schema: okSchema, stride: 4 }),
    'R_BAD_STRIDE', 'C5 stride < maxEnd');
  // R_BAD_OFFSET (P13): negative byteOffset; (C7): fractional field offset.
  expectCode(() => new LiteBinaryReader(buf64, { schema: okSchema, byteOffset: -1 }),
    'R_BAD_OFFSET', 'P13 negative byteOffset');
  expectCode(() => new LiteBinaryReader(buf64, { schema: [{ name: 'x', type: T_F64, offset: 1.5 }] }),
    'R_BAD_OFFSET', 'C7 fractional field offset');
  // R_BAD_COUNT (P3): fractional count.
  expectCode(() => new LiteBinaryReader(buf64, { schema: okSchema, count: 2.5 }),
    'R_BAD_COUNT', 'P3 fractional count');
  // R_BAD_SCHEMA (P9): missing options / empty schema.
  expectCode(() => new LiteBinaryReader(buf64, undefined),
    'R_BAD_SCHEMA', 'P9 missing options');
  expectCode(() => new LiteBinaryReader(buf64, { schema: [] }),
    'R_BAD_SCHEMA', 'P9 empty schema');
  // R_BAD_SOURCE (P10): a plain array is not an ArrayBuffer or view.
  expectCode(() => new LiteBinaryReader([1, 2, 3], { schema: okSchema }),
    'R_BAD_SOURCE', 'P10 plain array source');
  // R_BAD_SOURCE (BR-08): a DETACHED ArrayBuffer, and a view over a detached
  // buffer, both reach the coercion block with a dead backing store and must be
  // refused with a coded R_BAD_SOURCE (not a raw DataView TypeError).
  const detachedAb = new ArrayBuffer(64);
  structuredClone(detachedAb, { transfer: [detachedAb] }); // transfers -> detaches detachedAb
  expectCode(() => new LiteBinaryReader(detachedAb, { schema: okSchema }),
    'R_BAD_SOURCE', 'BR-08 detached ArrayBuffer');
  const detachedViewBuf = new ArrayBuffer(64);
  const detachedView = new Uint8Array(detachedViewBuf);
  structuredClone(detachedViewBuf, { transfer: [detachedViewBuf] }); // detaches the view's buffer
  expectCode(() => new LiteBinaryReader(detachedView, { schema: okSchema }),
    'R_BAD_SOURCE', 'BR-08 view over a detached buffer');
  // R_BAD_SOURCE (BR-09): a DataView over a detached buffer. A DataView's
  // byteOffset/byteLength getters THROW when the backing buffer is detached
  // (TypedArray getters return 0), so the view branch must probe source.buffer
  // for detachment BEFORE any view getter -- else this threw a raw TypeError.
  const detachedDvBuf = new ArrayBuffer(64);
  const detachedDv = new DataView(detachedDvBuf);
  structuredClone(detachedDvBuf, { transfer: [detachedDvBuf] }); // detaches the DataView's buffer
  expectCode(() => new LiteBinaryReader(detachedDv, { schema: okSchema }),
    'R_BAD_SOURCE', 'BR-09 DataView over a detached buffer');

  // --- pooled/offset-view COPY isolation (D7/P12) -----------------------------
  // A pooled Uint8Array window whose surrounding bytes are POISON. The reader
  // must copy the window and never read the poison.
  const pool = new Uint8Array(64);
  pool.fill(0xff); // poison everywhere
  const winDv = new DataView(pool.buffer, 16, 8);
  winDv.setFloat64(0, 12345.6789, true); // the only "real" bytes, inside the window
  const view = new Uint8Array(pool.buffer, 16, 8);
  const pooled = new LiteBinaryReader(view, { schema: okSchema });
  check(pooled.getF64(0, 0) === 12345.6789, () => 't2: pooled window read wrong value');
  check(pooled.count === 1, () => 't2: pooled window count ' + pooled.count + ' != 1');
  // Prove the poison outside the window is unreachable: the copied buffer is
  // exactly the window length, so there is no row 1 to read poison from.
  check(pooled.buffer.byteLength === 8, () => 't2: pooled buffer was not copied to window length');

  // --- 3a. checkCoherence stays null across coherent matrix cells --------------
  check(checkCoherence(buf64, { schema: okSchema }) === null, () => 't2: coherent derived-count cell flagged');
  check(checkCoherence(buf64, { schema: okSchema, count: 8 }) === null, () => 't2: coherent explicit-count cell flagged');
  check(checkCoherence(buf64, { schema: okSchema, byteOffset: 8 }) === null, () => 't2: coherent in-range byteOffset cell flagged');
  check(checkCoherence(buf64, { schema: okSchema, byteOffset: 64 }) === null, () => 't2: coherent byteOffset==len cell flagged');

  // --- 3b. the six findings, PROMOTED from reproduced-todos to enforced throws -
  // The S1 reproduced-todos ran the EXACT probe bodies from ROADMAP section 2 and
  // returned true while each defect still reproduced. S2 fixes each with a coded
  // cold-path door, so the same input now throws a coded R_* -- pinned by name
  // here. The reproduced-todo registry is consequently EMPTY (t9 control 8).

  // BR-01 (P1): a derived count over a past-the-buffer byteOffset used to go
  // NEGATIVE and pass the fit guard. The door now rejects base > byteLength.
  expectCode(() => new LiteBinaryReader(buf64, { schema: okSchema, byteOffset: 1000 }),
    'R_BAD_OFFSET', 'BR-01 derived count over bad base');
  // Documented value: byteOffset === byteLength derives an empty reader (count 0).
  const atEnd = new LiteBinaryReader(buf64, { schema: okSchema, byteOffset: 64 });
  check(atEnd.count === 0, () => 't2: BR-01 byteOffset==byteLength did not derive count 0 (' + atEnd.count + ')');
  // Explicit-count overflow still throws R_BUFFER_TOO_SMALL (the working half).
  expectCode(() => new LiteBinaryReader(buf64, { schema: okSchema, byteOffset: 1000, count: 3 }),
    'R_BAD_OFFSET', 'BR-01 bad base with explicit count');

  // BR-02 (C1): a non-integer/non-number type used to pass the range door, retype
  // via Uint8 truncation and mis-size the record. The door now requires an integer.
  expectCode(() => new LiteBinaryReader(new ArrayBuffer(16), {
    schema: [{ name: 'a', type: T_U8, offset: 0 }, { name: 'b', type: 2.5, offset: 4 }],
  }), 'R_BAD_TYPE', 'BR-02 non-integer type 2.5');
  expectCode(() => new LiteBinaryReader(buf64, { schema: [{ name: 'x', type: '1', offset: 0 }] }),
    'R_BAD_TYPE', 'BR-02 string type "1"');
  expectCode(() => new LiteBinaryReader(buf64, { schema: [{ name: 'x', type: NaN, offset: 0 }] }),
    'R_BAD_TYPE', 'BR-02 NaN type');

  // BR-03 (C6): a NaN/other falsy byteOffset used to be swallowed by `|| 0`. The
  // door now uses `=== undefined`, so NaN/Infinity/fractional reach the guard.
  expectCode(() => new LiteBinaryReader(buf64, { schema: okSchema, byteOffset: NaN }),
    'R_BAD_OFFSET', 'BR-03 NaN byteOffset');
  expectCode(() => new LiteBinaryReader(buf64, { schema: okSchema, byteOffset: Infinity }),
    'R_BAD_OFFSET', 'BR-03 Infinity byteOffset');
  expectCode(() => new LiteBinaryReader(buf64, { schema: okSchema, byteOffset: 1.5 }),
    'R_BAD_OFFSET', 'BR-03 fractional byteOffset');

  // BR-04 (P11): duplicate field names used to be last-wins and silently shadow.
  // The door now refuses them (decision 0002: refuse).
  expectCode(() => new LiteBinaryReader(buf64, {
    schema: [{ name: 'x', type: T_F64, offset: 0 }, { name: 'x', type: T_F64, offset: 8 }],
  }), 'R_DUPLICATE_FIELD', 'BR-04 duplicate field names');

  // BR-05 (P5): bytes() past the buffer used to throw a RAW RangeError. It now
  // has a coded cold door: R_BUFFER_TOO_SMALL on overflow, R_BAD_LENGTH on a
  // non-integer/negative len.
  const b5 = new LiteBinaryReader(buf64, { schema: okSchema });
  expectCode(() => b5.bytes(7, 0, 100), 'R_BUFFER_TOO_SMALL', 'BR-05 bytes() overflow');
  expectCode(() => b5.bytes(0, 0, -1), 'R_BAD_LENGTH', 'BR-05 bytes() negative len');
  expectCode(() => b5.bytes(0, 0, 1.5), 'R_BAD_LENGTH', 'BR-05 bytes() fractional len');

  // BR-06 (P7/P8): the cooperation constructors used to throw RAW TypeErrors while
  // dereferencing. They now validate argument shape first.
  expectCode(() => LiteBinaryReader.fromBaked(null), 'R_BAD_SOURCE', 'BR-06 fromBaked(null)');
  expectCode(() => LiteBinaryReader.fromBaked({ buffer: buf64, stride: 8, count: 1 }),
    'R_BAD_SCHEMA', 'BR-06 fromBaked missing schema');
  expectCode(() => LiteBinaryReader.fromLBK1Shard(null), 'R_BAD_SOURCE', 'BR-06 fromLBK1Shard(null)');
  expectCode(() => LiteBinaryReader.fromLBK1Shard({ bytes: new ArrayBuffer(8), rowStride: 8 }),
    'R_BAD_SCHEMA', 'BR-06 fromLBK1Shard fieldless');

  // --- 3c. S4 (v0.3.0) boundary cases: readRow door + variable-length bytes ----
  // NAMED cases only. checkCoherence does NOT model lengthField, so a lengthField
  // dimension is deliberately kept OUT of the 2700-cell matrix below: adding one
  // would break the throws-IFF-checkCoherence-flags agreement law (the matrix
  // asserts the door and checkCoherence agree, and checkCoherence has no
  // lengthField concept). These stand alone here instead.

  // readRow door: a null / non-indexable / too-short sink is R_BAD_LENGTH; an
  // exactly-fieldCount sink fills and returns itself (non-vacuity).
  const rrSchema = [
    { name: 'a', type: T_F64, offset: 0 },
    { name: 'b', type: T_U8, offset: 8 },
  ];
  const rr = new LiteBinaryReader(new ArrayBuffer(9 * 4), { schema: rrSchema });
  expectCode(() => rr.readRow(0, null), 'R_BAD_LENGTH', 'readRow null sink');
  expectCode(() => rr.readRow(0, {}), 'R_BAD_LENGTH', 'readRow non-indexable sink');
  expectCode(() => rr.readRow(0, new Array(1)), 'R_BAD_LENGTH', 'readRow too-short sink');
  const rrOut = new Array(2);
  check(rr.readRow(0, rrOut) === rrOut, () => 't2: readRow did not return its out sink');
  check(Object.is(rrOut[0], rr.get(0, 0)) && Object.is(rrOut[1], rr.get(0, 1)), () => 't2: readRow filled cells wrong');
  check(rrOut.length === 2, () => 't2: readRow grew the out sink to ' + rrOut.length);

  // variable-length bytes(row,id): 2-arg equals 3-arg for the sibling value.
  const vlSchema = [
    { name: 'len', type: T_U32, offset: 0 },
    { name: 'blob', type: T_U8, offset: 4, lengthField: 'len' },
  ];
  const vlBuf = new ArrayBuffer(16);
  const vlDv = new DataView(vlBuf);
  vlDv.setUint32(0, 5, true);
  for (let k = 0; k < 5; k++) new Uint8Array(vlBuf)[4 + k] = k + 1;
  const vl = new LiteBinaryReader(vlBuf, { schema: vlSchema, count: 1 });
  const vlAuto = vl.bytes(0, 1);
  check(vlAuto.length === 5, () => 't2: variable-length bytes() length ' + vlAuto.length + ' != 5');
  const vlExplicit = vl.bytes(0, 1, 5);
  for (let k = 0; k < 5; k++) check(vlAuto[k] === vlExplicit[k], () => 't2: 2-arg vs 3-arg bytes diverged at ' + k);
  // a length past the buffer -> R_BUFFER_TOO_SMALL.
  vlDv.setUint32(0, 0xffffffff, true);
  expectCode(() => vl.bytes(0, 1), 'R_BUFFER_TOO_SMALL', 'variable-length overrun');
  // a 2-arg bytes() on a field without a lengthField -> R_BAD_LENGTH.
  expectCode(() => vl.bytes(0, 0), 'R_BAD_LENGTH', 'variable-length no lengthField');
  // construction door: an unknown lengthField name -> R_UNKNOWN_FIELD.
  expectCode(() => new LiteBinaryReader(vlBuf, {
    schema: [{ name: 'len', type: T_U32, offset: 0 }, { name: 'blob', type: T_U8, offset: 4, lengthField: 'nope' }],
  }), 'R_UNKNOWN_FIELD', 'variable-length unknown lengthField');
  // construction door: a self-referencing lengthField -> R_BAD_SCHEMA.
  expectCode(() => new LiteBinaryReader(vlBuf, {
    schema: [{ name: 'len', type: T_U32, offset: 0 }, { name: 'blob', type: T_U8, offset: 4, lengthField: 'blob' }],
  }), 'R_BAD_SCHEMA', 'variable-length self-reference');

  // --- 4. the full door matrix (ROADMAP section 4) ----------------------------
  // source {ArrayBuffer, full-span view, zero-offset PARTIAL view, offset view,
  //   full-span DataView, detached} x count {derived,explicit} x byteOffset
  //   {in-range,==len,past,negative,NaN} x type {integer,2.5,"1",-1,10}
  //   x offset {int,1.5,-1} x stride {derived,==maxEnd,<maxEnd}.
  // Every cell asserts the CONTRACT: the constructor throws a coded R_* IFF
  // checkCoherence flags the same input non-null, and never throws an UNCODED
  // error. This is 6 x 2 x 5 x 5 x 3 x 3 = 2700 cells and it is the door <->
  // checkCoherence agreement (the two must never disagree on any input).
  // BR-08: the `detached` source kind is a dead backing store -- every one of its
  // cells must throw R_BAD_SOURCE and checkCoherence must flag it non-null, so the
  // agreement law holds even though a detached buffer never reaches schema checks.
  // BR-09: the `dataview` kind is exercised across the WHOLE matrix -- a DataView
  // is ArrayBuffer.isView-true and a documented source; the S3 QA hole was that
  // neither suite ever fed one. Its detached variant is covered by the named case
  // above and, over the matrix, by the throws-IFF-checkCoherence law.
  // BR-07: the SOURCE dimension is load-bearing -- an ArrayBuffer resolves its
  // length one way and a PARTIAL/offset view another (source.byteLength, post
  // copy-to-window), so crossing only ArrayBuffers left the one input class where
  // the two length-resolutions diverge (views) untested and green over the hole.
  // checkCoherence receives the SAME source object the constructor gets, so their
  // length resolutions are compared honestly.
  const M_COUNTS = [
    { label: 'derived', set: false, count: undefined },
    { label: 'explicit', set: true, count: 2 },
  ];
  const M_BYTEOFF = [
    { label: 'in-range', byteOffset: 8 },
    { label: '==len', byteOffset: 64 },
    { label: 'past', byteOffset: 128 },
    { label: 'negative', byteOffset: -1 },
    { label: 'NaN', byteOffset: NaN },
  ];
  const M_TYPES = [
    { label: 'integer', type: T_F64 },
    { label: '2.5', type: 2.5 },
    { label: '"1"', type: '1' },
    { label: '-1', type: -1 },
    { label: '10', type: 10 }, // S9: the invalid boundary moved 8 -> 10 (8/9 are now T_I64/T_U64)
  ];
  const M_OFFSETS = [
    { label: 'int', offset: 0 },
    { label: '1.5', offset: 1.5 },
    { label: '-1', offset: -1 },
  ];
  const M_STRIDES = [
    { label: 'derived', set: false, stride: undefined },
    { label: '==maxEnd', set: true, stride: 8 }, // F64 maxEnd at offset 0
    { label: '<maxEnd', set: true, stride: 4 },
  ];
  // Six SOURCE kinds. Each `make()` returns a FRESH source so no cell can be
  // perturbed by a prior construction. A view's checkCoherence/constructor length
  // is source.byteLength; an ArrayBuffer's is its own byteLength.
  //   - ArrayBuffer:      64 bytes, used as-is (zero-copy).
  //   - full-span view:   over a 64-byte buffer, byteLength 64 (zero-copy unwrap).
  //   - zero-offset PARTIAL view: byteLength 32 over a 64-byte buffer -- the
  //     BR-07 class: copied to its own 32-byte window, NOT unwrapped to 64.
  //   - offset view:      byteOffset 16, byteLength 32 -- copied to a 32 window.
  //   - dataview:         a full-span DataView over a 64-byte buffer -- also
  //     ArrayBuffer.isView-true; unlike a TypedArray, its byteOffset/byteLength
  //     getters THROW on a detached buffer, so the view branch must probe
  //     source.buffer FIRST (BR-09). Full-span, so it unwraps zero-copy.
  //   - detached:         a 64-byte buffer transferred away (structuredClone with
  //     transfer, NOT MessageChannel -- no event-loop handle, cheap x540). A dead
  //     backing store: every cell must throw R_BAD_SOURCE (BR-08).
  const M_SOURCES = [
    { label: 'ArrayBuffer', make: () => new ArrayBuffer(64) },
    { label: 'full-span view', make: () => new Uint8Array(new ArrayBuffer(64)) },
    { label: 'partial view', make: () => new Uint8Array(new ArrayBuffer(64), 0, 32) },
    { label: 'offset view', make: () => new Uint8Array(new ArrayBuffer(64), 16, 32) },
    { label: 'dataview', make: () => new DataView(new ArrayBuffer(64)) },
    { label: 'detached', make: () => { const b = new ArrayBuffer(64); structuredClone(b, { transfer: [b] }); return b; } },
  ];
  for (const sk of M_SOURCES) {
    for (const c of M_COUNTS) {
      for (const bo of M_BYTEOFF) {
        for (const ty of M_TYPES) {
          for (const of of M_OFFSETS) {
            for (const st of M_STRIDES) {
              const opts = { schema: [{ name: 'x', type: ty.type, offset: of.offset }], byteOffset: bo.byteOffset };
              if (c.set) opts.count = c.count;
              if (st.set) opts.stride = st.stride;
              // The SAME source object goes to both, so their length resolutions
              // are compared honestly (BR-07).
              const src = sk.make();
              const coh = checkCoherence(src, opts);
              let threw = null;
              try { new LiteBinaryReader(src, opts); } catch (e) { threw = e; }
              const cell = () => 't2 door matrix [source=' + sk.label + ' count=' + c.label +
                ' byteOffset=' + bo.label + ' type=' + ty.label + ' offset=' + of.label +
                ' stride=' + st.label + ']';
              // agreement: the door throws IFF checkCoherence flags the input.
              check((coh === null) === (threw === null),
                () => cell() + ': checkCoherence=' + (coh === null ? 'null' : JSON.stringify(coh)) +
                  ' but constructor ' + (threw === null ? 'did not throw' : 'threw ' + threw.code));
              // every door throw is a coded R_*, never a raw error.
              if (threw !== null) {
                check(typeof threw.code === 'string' && threw.code.indexOf('R_') === 0,
                  () => cell() + ': threw an uncoded error (' + (threw && threw.name) + ')');
              }
            }
          }
        }
      }
    }
  }
}
