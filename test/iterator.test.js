/**
 * @zakkster/lite-binary-reader -- S12 row iterator boundary suite (node:test).
 *
 * `rows(out)` / `[Symbol.iterator]` are a HAND-WRITTEN iterator (not a generator:
 * a generator mints a fresh IteratorResult per yield, failing the zero-alloc
 * torture gate -- see test/torture/t6-alloc.mjs Gate 7 and its t9 control). This
 * suite pins the boundary matrix a hand-written, mutate-and-reuse iterator must
 * get right: 0/1/N-1/N/N+1 rows, empty/null/undefined/too-short sinks, NaN/-0
 * cell fidelity (Object.is), duplicate exhaustion ("duplicate dispose"),
 * break-during-iteration, independent concurrent counters, re-entrant reads, and
 * a length-shrink adversarial case the S12 planner did not call out by name.
 *
 * Oracle: every cell is checked against a direct DataView read with Object.is,
 * so a NaN or -0 regression cannot slip past a loose `===`/`==` comparison.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LiteBinaryReader, LiteBinaryReaderError, T_F64, T_U32, T_U64,
} from '../Reader.js';

/** Assert `fn` throws a LiteBinaryReaderError carrying exactly `code`. */
function assertCode(fn, code) {
  assert.throws(fn, (e) => e instanceof LiteBinaryReaderError && e.code === code,
    'expected a LiteBinaryReaderError with code ' + code);
}

/** A 2-field (f64, u32) fixture of `n` rows. Row `r`'s f64 cell cycles through
 *  a small table that DELIBERATELY includes -0 (row 0) and NaN (row 2), so any
 *  fixture size >= 1 already exercises at least the -0 boundary. */
const F64VALS = [-0, 1.5, NaN, -3.25, 42];
function fixture(n) {
  const schema = [
    { name: 'f64', type: T_F64, offset: 0 },
    { name: 'u32', type: T_U32, offset: 8 },
  ];
  const stride = 16;
  const buf = new ArrayBuffer(stride * n);
  const dv = new DataView(buf);
  for (let r = 0; r < n; r++) {
    dv.setFloat64(r * stride + 0, F64VALS[r % F64VALS.length], true);
    dv.setUint32(r * stride + 8, (r * 1000 + 7) >>> 0, true);
  }
  const reader = new LiteBinaryReader(buf, { schema, stride });
  return { reader, dv, stride, n };
}

/** Independent oracle: read row `r`'s cells straight off the DataView. */
function oracleRow(dv, stride, r) {
  return [dv.getFloat64(r * stride + 0, true), dv.getUint32(r * stride + 8, true)];
}

// --- 1: bare for-of, full-sweep cell fidelity (incl. NaN / -0) --------------

test('bare `for (const r of reader)` yields exactly count rows, cell-identical to the oracle (NaN/-0 via Object.is)', () => {
  const N = 5;
  const { reader, dv, stride } = fixture(N);
  let seen = 0;
  for (const r of reader) {
    const [of64, ou32] = oracleRow(dv, stride, seen);
    assert.ok(Object.is(r[0], of64), 'row ' + seen + ' f64 mismatch: ' + r[0] + ' vs ' + of64);
    assert.equal(r[1], ou32, 'row ' + seen + ' u32 mismatch');
    seen++;
  }
  assert.equal(seen, N);
});

test('a count=1 reader yields exactly ONE row (the "1" boundary)', () => {
  const { reader, dv, stride } = fixture(1);
  const seen = [...reader];
  assert.equal(seen.length, 1);
  const [of64, ou32] = oracleRow(dv, stride, 0); // row 0 is the -0 fixture cell
  assert.ok(Object.is(seen[0][0], of64));
  assert.ok(Object.is(seen[0][0], -0));
  assert.equal(seen[0][1], ou32);
});

// --- 2: rows(sink) borrows the CALLER's sink, filled correctly every row ----

test('rows(sink) yields the SAME caller-owned sink reference every row and fills it correctly', () => {
  const N = 4;
  const { reader, dv, stride } = fixture(N);
  const sink = new Array(2);
  let seen = 0;
  let firstRef = null;
  for (const r of reader.rows(sink)) {
    if (firstRef === null) firstRef = r;
    assert.equal(r, firstRef, 'the yielded reference changed across rows');
    assert.equal(r, sink, 'the yielded value is not the caller-owned sink');
    const [of64, ou32] = oracleRow(dv, stride, seen);
    assert.ok(Object.is(r[0], of64));
    assert.equal(r[1], ou32);
    seen++;
  }
  assert.equal(seen, N);
});

// --- 3: borrowed-array aliasing is real, documented behavior ----------------

