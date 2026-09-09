# 0007 -- lite-query streaming adapter (v0.6.0)

Status: accepted (v0.6.0). Context: S6 proves the reader feeds a real
`@zakkster/lite-query` `streamQuery` `stream:` generator with zero-GC binary reads,
WITHOUT an import edge -- an EXAMPLE + TEST, never a code dependency. Like S5 this is
a PROOF release: `Reader.js` changes ONLY its `VERSION` const (0.5.0 -> 0.6.0); every
read body is byte-identical. No new public surface, so the frozen invariants (R_*
union 10, type-code table 8, dts-drift member floor 32) do not move.

## Decisions (locked by the maintainer before the pipeline ran)

- D-1 = BOTH recipes. (a) FLAGSHIP: a streamed FOREIGN fixed-stride feed -- bytes no
  baker wrote -- wrapped per window in `new LiteBinaryReader(window, {...})` inside
  the generator and yielded as primitives. This is the reader's reason to exist; a
  source with no native reader. (b) A real `@zakkster/lite-bake-stream` shard read
  through `fromLBK1Shard` INSIDE a streamQuery, composing the S5 proof into a stream.
  Rationale for (a) as flagship: lite-query's OWN Cookbook recipe 20 already streams a
  bake-stream container through bake-stream's NATIVE `RangeReader.syncRange().get()` --
  our reader would be a redundant wrapper there. The foreign feed is the honest fit.
- D-2 = REPO-ONLY. `examples/streamQuery-adapter.md`, the Cookbook R6/R7 recipes, and
  `test/helpers/query-observer.mjs` do NOT ship; `files[]` stays at 7. The pack gate
  confirms only the 7 shipped files remain.
- D-3 = VERSION 0.6.0 (the roadmap's earmark). A proof/example release; the CHANGELOG
  says so plainly. Drift gate asserts `Reader.js` VERSION === package.json.
- D-4 = `@zakkster/lite-query` plus its `@zakkster/lite-signal` / `@zakkster/lite-stream`
  peers are TEMPORARY test-only `file:` devDependencies, reconsidered at the S8 v1.0.0
  gate. (lite-query self-provides its peers in this file: layout via its own nested
  install, so the tests bind through lite-query; the peer declarations model the
  contract a published consumer satisfies.) All are excluded from the tarball by
  construction.

## The peer-dedup topology (why the test binds to lite-query's lite-signal)

`@zakkster/lite-signal` is a PEER dependency of lite-query and lite-stream
(`dependencies: {}` on both). In a real consumer install npm dedups it to ONE copy, so
the consumer's own `effect` and lite-query's internal reactivity are the SAME instance
-- reading `handle.data()` inside that effect subscribes, which drives laziness and
abort-on-detach. In THIS suite's `file:`-symlink dev layout, lite-query carries its own
nested `node_modules/@zakkster/lite-signal`, so a naive `import { effect } from
'@zakkster/lite-signal'` in our repo loads a SECOND instance whose effects never observe
lite-query's signals (the stream would never start). `test/helpers/query-observer.mjs`
therefore binds the observer to the exact instance lite-query resolves (via a
`createRequire` anchored at lite-query) -- reconstructing the single-instance topology a
published consumer has. This is a TEST harness detail; nothing shipped touches it.

## The signal-cancel contract (the lesson the proof encodes)

An async generator suspended on `await source.next()` cannot be released by
streamQuery's `iterator.return()` until that awaited promise settles. A source that
waits indefinitely for the next window therefore LEAKS on abort-on-detach. The
generator MUST wire the abort `signal` to cancel its in-flight source read
(`signal.addEventListener('abort', () => source.cancel())`) -- exactly what
bake-stream's `RangeReader { signal }` does for real range I/O. The proof asserts the
source is cancelled on detach and NO value is observed after abort. The detach surfaces
as a plain `AbortError` on `signal.reason` (runtime truth -- the test asserts the
cancellation and post-abort silence, not a specific reason string).

## The zero-alloc boundary (what is 0 B/op and what is not)

- Frame path (0 B/op): `readRow` into a HOISTED reused sink, yield a PRIMITIVE. The
  reader's entire per-frame contribution is already gated by torture t6 Gate 3.
- Cold/amortized (excluded): one `new LiteBinaryReader(window, {...})` + `field()` per
  fetch WINDOW, amortized across the window's rows.
- lite-query's own cost (out of our scope): latest mode = one signal write per frame,
  0 alloc; buffer mode = one snapshot array per value (accumulation, lite-query's).
- Would allocate (do NOT do): yielding a fresh `{ ... }` record per row.

## D9 ownership boundary

A decoded NUMBER is a value and survives the window being overwritten by the next
frame. A `bytes(row, id)` span is a BORROWED view into the window -- a retained span
must be copied before the next frame overwrites the window (copy what you keep). BR-07
already copies a partial/nonzero-offset source to an owned window at construction, so a
per-fetch-window reader never reads past its own window.

## What ships / what does not

- Ships (files[], 7): Reader.js, Reader.d.ts, llms.txt, README.md, CHANGELOG.md,
  LICENSE, package.json. The lite-query devDep, every test/ file (helpers included),
  `examples/`, and `Cookbook.md` are excluded from the tarball.
- Torture unchanged and sibling-free: `node --expose-gc test/torture.mjs` still runs
  standalone; the streaming proof lives only in `npm test`.

## D10 -- no import edge (enforced, not claimed)

`test/no-import-edge.test.js` asserts `Reader.js` and `Reader.d.ts` import no
`@zakkster/...` sibling -- the generic specifier regex already covers lite-query,
lite-signal, and lite-stream. A sibling import in the reader trips CI, not merely review.

## /release 0.6.0 breadcrumb (records under Added / Changed)

- Added: `test/coop-query.test.js` (flagship foreign feed + fromLBK1Shard-in-a-stream +
  abort-on-detach + reactive-key restart + structural zero-alloc + D9), a peer-surface
  guard, the `query-observer` test helper, `examples/streamQuery-adapter.md`, Cookbook
  R6/R7, this record.
- Changed: test count 81 -> 90; VERSION 0.5.0 -> 0.6.0 (Reader.js, package.json,
  llms.txt); `@zakkster/lite-query` added as a temporary test-only `file:` devDependency
  (revert at S8 v1.0.0). No runtime change: Reader.js diff is the VERSION line.
