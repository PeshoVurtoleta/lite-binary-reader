/**
 * t6 -- the zero-alloc gate (STRICT; the read path has no resize frontier).
 *
 * The whole promise of this module is that getX / get allocate NOTHING: a read is
 * one DataView.getX at a computed offset, no object materialized. This tier gates
 * that at maxMajor:0 / maxPauseMs:4 / maxArrayBuffersGrowth:0 (stabilize:'deep',
 * via runOpsGate). The last rule is the one that bites: the buffer and its
 * DataView live OUTSIDE the V8 heap, invisible to a heapUsed gate.
 *
 * Two gates, two separate windows (one measurement at a time):
 *   Gate 1  the canonical hot read loop (all 8 typed getX + get) -- zero-alloc.
 *   Gate 1b the RETAINED-alloc channel runOpsGate cannot see (async-gc blind
 *           spot): runAllocsGate forces a collection per batch and gates
 *           per-call surviving bytes at ALLOC_RULES (1 B/call).
 *
 * Plus the structural facts a heap gate cannot check (ROADMAP HOT PATH): across
 * the measured window buffer.byteLength, _dv identity and _off.length are all
 * unchanged. There is NO Map on the read path, so there is no pre-fill caveat.
 *
 * LBR_TORTURE_BREAK=1 injects a retained allocation into the hot body so the gate
 * rejects the window; T9 Control 1 exercises the same alloc lane in-process.
 */

import { LiteBinaryReader, IS_LITTLE_ENDIAN } from '../../Reader.js';
import { runOpsGate, runAllocsGate, BREAK, check, die } from './harness.mjs';

const COUNT = 4096;        // 2^12 rows so the hot body masks its index with & MASK
const MASK = COUNT - 1;
const STRIDE = 32;         // 8 fields, aligned, padded to 32
const OPS = 60000;
const WARMUP = 2000;

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

/** Retained sink for the BREAK control -- survives GC so arrayBuffers grows. */
const leak = [];

/** Pins the Gate 5 retained containers past their measurement so V8 cannot
 *  dead-code-eliminate the reads whose allocation we are proving. */
const keepAlive = [];

// Hoisted so the hot body closes over primitives/views, never allocates.
const sink = new Float64Array(1);
// Module-hoisted readRow sink -- reused across every measured call (Gate 3).
const rowOut = new Array(8);