test('[...reader] yields N references to ONE reader-owned array; Array.from(reader, r=>r.slice()) materializes distinct rows', () => {
  const N = 3;
  const { reader, dv, stride } = fixture(N);
  const spread = [...reader];
  assert.equal(spread.length, N);
  assert.equal(spread[0], spread[1], 'a bare sweep must alias ONE array across rows');
  assert.equal(spread[1], spread[2]);
  // after the sweep the ONE shared array holds the LAST row's values.
  const [lastF64, lastU32] = oracleRow(dv, stride, N - 1);
  assert.ok(Object.is(spread[0][0], lastF64));
  assert.equal(spread[0][1], lastU32);

  const materialized = Array.from(reader, (r) => r.slice());
  assert.equal(materialized.length, N);
  assert.notEqual(materialized[0], materialized[1], 'slice() must copy, not alias');
  for (let r = 0; r < N; r++) {
    const [of64, ou32] = oracleRow(dv, stride, r);
    assert.ok(Object.is(materialized[r][0], of64), 'materialized row ' + r + ' f64');
    assert.equal(materialized[r][1], ou32, 'materialized row ' + r + ' u32');
  }
});

// --- 4: empty reader (count 0) -----------------------------------------------

test('an empty reader (count 0) yields nothing from either iteration form (the "0" boundary)', () => {
  const schema = [{ name: 'f64', type: T_F64, offset: 0 }, { name: 'u32', type: T_U32, offset: 8 }];
  const buf = new ArrayBuffer(16);
  const empty = new LiteBinaryReader(buf, { schema, stride: 16, count: 0 });
  assert.equal(empty.count, 0);

  let n1 = 0;
  for (const _r of empty) n1++;
  assert.equal(n1, 0);

  const sink = new Array(2);
  let n2 = 0;
  for (const _r of empty.rows(sink)) n2++;
  assert.equal(n2, 0);

  // the FIRST next() call is immediately done: no off-by-one before exhaustion.
  const it = empty[Symbol.iterator]();
  const r = it.next();
  assert.equal(r.done, true);
  assert.equal(r.value, undefined);
});

// --- 5: two concurrent iterators have INDEPENDENT counters ------------------

test('two concurrent rows(sink) iterators over the same reader have INDEPENDENT row counters', () => {
  const N = 5;
  const { reader, dv, stride } = fixture(N);
  const sinkA = new Array(2), sinkB = new Array(2);
  const itA = reader.rows(sinkA);
  const itB = reader.rows(sinkB);
  itA.next(); itA.next(); itA.next(); // advance A three rows (0,1,2)
  const rb = itB.next();              // B must still start at row 0
  const [b0f64, b0u32] = oracleRow(dv, stride, 0);
  assert.ok(Object.is(rb.value[0], b0f64));
  assert.equal(rb.value[1], b0u32);
  const ra = itA.next();              // A continues from row 3
  const [a3f64, a3u32] = oracleRow(dv, stride, 3);
  assert.ok(Object.is(ra.value[0], a3f64));
  assert.equal(ra.value[1], a3u32);
});

test('two bare `for...of` sweeps over the same reader use INDEPENDENT reader-owned sinks', () => {
  const N = 3;
  const { reader } = fixture(N);
  const it1 = reader[Symbol.iterator]();
  const it2 = reader[Symbol.iterator]();
  const r1 = it1.next();
  const r2 = it2.next();
  assert.notEqual(r1.value, r2.value, 'two independent bare sweeps must not share one sink array');
});

// --- 6: done flips exactly at count; N / N+1 / duplicate exhaustion ---------

test('done flips exactly at count; .value is undefined after; further next() (N, N+1, N+2...) stays done with 0 side effects on the sink', () => {
  const N = 3;
  const { reader, dv, stride } = fixture(N);
  const sink = new Array(2);
  const it = reader.rows(sink);
  for (let i = 0; i < N; i++) {
    const r = it.next();
    assert.equal(r.done, false, 'row ' + i + ' (< N) should not be done');
  }
  const [lastF64, lastU32] = oracleRow(dv, stride, N - 1);
  assert.ok(Object.is(sink[0], lastF64));
  assert.equal(sink[1], lastU32);

  // the call immediately AT row index N: done flips here, not before / after.
  const rN = it.next();
  assert.equal(rN.done, true);
  assert.equal(rN.value, undefined);

  // duplicate exhaustion ("duplicate dispose"): N+1, N+2, N+3 calls all stay
  // done, and the SINK (the caller-owned array) is left untouched -- 0 side
  // effects once exhausted.
  for (let i = 0; i < 3; i++) {
    const r = it.next();
    assert.equal(r.done, true, 'post-exhaustion call ' + i + ' must stay done');
    assert.equal(r.value, undefined);
  }
  assert.ok(Object.is(sink[0], lastF64), 'sink f64 mutated after exhaustion');
  assert.equal(sink[1], lastU32, 'sink u32 mutated after exhaustion');
});

// --- 7/8: fail closed -- null / undefined / too-short / empty sinks ----------

test('fail closed: rows(null) and rows(undefined) throw R_BAD_LENGTH -- surfaced on the FIRST next(), not eagerly at rows()', () => {
  const { reader } = fixture(2);
  for (const bad of [null, undefined]) {
    let it;
    assert.doesNotThrow(() => { it = reader.rows(bad); }, 'rows(' + bad + ') must not throw eagerly');
    assertCode(() => it.next(), 'R_BAD_LENGTH');
  }
});

