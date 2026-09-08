/**
 * t7 -- soak + retention witness (lite-leak enters here).
 *
 * `leak_cycles` (4096) cycles of: churn a hoisted buffer's bytes -> build a fresh
 * LiteBinaryReader over it -> read every cell -> take a borrowed bytes() view and
 * drop it -> discard the reader. Three independent witnesses:
 *
 *   - REACHABILITY (the real retention witness). lite-leak 1.10.0's
 *     `tracker.size()` counts live REGISTRATIONS, not reachability -- a track()
 *     paired with an immediate untrack() proves only that a counter decrements,
 *     never that the subject was collected. So the binding witness is a ONE-SIDED
 *     WeakRef census (harness `censusOk`) over the discarded readers AND the
 *     dropped borrowed bytes() views from the last stretch of cycles: after the
 *     loop drops every strong ref and `settleGc` forces collection, the census
 *     fails iff EVERY sampled subject is still live (a genuine pin). This is the
 *     pattern LiteQuery's phase H uses for exactly this lite-leak change.
 *   - REGISTRATION (the counter witness, kept but demoted). lite-leak tracks a
 *     per-cycle resource and untracks it in the same cycle; `tracker.size()===0`
 *     confirms the registry balances. Neither the cleanup (NOOP) nor the tag
 *     closes over the target (the held-value contract). This is necessary but NOT
 *     sufficient -- the census above is what proves no retention.
 *   - FIDELITY. the read-fidelity invariant (validate) holds after each sampled
 *     cycle -- a borrowed bytes() view is the caller's to keep, never a leak.
 *
 * The buffer + DataView are hoisted; only their CONTENTS change per cycle, so the
 * churn under test is reader construction + reads, not fresh backing stores. The
 * census WeakRefs are the only per-cycle allocation and are bounded to the sample
 * window; t7 is a soak tier (heap sampled with a 512 KB tolerance), not the
 * zero-alloc gate (that is t6).
 */

import { LiteBinaryReader } from '../../Reader.js';
import { createLeakTracker } from '@zakkster/lite-leak';
import { makePrng, SEED, check, validate, censusOk, settleGc } from './harness.mjs';

const CYCLES = 4096;
const COUNT = 64;
const NOOP = function () {};

const SCHEMA = [
  { name: 'a', type: 1, offset: 0 },  // F64
  { name: 'b', type: 5, offset: 8 },  // U32
  { name: 'c', type: 6, offset: 12 }, // U16
];
const STRIDE = 14;

const CENSUS_WINDOW = 512; // sample readers + views from the last N cycles

export async function run() {
  const prng = makePrng(SEED);
  const tracker = createLeakTracker({ name: 'lbr-soak' });
  const sink = new Float64Array(1);

  const buf = new ArrayBuffer(STRIDE * COUNT);
  const dv = new DataView(buf);

  // One-sided reachability census: WeakRefs to discarded readers and dropped
  // borrowed views from the tail cycles. No strong ref survives the loop body.
  const censusRefs = [];

  for (let c = 0; c < CYCLES; c++) {
    // Churn the buffer contents in place (not a fresh backing store).
    for (let i = 0; i < COUNT; i++) {
      const b = i * STRIDE;
      dv.setFloat64(b + 0, (prng() % 100000) * 0.25 - 5000, true);
      dv.setUint32(b + 8, prng() >>> 0, true);
      dv.setUint16(b + 12, prng() & 0xffff, true);
    }

    const r = new LiteBinaryReader(buf, { schema: SCHEMA });

    // Read every cell; accumulate to defeat dead-code elimination.
    for (let k = 0; k < r.count; k++) {
      sink[0] += r.getF64(k, 0) + r.getU32(k, 1) + r.getU16(k, 2);
    }

    // Take a borrowed bytes() view and drop it -- proving a kept view is the
    // caller's choice, not a leak. (bytes() over row 0 field 'b', 4 bytes.)
    const borrowed = r.bytes(0, 1, 4);
    sink[0] += borrowed[0];

    // Read-fidelity holds this cycle.
    if ((c & 511) === 0) {
      const v = validate(r, SCHEMA);
      check(v === null, () => 't7: validate failed at cycle ' + c + ': ' + v + ' (seed=' + SEED + ')');
    }

    // REACHABILITY: sample the tail cycles' reader + borrowed view into the
    // census. No strong ref to either escapes this block, so both must be
    // collectable once the loop moves on (buf itself is hoisted and stays live,
    // which is correct -- the census watches the wrappers, not the backing store).
    if (c >= CYCLES - CENSUS_WINDOW) {
      censusRefs.push(new WeakRef(r));
      censusRefs.push(new WeakRef(borrowed));
    }

    // REGISTRATION (counter witness, necessary but not sufficient -- see header).
    // Neither the cleanup (NOOP) nor the tag (the number c) closes over the target.
    const h = tracker.track({ cycle: c }, NOOP, c);
    tracker.untrack(h);
    check(tracker.size() === 0, () => 't7: tracker.size()=' + tracker.size() + ' after cycle ' + c + ' (seed=' + SEED + ')');
  }

  check(tracker.size() === 0, () => 't7: lite-leak tracker leaked ' + tracker.size() + ' registrations (seed=' + SEED + ')');

  // REACHABILITY witness: force collection, then the one-sided census. A real
  // retention leak (a pinned reader or view) leaves every sampled ref live.
  await settleGc();
  check(censusRefs.length >= 2 * CENSUS_WINDOW,
    () => 't7: census sample too small (' + censusRefs.length + ') -- witness would be vacuous (seed=' + SEED + ')');
  check(censusOk(censusRefs),
    () => 't7: WeakRef census -- all ' + censusRefs.length +
          ' sampled readers/views still live after settle (retention leak) (seed=' + SEED + ')');

  globalThis.gc();
  await new Promise((r) => setTimeout(r, 50));
  const heapBefore = process.memoryUsage().heapUsed;
  // One more short churn to confirm steady state after settling.
  for (let c = 0; c < 256; c++) {
    const r = new LiteBinaryReader(buf, { schema: SCHEMA });
    for (let k = 0; k < r.count; k++) sink[0] += r.getF64(k, 0);
  }
  globalThis.gc();
  await new Promise((r) => setTimeout(r, 50));
  const heapAfter = process.memoryUsage().heapUsed;
  const grewKB = (heapAfter - heapBefore) / 1024;
  check(grewKB < 512, () => 't7: heap grew ' + grewKB.toFixed(1) + ' KB in steady state (seed=' + SEED + ')');
}
