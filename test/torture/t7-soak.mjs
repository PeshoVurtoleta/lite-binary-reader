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
  { name: 'a', type: 1, offset: 0 },                    // F64
  { name: 'n', type: 7, offset: 8 },                    // U8 run-length source
  { name: 'blob', type: 7, offset: 9, lengthField: 'n' }, // U8 variable-length span
];
const STRIDE = 14;

const CENSUS_WINDOW = 512; // sample readers + views from the last N cycles

export async function run() {
  const prng = makePrng(SEED);
  const tracker = createLeakTracker({ name: 'lbr-soak' });
  const sink = new Float64Array(1);
  const rowOut = new Array(SCHEMA.length); // one reused readRow sink for the soak

  const buf = new ArrayBuffer(STRIDE * COUNT);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // One-sided reachability census: WeakRefs to discarded readers and dropped
  // borrowed views from the tail cycles. No strong ref survives the loop body.
  const censusRefs = [];

  for (let c = 0; c < CYCLES; c++) {
    // Churn the buffer contents in place (not a fresh backing store). The run
    // length `n` is clamped to 0..3 so the variable-length span at 'blob' stays
    // inside the buffer for every row (including the last).
    for (let i = 0; i < COUNT; i++) {
      const b = i * STRIDE;
      dv.setFloat64(b + 0, (prng() % 100000) * 0.25 - 5000, true);
      u8[b + 8] = prng() & 3;                 // n
      for (let k = 0; k < 3; k++) u8[b + 9 + k] = prng() & 0xff; // blob bytes
    }

    const r = new LiteBinaryReader(buf, { schema: SCHEMA });

    // Cursor scan: seek each row once, read fields off the cursor. Accumulate to
    // defeat dead-code elimination.
    for (let k = 0; k < r.count; k++) {
      r.seek(k);
      sink[0] += r.f64(0) + r.u8(1) + r.val(2);
    }

    // readRow into ONE reused, caller-owned out sink -- no record allocated.
    for (let k = 0; k < r.count; k++) {
      r.readRow(k, rowOut);
      sink[0] += rowOut[0] + rowOut[1] + rowOut[2];
    }

    // Take a borrowed variable-length bytes() VIEW (the 2-arg form, length read
    // from the 'n' sibling) and drop it -- proving a kept view is the caller's
    // choice, not a leak. The census below watches these dropped views.
    const borrowed = r.bytes(0, 2);
    sink[0] += borrowed.length;

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
