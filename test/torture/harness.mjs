/**
 * @zakkster/lite-binary-reader -- torture harness (the shared spine).
 *
 * Modeled directly on ../LiteBake/test/torture/harness.mjs -- the same four
 * disciplines are enforced here in one place so no tier can drift from them:
 *
 *   1. SCRATCH ONCE. All scratch is allocated by the tier OUTSIDE every loop.
 *      This module hands out helpers and gate wrappers, never per-call
 *      allocations on a measured hot path.
 *   2. FAILURE-ONLY MESSAGES. `check(cond, msgThunk)` builds its string ONLY on
 *      failure -- a template literal per iteration is an allocation and would
 *      fail the T6 gate. Pass a thunk, never a pre-built string.
 *   3. SEEDED REPLAY. The PRNG is a seeded xorshift32 (`TORTURE_SEED` env with a
 *      0-guard to 1). Every failing message can carry the seed so a case replays
 *      via `TORTURE_SEED=... node --expose-gc test/torture.mjs`.
 *   4. ONE MEASUREMENT WINDOW AT A TIME. lite-gc-profiler shares one heap across
 *      lanes; `runOpsGate` opens and closes a single window per call and tiers
 *      run strictly sequentially -- never nested, never concurrent.
 *
 * RULES is the base zero-GC budget. `maxArrayBuffersGrowth` gates net growth of
 * ArrayBuffer backing stores, which live OUTSIDE the V8 heap and are invisible
 * to a heapUsed gate -- exactly the memory this package reads through (one buffer
 * + one DataView). It requires measureOps `stabilize:'deep'`, which `runOpsGate`
 * supplies. A budget that moves is not a gate: RULES never widens to pass.
 *
 * checkNoGc accepts ONLY its six rules; passing `maxBytesPerCall` to it THROWS.
 * So RULES (checkNoGc) and ALLOC_RULES (checkAllocs) are SEPARATE objects and
 * never share a key.
 *
 * @license MIT
 */

import { measureOps, checkNoGc, measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
  const raw = process.env.TORTURE_SEED;
  if (raw === undefined) return 0x9e3779b9;
  const n = Number(raw) >>> 0;
  return n === 0 ? 1 : n; // xorshift32 must not be seeded with 0
})();

/** Deliberately-broken control mode: injects a retained allocation into the T6 hot loop. */
export const BREAK = process.env.LBR_TORTURE_BREAK === '1';

/** Base zero-GC rules. maxArrayBuffersGrowth needs measureOps `stabilize:'deep'`. */
export const RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/**
 * Smallest object V8 can place on the heap. One genuinely-retaining allocation
 * per call therefore costs AT LEAST this many bytes per call -- the floor of any
 * real retention regression. The retained-alloc budget sits strictly below it.
 */
export const MIN_HEAP_OBJECT_BYTES = 16;

/**
 * The zero-RETENTION rule for the retained-alloc gate, shared by the T6 gate and
 * its T9 control so the control can never drift from the gate it proves.
 * maxBytesPerCall counts per-call bytes surviving a forced collection, taken as
 * the MIN across batches. This is the channel runOpsGate cannot see: Node
 * delivers 'gc' PerformanceObserver entries ASYNCHRONOUSLY, so measureOps'
 * synchronous gc.major read can be 0 on a loop retaining plain (non-ArrayBuffer)
 * objects -- exactly what a buggy `get` returning `{value}` would do. The budget
 * is 1 B/call (the suite's documented minimum discriminating value): strictly
 * below one heap object, strictly above measurement noise. It never widens.
 */
export const ALLOC_RULES = { maxBytesPerCall: 1 };

/**
 * Width in bytes per type code, indexed by the code itself. A local copy so the
 * harness imports nothing from the source on the door-invariant path. Kept in
 * lock-step with Reader.js's TYPE_BYTES by the T5 drift note.
 *   F32=0, F64=1, I32=2, I16=3, I8=4, U32=5, U16=6, U8=7, I64=8, U64=9
 */
