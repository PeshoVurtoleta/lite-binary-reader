# 0008 -- benchmark suite + the endianness split-class question (v0.7.0)

Status: accepted (v0.7.0). Context: S13, brought forward AHEAD of the 1.0.0 freeze
so any hot-path change it surfaced would land before the contract locks (the
maintainer chose "benchmark first, then 1.0.0 with numbers"). This is a bench + docs
release: `Reader.js` changes ONLY its `VERSION` const (0.6.2 -> 0.7.0); every read
body is byte-identical. No new public surface, so the frozen invariants (R_* union
10, type-code table 8, dts-drift member floor) do not move. The benchmark and its
peer devDependencies are REPO-ONLY (`bench/` never enters `package.json` `files[]`;
`npm pack --dry-run` proves it).

## What was built

- `bench/bench.mjs` + `"bench": "node --expose-gc bench/bench.mjs"`. Modeled on
  `../LiteQuery/bench/bench.mjs`: `WARMUP_RATIO` warmup, `gc()`-bracketed
  `process.hrtime.bigint()` timing, and BOTH transient and retained `heapUsed`-delta
  bytes/op columns. Seeded, replayable (`BENCH_SEED=<n>`). Prints a machine-readable
  `SUMMARY_JSON` footer.
- Four value axes, one command:
  1. FAST -- ns/row for every read surface vs a hand-written `DataView` loop (the
     honest floor) and vs comparable read libraries.
  2. ZERO-GC -- transient + retained bytes/op. The reader's surfaces are 0 B/op; the
     object-materializing peers are not. (The torture gate is the AUTHORITATIVE
     0-B/op proof; the bench's coarser sampling corroborates it.)
  3. TINY -- one 9.5 KB (gzip) shipped file, 0 deps, vs 199-484 KB installed peers.
  4. SAVES TRAFFIC -- fixed-stride binary vs JSON on the wire (5.2x smaller raw,
     ~1.8x gzipped) and ~100x cheaper to decode, 0 B/op vs per-record objects.

## Decisions (locked by the maintainer)

- D-1 = curated fair-slice peers. The comparison is DataView baseline (always fair)
  plus `binary-parser`, `typed-struct`, `restructure` -- measured ONLY on the
  read-only, tightly-packed, little-endian, aligned slice that every library reads
  natively. The reader's unaligned offsets, big-endian source, and `laneOf` typed
  path are things the peers cannot do at all; they are shown in `demo/`, NOT smuggled
  into the fair speed slice. Peers are bench-only devDependencies -- the zero-runtime
  -dependency law is untouched. A peer that will not install is dropped with a note.
- D-2 = split-class change is authorized IF the experiment shows a real, repeatable
  win on the fallback `getX` path; otherwise the idea is closed with the negative
  result recorded. (See below -- it was closed.)

## Fairness discipline (the honest part)

- Every contender is verified to decode the IDENTICAL values -- an exact checksum vs
  a `DataView` oracle -- BEFORE its timings count. A number measured against wrong or
  unequal work is not a comparison.
- The peers parse into JS objects; that allocation is INHERENT to their model, not a
  defect, and the text says so. `binary-parser` (a real bulk binary parser) is the
  marquee, like-for-like comparison. `restructure` (a `DecodeStream` format parser)
  and `typed-struct` (a lazy `Proxy`-accessor view) are reported for completeness;
  their large multipliers reflect a workload fit, not a like-for-like engine race,
  and are NOT leaned on.
- Timings are ADVISORY (wall-clock is noisy across machines); the bytes/op columns
  are deterministic and are the load-bearing headline.

## The endianness split-class experiment -- CLOSED (negative result)

The recurring suggestion: split the getters into hardcoded-LE and hardcoded-BE
classes so `DataView.getX` receives a LITERAL byte order instead of the reader's
dynamic `_le` flag, on the theory that a dynamic endianness argument deopts the
getter.

Measured directly, five runs (Node 26, LE host, 20,000 f32/pass): a literal-
endianness getter is **3.8 / 3.9 / 4.5 / 4.1 / 4.0%** faster than the dynamic-`_le`
getter in an isolated loop -- consistent, so NOT noise.

But the decisive evidence is against adopting it:

- The shipped `getF32` -- which DOES read `this._le` -- already MATCHES a hand-written
  `DataView` loop every run (~0.61 ns/row vs ~0.61 ns/row). There is no endianness
  penalty in the method callers actually use; the ~4% gap is a literal-vs-variable
  micro-effect in a synthetic loop that does not transfer to the class method.
- `laneOf` (~0.57 ns/row) already beats the `DataView` floor for any hot loop over an
  aligned column, so the fallback `getX` path a split class would optimize is not the
  hot path anyway.
- A split class would roughly DOUBLE the hot-getter surface (8 types x 2 byte orders)
  in a module whose rule is "bytes in a hot body, not instructions" -- a large
  instruction and maintenance cost for a fallback-only micro-gain that does not show
  up in `getF32`.

Decision: **not adopted.** The ~4% is real in a microbench and unreal in the reader.
The idea is closed. If a future consumer profiles a genuine dynamic-endianness
penalty on a real workload, reopen with that evidence.

## Non-goals / boundaries

- No `Reader.js` behavioural change (VERSION const only). The bench measures the
  shipped reader; it does not modify it.
- The bench is ADVISORY, not part of `npm run verify` (wall-clock is noisy; the
  torture gate remains the hard zero-GC gate).
- `bench/` and the peer devDependencies stay out of the tarball.
