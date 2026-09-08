/**
 * @zakkster/lite-binary-reader -- torture gate entry.
 *
 * The DONE-WHEN of every session is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * The tiers this package needs now (ROADMAP section 4). T3/T4 (adversarial-
 * sequence and handle-abuse) DO NOT APPLY: a reader has no mutable tree state to
 * corrupt across a sequence, so they are deliberately absent rather than stubbed.
 *
 *     t0  read-fidelity laws            t1  degenerate layouts
 *     t2  adversarial + door matrix     t5  differential vs oracles
 *     t6  zero-alloc + retained-alloc   t7  soak + lite-leak witness
 *     t9  controls (every gate must be able to fail)
 *
 * lite-gc-profiler is one-measurement-at-a-time and throws "already in flight"
 * if nested, so tiers run STRICTLY SEQUENTIALLY -- never nested, never concurrent.
 *
 * ENTRY CONTRACT (copied from ../LiteBake/test/torture.mjs):
 *   - `--expose-gc` guard: the GC gate is meaningless without it -> exit(1).
 *   - Peer preflight: the two devDeps are imported DYNAMICALLY, AFTER the guard;
 *     a fresh clone that skipped `npm install` exits(2) with a remedy, not a raw
 *     ERR_MODULE_NOT_FOUND. A static import would hoist past the check and make
 *     the exit-2 path unreachable.
 *   - Replay: every failure prints the seed and replay command.
 *
 * CONTROL: `LBR_TORTURE_BREAK=1 node --expose-gc test/torture.mjs` injects a
 * retained allocation into the T6 hot loop; the alloc gate rejects it and the
 * process exits non-zero. A normal run exits 0. A gate that cannot fail is
 * decorative.
 *
 * @license MIT
 */

async function main() {
  // --- guard: the GC gate is meaningless without --expose-gc ----------------
  if (typeof globalThis.gc !== 'function') {
    process.stderr.write(
      'torture: FAIL -- run with --expose-gc: node --expose-gc test/torture.mjs\n');
    process.exit(1);
  }

  // --- preflight: peers must be installed before any tier is imported --------
  for (const pkg of ['@zakkster/lite-gc-profiler', '@zakkster/lite-leak']) {
    try {
      await import(pkg);
    } catch {
      process.stderr.write(
        'torture: FAIL -- missing devDependency ' + pkg + ' -- run: npm install\n');
      process.exit(2);
    }
  }

  // Dynamic imports so preflight owns the failure path. The harness (and via it
  // the profiler) is loaded only after both peers were confirmed present.
  const { SEED, BREAK } = await import('./torture/harness.mjs');
  const { run: t0 } = await import('./torture/t0-fidelity.mjs');
  const { run: t1 } = await import('./torture/t1-degenerate.mjs');
  const { run: t2 } = await import('./torture/t2-adversarial.mjs');
  const { run: t5 } = await import('./torture/t5-differential.mjs');
  const { run: t6 } = await import('./torture/t6-alloc.mjs');
  const { run: t7 } = await import('./torture/t7-soak.mjs');
  const { run: t9 } = await import('./torture/t9-controls.mjs');

  const TIERS = [
    ['t0 fidelity', t0],
    ['t1 degenerate', t1],
    ['t2 adversarial', t2],
    ['t5 differential', t5],
    ['t6 alloc', t6],
    ['t7 soak', t7],
    ['t9 controls', t9],
  ];

  for (const [name, run] of TIERS) {
    try {
      // Tiers normally fail via die() (which exits). A thrown error is an
      // unexpected fault -- surface it with the replay seed and stop.
      await run();
    } catch (err) {
      process.stderr.write(
        'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
        '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
      process.exit(1);
    }
  }

  // Reaching here in BREAK mode means the T6 control did not trip -- a fault.
  if (BREAK) {
    process.stderr.write(
      'torture: FAIL -- LBR_TORTURE_BREAK set but the gate still passed\n');
    process.exit(1);
  }

  process.stdout.write('ok\n');
  process.exit(0);
}

main();