export const TYPE_BYTES = [4, 8, 4, 2, 1, 4, 2, 1, 8, 8];

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
  let x = (seed >>> 0) || 1;
  return function next() {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x >>> 0;
  };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
  process.stderr.write('torture: FAIL -- ' + msg + '\n');
  process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure. Pass a thunk, not a string,
 * so the happy path allocates nothing.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
  if (!cond) die(msgThunk());
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * Uses measureOps with `stabilize:'deep'` so the `maxArrayBuffersGrowth` rule is
 * resolvable (ArrayBuffer backing stores live outside the V8 heap). Returns the
 * checkNoGc report plus the raw summary for diagnostics.
 *
 * @param {(i:number)=>void} fn      Sync, zero-alloc hot body.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
  const res = measureOps(fn, {
    ops: opts.ops,
    warmup: opts.warmup === undefined ? 0 : opts.warmup,
    stabilize: 'deep',
  });
  return { report: checkNoGc(res.summary, RULES), summary: res.summary };
}

/**
 * Measure per-call RETAINED allocation (bytes surviving a forced collection,
 * min-over-batches) and gate it against ALLOC_RULES. Requires --expose-gc.
 * This is the binding retention channel the async-gc runOpsGate trio cannot
 * provide. An inconclusive verdict OR an unsettled batch set is a FAIL here,
 * never a skip: `ok` is true only on a settled "pass".
 *
 * @param {(i:number)=>void} fn      Sync hot body under measurement.
 * @param {{iterations:number, batches?:number, warmup?:number}} opts
 */
export function runAllocsGate(fn, opts) {
  const iterations = opts.iterations;
  const result = measureAllocs(fn, {
    iterations,
    batches: opts.batches === undefined ? 8 : opts.batches,
    warmup: opts.warmup === undefined ? iterations : opts.warmup,
  });
  const report = checkAllocs(result, ALLOC_RULES);
  const ok = report.verdict === 'pass' && result.settled === true;
  return { report, result, bytesPerCall: result.bytesPerCall, ok };
}

/* -------------------------------------------------------------------------- *
 * Reachability census -- the retention witness lite-leak's size() is NOT.
 *
 * lite-leak 1.10.0: `tracker.size()` counts live REGISTRATIONS, not
 * reachability, and the docs say to pair it with a WeakRef census. A soak that
 * track()s then untrack()s in the same cycle and asserts size()===0 proves only
 * that untrack() decrements a counter -- it never observes whether the subject
 * was actually collected. That is a green light over a hole (the AR-02 lesson).
 *
 * censusOk is the ONE-SIDED reachability check LiteQuery's phase H uses: given
 * WeakRefs whose targets SHOULD have been collected, it returns true UNLESS every
 * sampled ref is still live -- which only happens when something pins them all (a
 * real retention leak). It tolerates GC nondeterminism (any individual ref may
 * survive a given settle) while still failing closed on total retention. An empty
 * sample is vacuously ok; callers gate that the sample is non-trivial.
 * -------------------------------------------------------------------------- */
export function censusOk(refs) {
  if (refs.length === 0) return true;
  let live = 0;
  for (let i = 0; i < refs.length; i++) if (refs[i].deref() !== undefined) live++;
  return live !== refs.length; // fail only if ALL are still live (a pinned set)
}

/** Force several GC settle cycles so transient refs clear before a census read. */
export async function settleGc(cycles) {
  const n = cycles === undefined ? 4 : cycles;
  for (let i = 0; i < n; i++) {
    globalThis.gc();
    await new Promise((r) => setTimeout(r, 20));
  }
}

