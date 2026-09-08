/**
 * @zakkster/lite-binary-reader -- standalone control driver.
 *
 * Every gate must be provably able to fail. This entry drives the whole-suite
 * BREAK control out-of-process and asserts both directions of the invariant:
 *
 *   - a CLEAN run (`node --expose-gc test/torture.mjs`) prints exactly "ok" and
 *     exits 0;
 *   - the BREAK run (`LBR_TORTURE_BREAK=1 node --expose-gc test/torture.mjs`)
 *     injects a retained allocation into the T6 hot loop, so the alloc gate
 *     rejects the window, the run exits NON-zero, and it never prints "ok".
 *
 * A suite that always fails is as useless as one that never does; both arms are
 * required. The in-process controls (checkCoherence non-vacuity, the dropped-_le
 * read, the no-translate LBK1 collision, the corrupted oracle, the retained-alloc
 * channel) run every invocation inside T9 -- a plain `npm run torture` already
 * proves each of those gates bites; this driver adds the out-of-process proof
 * that the whole-suite BREAK exits non-zero.
 *
 *     node test/controls.mjs        -> prints exactly "ok", exit 0
 *     npm run torture:controls
 *
 * @license MIT
 */

import { spawnSync } from 'node:child_process';

const ENTRY = new URL('./torture.mjs', import.meta.url).pathname;

/** Run the torture entry with an optional BREAK value. Returns code + output. */
function runWith(breakOn) {
  const env = Object.assign({}, process.env);
  if (breakOn) env.LBR_TORTURE_BREAK = '1';
  else delete env.LBR_TORTURE_BREAK;
  const res = spawnSync(process.execPath, ['--expose-gc', ENTRY], { env, encoding: 'utf8' });
  return { code: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function fail(msg) {
  process.stderr.write('controls: FAIL -- ' + msg + '\n');
  process.exit(1);
}

// 1. The clean run must pass. If it does not, the BREAK arm is meaningless.
{
  const r = runWith(false);
  if (r.code !== 0) fail('clean run exited ' + r.code + ' (expected 0)\n' + r.stderr);
  if (r.stdout.trim() !== 'ok') fail('clean run stdout was ' + JSON.stringify(r.stdout) + ', expected exactly "ok"');
}

// 2. The BREAK run must exit non-zero and must NOT print "ok".
{
  const r = runWith(true);
  if (r.code === 0) fail('LBR_TORTURE_BREAK=1 still exited 0 -- the T6 gate is decorative');
  if (r.stdout.trim() === 'ok') fail('LBR_TORTURE_BREAK=1 printed "ok" on a failing run');
}

process.stdout.write('ok\n');
