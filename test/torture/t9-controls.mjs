/**
 * t9 -- controls. Every gate must be provably able to fail.
 *
 * Each control runs a deliberately-broken variant IN PROCESS and asserts the
 * corresponding gate flags it. Where it matters a control also proves
 * non-vacuity: the checker returns clean on a genuinely valid input, so "flags
 * the broken one" is a real property and not a checker that flags everything.
 *
 * The whole-suite control lives in T6: LBR_TORTURE_BREAK=1 injects a retained
 * allocation into the T6 hot loop, the alloc gate rejects it, and the process
 * exits non-zero; the torture entry then re-checks that BREAK actually tripped.
 * Control 1 below exercises the same alloc lane in-process so a plain
 * `npm run torture` already proves the gate bites.
 */

import { LiteBinaryReader, IS_LITTLE_ENDIAN, T_F64, T_U8 } from '../../Reader.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import {
  runOpsGate, runAllocsGate, checkCoherence, oracleRead, censusOk,
  check, die, todoIds, ALLOC_RULES, MIN_HEAP_OBJECT_BYTES,
} from './harness.mjs';

const NOOP = function () {};

/** Retained sink so a control's allocations survive GC (arrayBuffers grows). */
const leak = [];
const retainSink = [];

// S2 fixed BR-01..BR-06 and PROMOTED each reproduced-todo to an enforced coded
// door in t2, so the reproduced-todo registry is now EMPTY.
const EXPECTED_TODOS = [];