/* -------------------------------------------------------------------------- *
 * checkCoherence -- the door-invariant EVIDENCE function (ROADMAP section 2).
 *
 * A cold-path checker (the analogue of lite-bake's checkLayout). It takes the
 * SAME (source, options) a LiteBinaryReader constructor takes and returns a
 * STRING naming the FIRST violated door invariant, or null if the input is
 * coherent. It never throws and never constructs a reader.
 *
 * The invariant it enforces is exactly the one in ROADMAP section 2 that catches
 * BR-01, BR-02 and BR-03 at once (plus the BR-04 name-uniqueness line, which the
 * read-fidelity bijection needs):
 *
 *   0 <= base  AND  base <= buffer.byteLength                         (BR-01, BR-03)
 *   count is a non-negative integer AND base + count*stride <= len    (BR-01)
 *   for every field f:
 *     Number.isInteger(type[f]) AND 0 <= type[f] < 10                  (BR-02)
 *     Number.isInteger(offset[f]) AND offset[f] >= 0
 *     offset[f] + TYPE_BYTES[type[f]] <= stride                       (BR-02 stride)
 *     littleEndian[f] === undefined OR typeof littleEndian[f] === 'boolean' (S10)
 *
 * T2 asserts it returns null on every valid input; T9 asserts it returns
 * non-null on hand-fabricated BR-01/BR-02/BR-03 inputs (non-vacuity).
 * -------------------------------------------------------------------------- */
/**
 * Local detached-buffer probe. The harness imports NOTHING from Reader.js on the
 * door-invariant path (by rule), so it re-derives the constructor's BR-08 check
 * independently. A detached buffer reports byteLength 0 yet is `instanceof
 * ArrayBuffer`; a legitimately zero-length buffer is NOT detached. Only length 0
 * is ambiguous.
 */
const HAS_DETACHED = typeof Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'detached') === 'object';
function bufferIsDetached(buffer) {
  if (buffer.byteLength > 0) return false;
  if (HAS_DETACHED) return buffer.detached === true;
  try { new DataView(buffer); return false; } catch (e) { return true; }
}

export function checkCoherence(source, options) {
  if (!options || typeof options !== 'object') return 'options with a schema are required';

  // --- resolve the buffer length exactly as the constructor would -------------
  // BR-08: a detached ArrayBuffer, or a view over a detached buffer, is a bad
  // source -- flagged BEFORE any schema check so the door <-> coherence agreement
  // still holds on a detached input (the constructor throws R_BAD_SOURCE here).
  let byteLength;
  if (source instanceof ArrayBuffer) {
    if (bufferIsDetached(source)) return 'source ArrayBuffer is detached';
    byteLength = source.byteLength;
  } else if (ArrayBuffer.isView(source)) {
    if (bufferIsDetached(source.buffer)) return 'source ArrayBuffer is detached';
    byteLength = source.byteLength; // a pooled view is copied to a window of this length
  } else {
    return 'source must be an ArrayBuffer or a typed-array view';
  }

  const fields = options.schema;
  if (!Array.isArray(fields) || fields.length === 0) {
    return 'schema must be a non-empty array of {name,type,offset}';
  }

  // --- per-field coherence + tight-pack maxEnd --------------------------------
  const seen = Object.create(null);
  let maxEnd = 0;
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (!f || typeof f !== 'object') return 'field ' + i + ' is not an object';
    const t = f.type;
    if (!Number.isInteger(t) || t < 0 || t >= 10) {
      return "field '" + f.name + "' type is not an integer in 0..9: " + t;
    }
    const o = f.offset;
    if (!Number.isInteger(o) || o < 0) {
      return "field '" + f.name + "' offset is not a non-negative integer: " + o;
    }
    if (seen[f.name]) return "duplicate field name '" + f.name + "'";
    seen[f.name] = true;
    // S10: field.littleEndian must be boolean-or-absent (reuses R_BAD_SCHEMA at
    // the real door -- no new code, no new field here). Mirrors the constructor's
    // own check ORDER (after the duplicate-name check) so the two never disagree.
    if (f.littleEndian !== undefined && typeof f.littleEndian !== 'boolean') {
      return "field '" + f.name + "' littleEndian must be a boolean, got " + f.littleEndian;
    }
    const end = o + TYPE_BYTES[t];
    if (end > maxEnd) maxEnd = end;
  }

  // --- stride: given, or the tightly-packed minimum ---------------------------
  let stride = options.stride;
  if (stride === undefined) {
    stride = maxEnd;
  } else if (!Number.isInteger(stride) || stride <= 0) {
    return 'stride must be a positive integer, got ' + stride;
  } else if (stride < maxEnd) {
    return 'stride ' + stride + ' is smaller than the largest field end ' + maxEnd;
  }

  // --- every field must fit inside the stride ---------------------------------
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    const end = f.offset + TYPE_BYTES[f.type];
    if (end > stride) return "field '" + f.name + "' end " + end + ' exceeds stride ' + stride;
  }

  // --- base: coherent, non-negative, within the buffer ------------------------
  let base = options.byteOffset;
  if (base === undefined) base = 0;
  if (!Number.isInteger(base) || base < 0) return 'byteOffset must be a non-negative integer, got ' + base;
  if (base > byteLength) return 'byteOffset ' + base + ' exceeds byteLength ' + byteLength;

  // --- count: a non-negative integer that physically fits ---------------------
  let count = options.count;
  if (count === undefined) {
    count = stride > 0 ? Math.floor((byteLength - base) / stride) : 0;
  } else if (!Number.isInteger(count) || count < 0) {
    return 'count must be a non-negative integer, got ' + count;
  }
  if (count < 0) return 'derived count is negative: ' + count;
  if (base + count * stride > byteLength) {
    return 'base + count*stride ' + (base + count * stride) + ' exceeds byteLength ' + byteLength;
  }

  return null;
}