export async function run() {
  const buf = new ArrayBuffer(STRIDE * COUNT);
  const dv = new DataView(buf);
  for (let r = 0; r < COUNT; r++) {
    const b = r * STRIDE;
    dv.setFloat64(b + 0, r * 1.5 - 3.25, true);
    dv.setFloat32(b + 8, (r & 255) + 0.5, true);
    dv.setInt32(b + 12, r - 2048, true);
    dv.setUint32(b + 16, (r * 7 + 1) >>> 0, true);
    dv.setInt16(b + 20, (r & 0xffff) - 32768, true);
    dv.setUint16(b + 22, (r * 3) & 0xffff, true);
    dv.setInt8(b + 24, (r & 0xff) - 128);
    dv.setUint8(b + 25, r & 0xff);
  }
  const reader = new LiteBinaryReader(buf, { schema: SCHEMA });

  // The canonical hot body: one read per lane width + one generic get, masked
  // index, single scratch sink, no allocation.
  const hot = (i) => {
    const idx = i & MASK;
    sink[0] += reader.getF64(idx, 0) + reader.getF32(idx, 1) + reader.getI32(idx, 2) +
      reader.getU32(idx, 3) + reader.getI16(idx, 4) + reader.getU16(idx, 5) +
      reader.getI8(idx, 6) + reader.getU8(idx, 7) + reader.get(idx, 0);
    if (BREAK) leak.push(new Float64Array(64)); // control: retained growth
  };

  // The structural facts a heap gate cannot see.
  const bufBytesBefore = reader.buffer.byteLength;
  const dvBefore = reader._dv;
  const offLenBefore = reader._off.length;

  // --- Gate 1: the canonical hot read loop ------------------------------------
  const { report, summary } = runOpsGate(hot, { ops: OPS, warmup: WARMUP });

  check(reader.buffer.byteLength === bufBytesBefore,
    () => 'T6: buffer.byteLength changed ' + bufBytesBefore + ' -> ' + reader.buffer.byteLength);
  check(reader._dv === dvBefore, () => 'T6: the DataView (_dv) was reallocated across the hot window');
  check(reader._off.length === offLenBefore,
    () => 'T6: _off.length changed ' + offLenBefore + ' -> ' + reader._off.length);

  if (!report.ok) {
    const g = summary.gc;
    die('T6 alloc gate rejected -- verdict=' + report.verdict +
      ' source=' + summary.source +
      ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3) +
      (BREAK ? ' (LBR_TORTURE_BREAK control -- expected)' : ''));
  }

  // In BREAK mode the gate was SUPPOSED to reject; reaching here means the
  // injected allocations slipped through, which is itself a failure.
  if (BREAK) die('T6: LBR_TORTURE_BREAK injected allocations but the gate passed');

  // --- Gate 1b: the RETAINED-alloc channel runOpsGate cannot see --------------
  // Same `hot` closure; its `if (BREAK)` branch is dead in a clean run (BREAK
  // dies at Gate 1 above), so this measures the pure zero-alloc body.
  const g1b = runAllocsGate(hot, { iterations: 50000, batches: 8 });
  if (!g1b.ok) {
    die('T6 retained-alloc gate rejected -- verdict=' + g1b.report.verdict +
      ' settled=' + g1b.result.settled +
      ' bytesPerCall=' + g1b.bytesPerCall +
      ' violations=' + g1b.report.violations.length);
  }

  // --- Gate 2: the row cursor (seek + 8 typed cursor reads + val) --------------
  // Its OWN ops window AND retained-alloc window, strictly sequential (never
  // nested -- lite-gc-profiler is one-measurement-at-a-time). seek writes a Smi
  // cursor and each read inlines the getX arithmetic: zero allocation.
  const cursorHot = (i) => {
    const idx = i & MASK;
    reader.seek(idx);
    sink[0] += reader.f64(0) + reader.f32(1) + reader.i32(2) + reader.u32(3) +
      reader.i16(4) + reader.u16(5) + reader.i8(6) + reader.u8(7) + reader.val(0);
  };
  const g2 = runOpsGate(cursorHot, { ops: OPS, warmup: WARMUP });
  check(reader.buffer.byteLength === bufBytesBefore,
    () => 'T6 Gate 2: buffer.byteLength changed ' + bufBytesBefore + ' -> ' + reader.buffer.byteLength);
  check(reader._dv === dvBefore, () => 'T6 Gate 2: the DataView (_dv) was reallocated across the cursor window');
  if (!g2.report.ok) {
    const g = g2.summary.gc;
    die('T6 Gate 2 (cursor) ops gate rejected -- verdict=' + g2.report.verdict +
      ' source=' + g2.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
  }
  const g2a = runAllocsGate(cursorHot, { iterations: 50000, batches: 8 });
  if (!g2a.ok) {
    die('T6 Gate 2 (cursor) retained-alloc gate rejected -- verdict=' + g2a.report.verdict +
      ' settled=' + g2a.result.settled + ' bytesPerCall=' + g2a.bytesPerCall);
  }

  // --- Gate 3: readRow into a module-hoisted, reused out array -----------------
  // Same two-window discipline. The caller owns `rowOut`; readRow allocates
  // nothing and must never grow it.
  const readRowHot = (i) => { reader.readRow(i & MASK, rowOut); };
  const g3 = runOpsGate(readRowHot, { ops: OPS, warmup: WARMUP });
  check(reader.buffer.byteLength === bufBytesBefore,
    () => 'T6 Gate 3: buffer.byteLength changed ' + bufBytesBefore + ' -> ' + reader.buffer.byteLength);
  check(reader._dv === dvBefore, () => 'T6 Gate 3: the DataView (_dv) was reallocated across the readRow window');
  check(rowOut.length === 8, () => 'T6 Gate 3: readRow grew the out array to ' + rowOut.length);
  if (!g3.report.ok) {
    const g = g3.summary.gc;
    die('T6 Gate 3 (readRow) ops gate rejected -- verdict=' + g3.report.verdict +
      ' source=' + g3.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
  }
  const g3a = runAllocsGate(readRowHot, { iterations: 50000, batches: 8 });
  if (!g3a.ok) {
    die('T6 Gate 3 (readRow) retained-alloc gate rejected -- verdict=' + g3a.report.verdict +
      ' settled=' + g3a.result.settled + ' bytesPerCall=' + g3a.bytesPerCall);
  }

  // --- Gate 4: the typed-lane fast path (S4b) ----------------------------------
  // laneOf(id) is a lookup (0 B/op); the lane read loop view[row*eS+eO] is
  // 0 B/op + 0 retained. Each gets its OWN ops window AND retained-alloc window,
  // strictly sequential. The lane reader pins littleEndian to IS_LITTLE_ENDIAN so
  // every field is lane-eligible regardless of host byte order.
  const laneReader = new LiteBinaryReader(buf, { schema: SCHEMA, stride: STRIDE, littleEndian: IS_LITTLE_ENDIAN });
  const L0 = laneReader.laneOf(0); // F64 lane, resolved once outside the loop
  check(L0 !== null, () => 'T6 Gate 4: the F64 field is not lane-eligible -- cannot gate the lane loop');
  const laneBufBytesBefore = laneReader.buffer.byteLength;
  const laneDvBefore = laneReader._dv;
  const laneView = L0.view, laneES = L0.elemStride, laneEO = L0.elemOffset;

  // 4a: the laneOf CALL is 0 B/op -- a pure lookup returning a frozen reference.
  // Reading a numeric field off the returned descriptor forces the call.
  const laneOfHot = (i) => { sink[0] += laneReader.laneOf(i & 7).elemOffset; };
  const g4 = runOpsGate(laneOfHot, { ops: OPS, warmup: WARMUP });
  if (!g4.report.ok) {
    const g = g4.summary.gc;
    die('T6 Gate 4a (laneOf call) ops gate rejected -- verdict=' + g4.report.verdict +
      ' source=' + g4.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
  }
  const g4a = runAllocsGate(laneOfHot, { iterations: 50000, batches: 8 });
  if (!g4a.ok) {
    die('T6 Gate 4a (laneOf call) retained-alloc gate rejected -- verdict=' + g4a.report.verdict +
      ' settled=' + g4a.result.settled + ' bytesPerCall=' + g4a.bytesPerCall);
  }

  // 4b: the lane READ loop view[row*elemStride+elemOffset] is 0 B/op + 0 retained.
  const laneReadHot = (i) => { sink[0] += laneView[(i & MASK) * laneES + laneEO]; };
  const g4b = runOpsGate(laneReadHot, { ops: OPS, warmup: WARMUP });
  check(laneReader.buffer.byteLength === laneBufBytesBefore,
    () => 'T6 Gate 4: buffer.byteLength changed ' + laneBufBytesBefore + ' -> ' + laneReader.buffer.byteLength);
  check(laneReader._dv === laneDvBefore, () => 'T6 Gate 4: the DataView (_dv) was reallocated across the lane window');
  if (!g4b.report.ok) {
    const g = g4b.summary.gc;
    die('T6 Gate 4b (lane read) ops gate rejected -- verdict=' + g4b.report.verdict +
      ' source=' + g4b.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
  }
  const g4c = runAllocsGate(laneReadHot, { iterations: 50000, batches: 8 });
  if (!g4c.ok) {
    die('T6 Gate 4b (lane read) retained-alloc gate rejected -- verdict=' + g4c.report.verdict +
      ' settled=' + g4c.result.settled + ' bytesPerCall=' + g4c.bytesPerCall);
  }

  // --- Gate 5: PROOF that the 64-bit lanes ALLOCATE (the S9 exception) ---------
  // The 8 primitive lanes are 0 B/op retained (Gates 1b/2a/3a/4). The two 64-bit
  // lanes CANNOT be: a JS BigInt is a heap value by spec, so getI64/getU64 (and a
  // BigInt64Array element read) mint one per read -- the second documented
  // exception alongside bytes(). runAllocsGate is a RETENTION detector: transient
  // BigInts die before its post-settle read, so it reports the residue (~0), NOT
  // the allocation. To prove the allocation we RETAIN the values and measure the
  // heap directly: N BigInts kept alive cost heap; the same-shape primitive loop,
  // kept alive in a typed sink, costs essentially none. That gap IS the exception.
  if (typeof globalThis.gc !== 'function') die('T6 Gate 5 requires --expose-gc');
  const N64 = 200000;
  // A 64-bit fixture: one i64 field, host-endian, tightly packed (stride 8).
  const buf64 = new ArrayBuffer(8 * COUNT);
  const dv64 = new DataView(buf64);
  for (let r = 0; r < COUNT; r++) dv64.setBigInt64(r * 8, BigInt(r) * 0x0100000001n - 5n, IS_LITTLE_ENDIAN);
  const r64 = new LiteBinaryReader(buf64, { schema: [{ name: 'i64', type: 8, offset: 0 }], stride: 8, littleEndian: IS_LITTLE_ENDIAN });

  // heapUsed growth of retaining N reads produced by `fill(N)` (its return value
  // is kept alive). gc() after the fill drops transients so only the retained
  // set -- the thing we are pricing -- remains in the delta.
  const growthRetaining = (fill) => {
    globalThis.gc(); globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    const kept = fill(N64);
    globalThis.gc();
    const after = process.memoryUsage().heapUsed;
    keepAlive.push(kept); // pin past the read: no DCE of the priced reads
    return after - before;
  };

  // BigInt arm: retain N getI64 results (each a freshly boxed BigInt).
  const bigintGrowth = growthRetaining((n) => {
    const s = new Array(n);
    for (let k = 0; k < n; k++) s[k] = r64.getI64(k & MASK, 0);
    return s;
  });
  // Primitive arm: the SAME loop shape reading a primitive lane into a typed sink
  // -- no per-element boxing, so the read itself allocates nothing on the heap.
  const primGrowth = growthRetaining((n) => {
    const s = new Float64Array(n);
    for (let k = 0; k < n; k++) s[k] = reader.getU32(k & MASK, 3);
    return s;
  });

  // Teeth 1: retaining N BigInts costs real heap -- far past a 100 KB floor that a
  // non-allocating read could never reach (N=200000 boxed BigInts is multi-MB).
  check(bigintGrowth > 100000,
    () => 'T6 Gate 5: getI64 retained ' + N64 + ' reads but heap grew only ' + bigintGrowth +
      ' B -- expected a BigInt allocation per read');
  // Teeth 2: the 64-bit path costs strictly more heap than the identical-shape
  // primitive path -- the delta is the per-read BigInt boxing, isolated.
  check(bigintGrowth > primGrowth,
    () => 'T6 Gate 5: getI64 heap growth ' + bigintGrowth + ' B did not exceed the primitive path ' +
      primGrowth + ' B -- the BigInt allocation is not being observed');

  // --- Gate 6 (S10): the per-field-endianness read path is still 0 B/op --------
  // The per-field getters read `_leOf[id]` (a Uint8Array index) instead of a single
  // `_le` flag. That index allocates nothing, but a MIXED-endian reader -- where
  // some fields are OPPOSITE the host -- exercises the byte-swapping DataView path
  // on the primitive lanes. Gate it exactly like Gate 1: an interleaved BE/LE
  // schema over the same buffer must read at 0 B/op through both channels.
  const mixSchema = [
    { name: 'f64', type: 1, offset: 0, littleEndian: false },  // BE
    { name: 'f32', type: 0, offset: 8, littleEndian: true },   // LE
    { name: 'i32', type: 2, offset: 12, littleEndian: false }, // BE
    { name: 'u32', type: 5, offset: 16, littleEndian: true },  // LE
    { name: 'i16', type: 3, offset: 20, littleEndian: false }, // BE
    { name: 'u16', type: 6, offset: 22, littleEndian: true },  // LE
    { name: 'i8', type: 4, offset: 24 },                       // agnostic
    { name: 'u8', type: 7, offset: 25 },                       // agnostic
  ];
  const mixReader = new LiteBinaryReader(buf, { schema: mixSchema, stride: STRIDE });
  const mixHot = (i) => {
    const idx = i & MASK;
    sink[0] += mixReader.getF64(idx, 0) + mixReader.getF32(idx, 1) + mixReader.getI32(idx, 2) +
      mixReader.getU32(idx, 3) + mixReader.getI16(idx, 4) + mixReader.getU16(idx, 5) +
      mixReader.getI8(idx, 6) + mixReader.getU8(idx, 7) + mixReader.get(idx, 0);
    if (BREAK) leak.push(new Float64Array(64));
  };
  const g6 = runOpsGate(mixHot, { ops: OPS, warmup: WARMUP });
  if (!g6.report.ok && !BREAK) {
    die('T6 Gate 6 (mixed-endian) ops gate rejected -- verdict=' + g6.report.verdict +
      ' (seed-independent; the per-field read path must be 0 B/op)');
  }
  const g6a = runAllocsGate(mixHot, { iterations: 50000, batches: 8 });
  if (!g6a.ok && !BREAK) {
    die('T6 Gate 6 (mixed-endian) retained-alloc gate rejected -- verdict=' + g6a.report.verdict +
      ' bytesPerCall=' + g6a.bytesPerCall +
      ' violations=' + g6a.report.violations.length);
  }

  // --- Gate 7 (S12): the row iterator -- 0 B/op PER next() ---------------------
  // The hand-written iterator (NOT a generator: a generator mints a fresh
  // IteratorResult per yield, which is exactly the allocation this gate would
  // catch) re-yields ONE result record and fills a caller-owned sink via readRow.
  // Per-row cost -- one it.next() call -- must be 0 B/op through both channels.
  // COUNT_IT is sized so ONE long-lived iterator survives the whole ops window
  // (warmup+ops calls) without exhausting; the alloc window (warmup+batches*iters)
  // is far larger and WILL exhaust mid-window -- the post-exhaust done path is
  // itself 0-alloc, so that is not a problem for the gate, only re-armed before
  // each window starts so every window begins at row 0.
  const COUNT_IT = 1 << 16; // 65536; strictly more than (WARMUP+OPS) = 62000
  const bufIt = new ArrayBuffer(STRIDE * COUNT_IT);
  const dvIt = new DataView(bufIt);
  for (let r = 0; r < COUNT_IT; r++) {
    const b = r * STRIDE;
    dvIt.setFloat64(b + 0, r * 1.5 - 3.25, true);
    dvIt.setFloat32(b + 8, (r & 255) + 0.5, true);
    dvIt.setInt32(b + 12, r - 2048, true);
    dvIt.setUint32(b + 16, (r * 7 + 1) >>> 0, true);
    dvIt.setInt16(b + 20, (r & 0xffff) - 32768, true);
    dvIt.setUint16(b + 22, (r * 3) & 0xffff, true);
    dvIt.setInt8(b + 24, (r & 0xff) - 128);
    dvIt.setUint8(b + 25, r & 0xff);
  }
  const reader7 = new LiteBinaryReader(bufIt, { schema: SCHEMA, stride: STRIDE });

  const itSink = new Array(8); // ONE caller-owned sink, resolved outside the hot closure
  let it = reader7.rows(itSink); // ONE iterator, resolved outside the hot closure

  const iterBufBytesBefore = reader7.buffer.byteLength;
  const iterDvBefore = reader7._dv;

  // The hot body: one next() per call, touching a value so the read cannot be
  // dead-code-eliminated. `it` is re-armed (never re-created inside the body).
  const iterHot = () => {
    const r = it.next();
    if (!r.done) sink[0] += r.value[0];
  };

  const g7 = runOpsGate(iterHot, { ops: OPS, warmup: WARMUP });
  check(itSink.length === 8, () => 'T6 Gate 7: the iterator sink grew to length ' + itSink.length);
  check(reader7.buffer.byteLength === iterBufBytesBefore,
    () => 'T6 Gate 7: buffer.byteLength changed ' + iterBufBytesBefore + ' -> ' + reader7.buffer.byteLength);
  check(reader7._dv === iterDvBefore, () => 'T6 Gate 7: the DataView (_dv) was reallocated across the iterator window');
  if (!g7.report.ok) {
    const g = g7.summary.gc;
    die('T6 Gate 7 (row iterator) ops gate rejected -- verdict=' + g7.report.verdict +
      ' source=' + g7.summary.source + ' major=' + g.major + ' maxMs=' + g.maxMs.toFixed(3));
  }

  // Re-arm between windows: the alloc window below runs warmup(=iterations) +
  // batches*iterations next() calls, far more than COUNT_IT, and WILL exhaust
  // partway through -- by design (the post-exhaust done path is also 0-alloc).
  it = reader7.rows(itSink);
  const g7a = runAllocsGate(iterHot, { iterations: 50000, batches: 8 });
  check(itSink.length === 8, () => 'T6 Gate 7: the iterator sink grew to length ' + itSink.length + ' during the alloc window');
  if (!g7a.ok) {
    die('T6 Gate 7 (row iterator) retained-alloc gate rejected -- verdict=' + g7a.report.verdict +
      ' settled=' + g7a.result.settled + ' bytesPerCall=' + g7a.bytesPerCall +
      ' violations=' + g7a.report.violations.length);
  }
}
