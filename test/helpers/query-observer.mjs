/**
 * S6 test helper -- observe a lite-query handle with the SAME lite-signal
 * instance lite-query itself resolves.
 *
 * WHY THIS EXISTS (peer-dedup topology):
 *   `@zakkster/lite-signal` is a PEER dependency of lite-query (and lite-stream),
 *   `dependencies: {}` on both. In a real consumer install npm dedups it to ONE
 *   copy, so the consumer's own `effect` and lite-query's internal reactivity are
 *   the SAME module instance -- reading `handle.data()` inside that effect
 *   subscribes, which is what makes the stream lazy + abort-on-detach work.
 *   In THIS suite's `file:`-symlink dev layout, lite-query carries its own nested
 *   `node_modules/@zakkster/lite-signal`, so a naive `import { effect } from
 *   '@zakkster/lite-signal'` in our repo would load a SECOND instance whose
 *   effects never observe lite-query's signals (the stream would never start).
 *   We therefore bind the observer to the exact instance lite-query resolves --
 *   reconstructing the deduped single-instance topology a published consumer has.
 *   This is a TEST harness detail; nothing in the shipped reader touches it.
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const requireFromQuery = createRequire(await import.meta.resolve("@zakkster/lite-query"));
const signalUrl = pathToFileURL(requireFromQuery.resolve("@zakkster/lite-signal")).href;

/** lite-query's OWN lite-signal instance (the one that drives its reactivity). */
export const querySignal = await import(signalUrl);
export const effect = querySignal.effect;
export const signal = querySignal.signal;

/** One macrotask turn -- lets the async pump settle deterministically (no fake time). */
export const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A test-controlled async source of raw byte windows with an explicit cancel
 * seam. The stream generator MUST wire `signal` to `cancel()` so that a detach
 * unsticks a `for await` suspended on `next()` -- an async generator parked on a
 * never-settling await cannot be `.return()`-ed, so without this the source
 * would leak on abort-on-detach. `closed` flips true when cancel()/return() runs.
 */
export function makeWindowSource() {
  const s = { closed: false, _q: [], _w: null, _done: false };
  const settle = () => {
    if (!s._w) return;
    if (s._q.length) { const w = s._w; s._w = null; w({ value: s._q.shift(), done: false }); }
    else if (s._done || s.closed) { const w = s._w; s._w = null; w({ value: undefined, done: true }); }
  };
  s.push = (win) => { s._q.push(win); settle(); };
  s.finish = () => { s._done = true; settle(); };
  s.cancel = () => { s.closed = true; settle(); };
  s[Symbol.asyncIterator] = () => ({
    next: () => {
      if (s._q.length) return Promise.resolve({ value: s._q.shift(), done: false });
      if (s.closed || s._done) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve) => { s._w = resolve; });
    },
    return: (v) => { s.cancel(); return Promise.resolve({ value: v, done: true }); },
  });
  return s;
}

/** Pack an array of f64 rows into a foreign little-endian window (one lane @0, stride 8). */
export function f64Window(values) {
  const buf = new ArrayBuffer(values.length * 8);
  const dv = new DataView(buf);
  for (let i = 0; i < values.length; i++) dv.setFloat64(i * 8, values[i], true);
  return new Uint8Array(buf);
}