/* -------------------------------------------------------------------------- *
 * DataView oracle helpers -- an INDEPENDENT decode of one cell, used by both
 * validate() and the T5 differential. The oracle reads the buffer directly, so
 * it can never share a bug with the reader under test.
 * -------------------------------------------------------------------------- */
export function oracleRead(dv, type, pos, le) {
  switch (type) {
    case 1: return dv.getFloat64(pos, le); // T_F64
    case 0: return dv.getFloat32(pos, le); // T_F32
    case 2: return dv.getInt32(pos, le);   // T_I32
    case 5: return dv.getUint32(pos, le);  // T_U32
    case 3: return dv.getInt16(pos, le);   // T_I16
    case 6: return dv.getUint16(pos, le);  // T_U16
    case 4: return dv.getInt8(pos);        // T_I8
    case 8: return dv.getBigInt64(pos, le);  // T_I64 (allocates a BigInt)
    case 9: return dv.getBigUint64(pos, le); // T_U64 (allocates a BigInt)
    default: return dv.getUint8(pos);      // T_U8 (7)
  }
}

/** Read one cell through the matching typed getX (not the generic `get`). */
export function typedRead(reader, type, row, id) {
  switch (type) {
    case 1: return reader.getF64(row, id);
    case 0: return reader.getF32(row, id);
    case 2: return reader.getI32(row, id);
    case 5: return reader.getU32(row, id);
    case 3: return reader.getI16(row, id);
    case 6: return reader.getU16(row, id);
    case 4: return reader.getI8(row, id);
    case 8: return reader.getI64(row, id);
    case 9: return reader.getU64(row, id);
    default: return reader.getU8(row, id);
  }
}

/* -------------------------------------------------------------------------- *
 * validate -- the FULL read-fidelity invariant (ROADMAP section 3).
 *
 * O(count x fields), test/debug only, never a hot body. Returns a STRING naming
 * the first violated law or null if the reader reads with full fidelity against
 * an independent DataView oracle over the SAME buffer:
 *
 *   getX_f(r) === get(r,f) === DataView.getX(base + r*stride + off[f], le)
 *   base + count*stride <= buffer.byteLength                    (never read past)
 *   field(schema[i].name) === i                                 (name<->id bijection)
 *   typeOf(field(name)) / offsetOf(field(name)) match the schema (tables agree)
 *
 * @param {LiteBinaryReader} reader
 * @param {Array<{name:string,type:number,offset:number}>} schema  the ORIGINAL schema
 */