export function run() {
  // --- Control 1: the ops gate. A hot body that retains an allocation every
  // iteration MUST be rejected by runOpsGate (maxArrayBuffersGrowth:0). ---------
  const { report } = runOpsGate(() => { leak.push(new Float64Array(64)); }, { ops: 4000, warmup: 0 });
  if (report.ok) die('t9 control 1: an allocating hot loop passed the zero-alloc ops gate');
  leak.length = 0;

  // --- Control 2: the retained-alloc gate (runAllocsGate + ALLOC_RULES), the
  // async-gc channel runOpsGate is blind to. A `get` that boxes its result as
  // {v} retains one plain object/iteration and MUST fail; a preallocated-slot
  // body that writes without retaining MUST pass (non-vacuity); and the shared
  // budget stays strictly below one heap object. ------------------------------
  const c2Retain = runAllocsGate((i) => { retainSink.push({ v: i }); }, { iterations: 50000, batches: 8 });
  if (c2Retain.ok) {
    die('t9 control 2a: a get() returning {v} passed the retained-alloc gate -- bytesPerCall=' + c2Retain.bytesPerCall);
  }
  retainSink.length = 0;
  const slot = new Array(1);
  const c2NoRetain = runAllocsGate((i) => { slot[0] = i; }, { iterations: 50000, batches: 8 });
  if (!c2NoRetain.ok) {
    die('t9 control 2b: a non-retaining preallocated-slot body failed the retained-alloc gate -- verdict=' +
      c2NoRetain.report.verdict + ' settled=' + c2NoRetain.result.settled + ' bytesPerCall=' + c2NoRetain.bytesPerCall);
  }
  check(ALLOC_RULES.maxBytesPerCall < MIN_HEAP_OBJECT_BYTES,
    () => 't9 control 2c: ALLOC_RULES.maxBytesPerCall ' + ALLOC_RULES.maxBytesPerCall +
      ' is not below MIN_HEAP_OBJECT_BYTES ' + MIN_HEAP_OBJECT_BYTES);

  // --- Control 3: the dropped-_le control. A BE reader read with the flag
  // dropped (le=true) yields byte-swapped garbage. The correct getF64 matches the
  // BE oracle (non-vacuity); a le-dropping read diverges from it (teeth). --------
  const leBuf = new ArrayBuffer(8);
  const leDv = new DataView(leBuf);
  leDv.setFloat64(0, 6.283185307179586, false); // stored big-endian, an asymmetric value
  const beReader = new LiteBinaryReader(leBuf, { schema: [{ name: 'x', type: T_F64, offset: 0 }], littleEndian: false });
  const oracleBe = oracleRead(leDv, 1, 0, false);
  if (!Object.is(beReader.getF64(0, 0), oracleBe)) {
    die('t9 control 3: a correct BE getF64 did not match the BE oracle (vacuous/broken)');
  }
  const droppedLe = oracleRead(leDv, 1, 0, true); // the bug: read LE, ignoring _le=false
  if (Object.is(droppedLe, oracleBe)) {
    die('t9 control 3: a dropped-_le read did not diverge from the BE oracle (no teeth) -- value is endian-symmetric');
  }

  // --- Control 4: the no-translate LBK1 control (the D3 collision). An LBK1 U32
  // lane (lane_kind 3) must be TRANSLATED to our T_U32 (5). fromLBK1Shard does so
  // and reads the index exactly (non-vacuity); a reader that skips translation and
  // trusts lane_kind 3 as our type code reads it as I16 -- wrong bytes (teeth). --
  const shBuf = new ArrayBuffer(12);
  const shDv = new DataView(shBuf);
  shDv.setFloat64(0, -9.5, true);
  shDv.setUint32(8, 0xdeadbeef, true); // a big index that I16 cannot represent
  const shard = {
    bytes: shBuf,
    rowStride: 12,
    fields: [
      { name: 'v', laneKind: 1, offsetInRow: 0 },
      { name: 's', laneKind: 3, offsetInRow: 8 },
    ],
  };
  const translated = LiteBinaryReader.fromLBK1Shard(shard);
  const oracleU32 = oracleRead(shDv, 5, 8, true);
  if (translated.getU32(0, translated.field('s')) !== oracleU32 || translated.get(0, 1) !== oracleU32) {
    die('t9 control 4: the translated LBK1 U32 lane did not read its index exactly (vacuous/broken)');
  }
  // The bug: use lane_kind 3 directly as our type code (T_I16) -> read as I16.
  const noTranslate = new LiteBinaryReader(shBuf, {
    schema: [{ name: 'v', type: 1, offset: 0 }, { name: 's', type: 3, offset: 8 }], // type 3 = I16, NOT U32
    stride: 12,
    littleEndian: true,
  });
  if (noTranslate.get(0, 1) === oracleU32) {
    die('t9 control 4: a no-translate LBK1 reader read the U32 index correctly (the D3 collision was not exercised)');
  }

  // --- Control 5: the corrupted-oracle control. The T5 differential compares the
  // reader to a DataView oracle. On a clean pair no cell diverges (non-vacuity);
  // corrupting ONE expected value MUST make the same comparison diverge (teeth). -
  const dBuf = new ArrayBuffer(8 * 16);
  const dDv = new DataView(dBuf);
  for (let i = 0; i < 16; i++) dDv.setFloat64(i * 8, i * 1.25 - 3, true);
  const dReader = new LiteBinaryReader(dBuf, { schema: [{ name: 'x', type: T_F64, offset: 0 }] });
  const oracle = new Float64Array(16);
  for (let i = 0; i < 16; i++) oracle[i] = oracleRead(dDv, 1, i * 8, true);
  let cleanDiverges = false;
  for (let i = 0; i < 16; i++) if (!Object.is(dReader.getF64(i, 0), oracle[i])) { cleanDiverges = true; break; }
  if (cleanDiverges) die('t9 control 5: the differential diverged on a clean reader/oracle pair (vacuous/broken)');
  oracle[7] += 1; // corrupt one expected value
  let corruptDiverges = false;
  for (let i = 0; i < 16; i++) if (!Object.is(dReader.getF64(i, 0), oracle[i])) { corruptDiverges = true; break; }
  if (!corruptDiverges) die('t9 control 5: the differential missed a corrupted oracle value (no teeth)');

  // --- Control 6: the checkCoherence non-vacuity pair. Null on a valid input;
  // non-null on each of the BR-01 / BR-02 / BR-03 fabricated inputs. -------------
  const buf64 = new ArrayBuffer(64);
  const okSchema = [{ name: 'x', type: T_F64, offset: 0 }];
  if (checkCoherence(buf64, { schema: okSchema }) !== null) {
    die('t9 control 6: checkCoherence flagged a valid reader input (vacuous/broken)');
  }
  if (checkCoherence(buf64, { schema: okSchema, byteOffset: 1000 }) === null) {
    die('t9 control 6: checkCoherence passed BR-01 (byteOffset past end, derived negative count)');
  }
  if (checkCoherence(buf64, { schema: [{ name: 'a', type: T_U8, offset: 0 }, { name: 'b', type: 2.5, offset: 4 }] }) === null) {
    die('t9 control 6: checkCoherence passed BR-02 (non-integer type 2.5)');
  }
  if (checkCoherence(buf64, { schema: okSchema, byteOffset: NaN }) === null) {
    die('t9 control 6: checkCoherence passed BR-03 (NaN byteOffset)');
  }

  // --- Control 7: the lite-leak witness. A tracked, still-held target reads
  // size() 1 (the gate sees it); untrack returns it to 0 (non-vacuity). ---------
  const t = createLeakTracker({ name: 't9-control' });
  const held = { x: 1 };
  const h = t.track(held, NOOP, 't9');
  if (t.size() !== 1) die('t9 control 7: leak tracker did not see a tracked resource (size != 1)');
  t.untrack(h);
  if (t.size() !== 0) die('t9 control 7: leak tracker did not release on untrack (size != 0)');

  // --- Control 8: the todo registry. S2 fixed BR-01..BR-06 and promoted each
  // reproduced-todo to an enforced coded door in t2, so the registry is now
  // EMPTY. This control asserts the empty set (no todo registered, none leaked). -
  const ids = todoIds().map((s) => s.slice(0, 5)); // ids carry a probe name after the code
  for (const want of EXPECTED_TODOS) {
    if (ids.indexOf(want) === -1) die('t9 control 8: todo ' + want + ' was never registered');
  }
  for (const saw of ids) {
    if (EXPECTED_TODOS.indexOf(saw) === -1) die('t9 control 8: unexpected todo registered: ' + saw);
  }
  if (ids.length !== EXPECTED_TODOS.length) {
    die('t9 control 8: expected ' + EXPECTED_TODOS.length + ' registered todos, saw ' + ids.length);
  }

  // --- Control 9: the T7 reachability census has teeth. lite-leak 1.10.0's
  // size() counts registrations, not reachability, so T7's binding witness is a
  // one-sided WeakRef census. Prove it can fail: a fully PINNED sample (every
  // target still strongly held) is all-live, so censusOk MUST return false. An
  // empty sample is vacuously ok (non-vacuity the other way). The live-collect
  // direction is proven by T7's own passing run. -------------------------------
  const pinnedRefs = [];
  for (let i = 0; i < 64; i++) { const o = { i }; retainSink.push(o); pinnedRefs.push(new WeakRef(o)); }
  globalThis.gc(); // the pinned targets survive it (retainSink holds them)
  if (censusOk(pinnedRefs)) die('t9 control 9: censusOk passed a fully-pinned sample (the census is toothless)');
  retainSink.length = 0;
  if (!censusOk([])) die('t9 control 9: censusOk failed an empty sample (should be vacuously ok)');

  // --- Control 10: the detached-source door (BR-08) has teeth AND is non-vacuous.
  // A LIVE buffer constructs fine (the door does not flag everything); a DETACHED
  // one is rejected with R_BAD_SOURCE (teeth); and `new ArrayBuffer(0)` -- a
  // zero-length but NOT detached buffer -- still constructs with count 0, the
  // discriminator that proves the check keys on detachment, not on byteLength 0. -
  const liveBuf = new ArrayBuffer(64);
  const liveReader = new LiteBinaryReader(liveBuf, { schema: [{ name: 'x', type: T_F64, offset: 0 }] });
  if (liveReader.count !== 8) die('t9 control 10: a live buffer did not construct (count ' + liveReader.count + ' != 8) -- the detached door is vacuous');
  const deadBuf = new ArrayBuffer(64);
  structuredClone(deadBuf, { transfer: [deadBuf] }); // transfers -> detaches deadBuf
  let deadCode = null;
  try { new LiteBinaryReader(deadBuf, { schema: [{ name: 'x', type: T_F64, offset: 0 }] }); }
  catch (e) { deadCode = e && e.code; }
  if (deadCode !== 'R_BAD_SOURCE') die('t9 control 10: a detached buffer was not rejected with R_BAD_SOURCE (got ' + deadCode + ') -- the door has no teeth');
  const emptyBuf = new ArrayBuffer(0);
  let emptyReader = null;
  try { emptyReader = new LiteBinaryReader(emptyBuf, { schema: [{ name: 'x', type: T_U8, offset: 0 }] }); }
  catch (e) { die('t9 control 10: a zero-length (NOT detached) buffer was wrongly rejected as detached (' + (e && e.code) + ')'); }
  if (emptyReader.count !== 0) die('t9 control 10: a zero-length buffer did not derive count 0 (' + emptyReader.count + ')');

  // --- Control 11: the row cursor has teeth. seek(row).f64(0) equals
  // getF64(row,0) on a clean read (non-vacuity); an off-by-one seek diverges from
  // getF64(row,0) (teeth) -- proving the cursor actually keys on _cursor and is
  // not silently reading a fixed row. -------------------------------------------
  const c11Buf = new ArrayBuffer(8 * 16);
  const c11Dv = new DataView(c11Buf);
  for (let i = 0; i < 16; i++) c11Dv.setFloat64(i * 8, i * 3.5 - 2, true); // all distinct
  const c11 = new LiteBinaryReader(c11Buf, { schema: [{ name: 'x', type: T_F64, offset: 0 }] });
  for (let i = 0; i < 16; i++) {
    if (!Object.is(c11.seek(i).f64(0), c11.getF64(i, 0))) {
      die('t9 control 11: seek(' + i + ').f64(0) did not equal getF64(' + i + ',0) (cursor broken/vacuous)');
    }
  }
  let c11Diverged = false;
  for (let i = 0; i < 15; i++) if (!Object.is(c11.seek(i + 1).f64(0), c11.getF64(i, 0))) { c11Diverged = true; break; }
  if (!c11Diverged) die('t9 control 11: an off-by-one cursor seek did not diverge from getF64 (no teeth)');

  // --- Control 12: readRow's length door prevents a measured alloc. Writing 8
  // fields into a too-short (length-0) Array AUTO-GROWS it -- a per-iteration
  // allocation the retained-alloc gate rejects (teeth); writing into a reused
  // length-8 Array retains nothing and passes (non-vacuity). readRow's
  // R_BAD_LENGTH door refuses the length-0 sink up front, so that measured alloc
  // can never happen through the API. ------------------------------------------
  const c12Sink = [];
  const c12Grow = runAllocsGate((i) => {
    const a = []; // a fresh length-0 array
    for (let j = 0; j < 8; j++) a[j] = i + j; // grow 0 -> 8: allocation
    c12Sink.push(a); // retain it so the growth survives a forced collection
  }, { iterations: 50000, batches: 8 });
  if (c12Grow.ok) {
    die('t9 control 12: 8 writes growing a length-0 array passed the retained-alloc gate (no teeth) -- bytesPerCall=' + c12Grow.bytesPerCall);
  }
  c12Sink.length = 0;
  const c12Fixed = new Array(8);
  const c12Ok = runAllocsGate((i) => {
    for (let j = 0; j < 8; j++) c12Fixed[j] = i + j; // no growth, no retain
  }, { iterations: 50000, batches: 8 });
  if (!c12Ok.ok) {
    die('t9 control 12: 8 writes into a reused length-8 array failed the retained-alloc gate (vacuous) -- verdict=' +
      c12Ok.report.verdict + ' settled=' + c12Ok.result.settled + ' bytesPerCall=' + c12Ok.bytesPerCall);
  }

  // --- Control 13: the variable-length bytes(row,id) has teeth. With a
  // lengthField, bytes(row,id) equals bytes(row,id,len) for the sibling's value
  // (non-vacuity); +1 on the length CELL changes the span length by exactly 1
  // (teeth); a length past the buffer throws R_BUFFER_TOO_SMALL. ----------------
  const c13Schema = [
    { name: 'len', type: T_U8, offset: 0 },
    { name: 'blob', type: T_U8, offset: 1, lengthField: 'len' },
  ];
  const c13Buf = new ArrayBuffer(16);
  const c13Dv = new DataView(c13Buf);
  c13Dv.setUint8(0, 4); // len = 4
  for (let k = 0; k < 8; k++) c13Dv.setUint8(1 + k, k + 1);
  const c13 = new LiteBinaryReader(c13Buf, { schema: c13Schema, count: 1 });
  const c13Auto = c13.bytes(0, 1);
  const c13Explicit = c13.bytes(0, 1, 4);
  if (c13Auto.length !== 4 || c13Explicit.length !== 4) {
    die('t9 control 13: bytes(row,id) length did not match the lengthField value (vacuous/broken)');
  }
  for (let k = 0; k < 4; k++) if (c13Auto[k] !== c13Explicit[k]) die('t9 control 13: 2-arg and 3-arg bytes spans diverged (vacuous/broken)');
  c13Dv.setUint8(0, 5); // bump the length cell by 1
  if (c13.bytes(0, 1).length !== 5) die('t9 control 13: bumping the length cell did not change the span length (no teeth)');
  c13Dv.setUint8(0, 255); // a length far past the 16-byte buffer
  let c13Code = null;
  try { c13.bytes(0, 1); } catch (e) { c13Code = e && e.code; }
  if (c13Code !== 'R_BUFFER_TOO_SMALL') die('t9 control 13: a length past the buffer did not throw R_BUFFER_TOO_SMALL (got ' + c13Code + ')');
}