test('fail closed: a too-short sink (including an empty one) throws R_BAD_LENGTH on the first next()', () => {
  const { reader } = fixture(2); // fieldCount = 2
  let it1;
  assert.doesNotThrow(() => { it1 = reader.rows(new Array(1)); }); // length 1 < 2
  assertCode(() => it1.next(), 'R_BAD_LENGTH');

  let it2;
  assert.doesNotThrow(() => { it2 = reader.rows([]); }); // the "empty" boundary
  assertCode(() => it2.next(), 'R_BAD_LENGTH');
});

// --- 9: NOT a generator; the returned iterator re-yields ONE record ---------

test('rows/[Symbol.iterator] are plain functions (not generators); the returned iterator re-yields ONE record reference', () => {
  assert.equal(LiteBinaryReader.prototype.rows.constructor.name, 'Function');
  assert.equal(LiteBinaryReader.prototype[Symbol.iterator].constructor.name, 'Function');
  const { reader } = fixture(3);
  const sink = new Array(2);
  const it = reader.rows(sink);
  const r1 = it.next();
  const r2 = it.next();
  assert.equal(r1, r2, 'two successive next() calls must return the SAME record object');
  assert.equal(it[Symbol.iterator](), it, 'the iterator must be its own [Symbol.iterator]()');
});

// --- 10: 64-bit row -- bigint cell, and a TypedArray sink's documented throw -

test('a 64-bit field yields a bigint cell into an Array sink; a Float64Array sink throws on the bigint write', () => {
  const schema = [
    { name: 'f64', type: T_F64, offset: 0 },
    { name: 'u64', type: T_U64, offset: 8 },
  ];
  const stride = 16;
  const buf = new ArrayBuffer(stride * 2);
  const dv = new DataView(buf);
  dv.setFloat64(0, 1.25, true);
  dv.setBigUint64(8, 0xdeadbeefcafebaben, true);
  dv.setFloat64(16, -2.5, true);
  dv.setBigUint64(24, 1n, true);
  const reader = new LiteBinaryReader(buf, { schema, stride });

  const arrSink = new Array(2);
  const it = reader.rows(arrSink);
  const r0 = it.next();
  assert.equal(typeof r0.value[1], 'bigint');
  assert.equal(r0.value[1], 0xdeadbeefcafebaben);
  assert.ok(Object.is(r0.value[0], 1.25));

  const f64Sink = new Float64Array(2);
  const it2 = reader.rows(f64Sink);
  assert.throws(() => it2.next(), TypeError);
});

// --- 11: dispose-during-iteration -- break early, no Symbol.dispose/.return -

test('breaking a `for...of` early does not close or corrupt the iterator (no .return by design); next() resumes exactly where it left off', () => {
  const N = 5;
  const { reader, dv, stride } = fixture(N);
  const sink = new Array(2);
  const it = reader.rows(sink);
  let seen = 0;
  for (const _r of it) {
    seen++;
    if (seen === 2) break; // "dispose"-during-iteration: stop consuming early
  }
  assert.equal(seen, 2);
  // this iterator implements no .return -- a `break` is a no-op on its state.
  assert.equal(typeof it.return, 'undefined');
  const r3 = it.next(); // resumes at row index 2 (the 3rd row), not reset to 0
  const [of64, ou32] = oracleRow(dv, stride, 2);
  assert.ok(Object.is(r3.value[0], of64));
  assert.equal(r3.value[1], ou32);
});

// --- 12: adversarial -- shrinking the sink mid-sweep (re-validated per row) -

test('adversarial: shrinking the sink length mid-sweep throws R_BAD_LENGTH on the NEXT call -- readRow re-validates every row, not only at rows()', () => {
  const N = 4;
  const { reader } = fixture(N);
  const sink = new Array(2);
  const it = reader.rows(sink);
  const r0 = it.next();
  assert.equal(r0.done, false);
  sink.length = 1; // shrink below fieldCount AFTER a successful row
  assertCode(() => it.next(), 'R_BAD_LENGTH');
});

// --- 13: re-entrant read -- a nested independent sweep must not disturb -----
// --- the outer sweep's row counter (each _rowIter closes over its OWN `row`) -

test('re-entrant read: sweeping the SAME reader again from inside the loop body does not disturb the outer sweep', () => {
  const N = 4;
  const { reader } = fixture(N);
  const outerSink = new Array(2);
  let outerSeen = 0;
  for (const _r of reader.rows(outerSink)) {
    outerSeen++;
    let innerSeen = 0;
    const innerSink = new Array(2);
    for (const _inner of reader.rows(innerSink)) innerSeen++;
    assert.equal(innerSeen, N, 'the nested, independent sweep did not see all rows');
  }
  assert.equal(outerSeen, N, 'the outer sweep was disturbed by the re-entrant inner sweep');
});