export function validate(reader, schema) {
  const buf = reader.buffer;
  const dv = new DataView(buf);
  const base = reader._base;
  const stride = reader._stride;
  const count = reader._count;
  const le = reader._le;

  if (!Number.isInteger(count) || count < 0) return 'count is not a non-negative integer: ' + count;
  if (base + count * stride > buf.byteLength) {
    return 'reads past buffer: base+count*stride ' + (base + count * stride) + ' > ' + buf.byteLength;
  }

  // bijection + table agreement
  for (let i = 0; i < schema.length; i++) {
    const nm = schema[i].name;
    let id;
    try {
      id = reader.field(nm);
    } catch (e) {
      return 'field(' + nm + ') threw ' + (e && e.code);
    }
    if (id !== i) return 'bijection broken: field(' + nm + ')=' + id + ' != ' + i;
    if (reader.typeOf(id) !== schema[i].type) {
      return 'typeOf mismatch at ' + nm + ': ' + reader.typeOf(id) + ' != ' + schema[i].type;
    }
    if (reader.offsetOf(id) !== schema[i].offset) {
      return 'offsetOf mismatch at ' + nm + ': ' + reader.offsetOf(id) + ' != ' + schema[i].offset;
    }
  }

  // cell fidelity: get(), typed getX() and the oracle must all agree
  const fieldCount = reader.fieldCount;
  for (let r = 0; r < count; r++) {
    for (let f = 0; f < fieldCount; f++) {
      const t = reader._type[f];
      const pos = base + r * stride + reader._off[f];
      const oracle = oracleRead(dv, t, pos, le);
      const viaGet = reader.get(r, f);
      if (!Object.is(viaGet, oracle)) {
        return 'get() cell mismatch r=' + r + ' f=' + f + ' got=' + viaGet + ' oracle=' + oracle;
      }
      const viaTyped = typedRead(reader, t, r, f);
      if (!Object.is(viaTyped, oracle)) {
        return 'getX() cell mismatch r=' + r + ' f=' + f + ' got=' + viaTyped + ' oracle=' + oracle;
      }
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- *
 * Reproduced-todo registry (ROADMAP section 4).
 *
 * The suite has no fix mechanism of its own. This package shipped six reproduced
 * defects (BR-01..BR-06), all unfixed this session (they land in S2). A `todo`
 * runs the exact probe body a finding was found with and must STILL reproduce
 * it: true (still broken) keeps the gate neutral, false (fixed) FAILS the run and
 * demands the todo's promotion to an enforced check.
 *
 * Reproduced-detection rule (documented so no future session weakens it):
 *   - probeFn MUST return a BOOLEAN.
 *   - true  -> defect still reproduces -> gate-neutral.
 *   - false -> defect no longer reproduces -> die() ("promote its todo").
 *   - a THROW out of probeFn is an UNEXPECTED harness fault and PROPAGATES:
 *     torture.mjs's per-tier try/catch surfaces it with the replay seed and
 *     exits 1. This is fail-CLOSED. The S2 fixes land as coded R_* throws; a
 *     probe body must catch its OWN expected coded throw and return false, so a
 *     fix-that-throws reads as "fixed", not "reproduced".
 * -------------------------------------------------------------------------- */

const TODOS = [];

/**
 * Register + run one known-defect probe.
 * @param {string} id           the finding id (carries the probe name)
 * @param {() => boolean} probeFn returns true while the defect still reproduces
 */
export function todoReproduced(id, probeFn) {
  TODOS.push(id);
  const reproduced = probeFn();
  if (typeof reproduced !== 'boolean') {
    die(id + ' probe returned a non-boolean (' + typeof reproduced +
      ') -- a todo probe must return true (reproduced) or false (fixed)');
  }
  if (!reproduced) {
    die(id + ' no longer reproduces -- promote its todo to an enforced check and flip the finding');
  }
}

/** A copy of every registered todo id, so t9 can assert the full set. */
export function todoIds() {
  return TODOS.slice();
}
