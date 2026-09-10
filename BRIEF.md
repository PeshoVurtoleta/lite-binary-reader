# S12 -- v1.4.0 -- zero-alloc row iterator  [IMPLEMENTED -- awaiting /release 1.4.0 + publish]

status: IMPLEMENTED + verified (all recommendations accepted: D1=both rows(out) AND bare
[Symbol.iterator]; D2=yield the reused SINK, delegate to readRow; D3=DECLINE string() --
kept with the producer, NOT this session). Full pipeline honored: reviewer APPROVED (0
blocking findings -- confirmed 0 alloc/next(), hand-written not-a-generator, sound reuse/
aliasing documented in code + .d.ts, independent re-entrancy, fail-closed delegation); qa
authored the torture Gate 7, the t9 generator teeth-control, test/iterator.test.js, the
dts-drift pin, and the type-test. Reader.js gained ONLY additive methods (the read bodies
getX/get/cursor/readRow/laneOf/bytes are BYTE-IDENTICAL to 1.3.0); the VERSION const stays
"1.3.0" and moves to "1.4.0" at /release, in lock-step with package.json / llms.txt.

GATE RESULTS (npm run verify, exit 0): npm test 126/126 (was 108: +15 iterator conformance
+ 3 dts-drift iterator-surface); test:types tsc exit 0 (iterator threads RowTuple<S>; legacy
Field[] keeps the permissive sink); torture "ok" incl Gate 7 (a long-lived iterator held at
0 B/op per next() through both the ops and retained-alloc channels); controls "ok" incl
Control 15 (a generator sweep FAILS the retained gate -- teeth; the hand-written arm passes
-- non-vacuous). BREAK teeth control still exits non-zero. NOTE: one flaky "inconclusive"
verdict was seen once at the PRE-EXISTING Gate 6 (mixed-endian) -- a lite-gc-profiler
no-measurement outcome (bytesPerCall=null, violations=0) that fails CLOSED; 4 subsequent
clean runs all print "ok". It is a harness property (Gate 6 runs before Gate 7), NOT an S12
regression -- if /release's single torture run hits it, re-run.

WHAT LANDED: Reader.js `_rowIter(out)` (internal, underscore) -- a hand-written iterator
with ONE reused { value, done } record + a per-iterator row counter; `next()` delegates to
readRow (0 alloc/row). `rows(out)` over a caller-owned sink; `[Symbol.iterator]()` over a
reader-owned Array(fieldCount) fresh per call (independent concurrent sweeps). The yielded
row is BORROWED/reused -- `[...reader]` is N refs to one array by design; materialize with
`Array.from(reader, r => r.slice())`. Reader.d.ts: `rows(out: RowTuple<S>)` typed + `rows<T
extends RowSink>` permissive + `[Symbol.iterator](): IterableIterator<RowTuple<S>>`. Docs:
CHANGELOG 1.4.0, README "Sequential sweep (for...of)" subsection + TOC + What-you-get bullet
+ test count 108->126 + Testing prose, llms.txt Status S12 paragraph + API surface entry.
NOT bumped this session (per plan): the version SITES (Reader.js VERSION const, package.json,
llms.txt Status/API/VERSION headers, test/Reader.test.js VERSION assertion) -- all move
together at /release 1.4.0. D3/D4 note: after S12 the additive-minor track is CLOSED (read
surface complete: getX / seek+cursor / readRow / laneOf / iterator); beyond is a 2.0.0 (none
proposed) or proof/demo releases.

--- original plan (for reference) ---

status: PLANNED. This is the LAST additive minor on the roadmap -- after it the reader
is feature-complete for this track (S9 64-bit, S10 per-field endianness, S11 typed reads
already shipped). Unlike S11, this IS a real HOT-PATH module change: the full pipeline
(planner -> coder -> reviewer -> qa) and a torture-gated tier, because a naive iterator
is the textbook reused-result-object 0-B/op trap. It also carries ONE genuine boundary
decision (string(), D3) that currently CONTRADICTS a documented NOT-FOR -- so it is a
decision for you, not a default. Additive minor: 1.3.0 -> 1.4.0. No new R_* code, no
type-table move -- the drift inventories (R_* union 10, type table 10) stay unchanged but
the lock-step VERSION bump.

why_now: the reader has every RANDOM-ACCESS and FILL surface it needs (getX, seek+cursor,
readRow-into-a-sink, laneOf), but no ergonomic SEQUENTIAL sweep -- callers still write the
`for (let i=0;i<reader.count;i++)` boilerplate by hand. A `for...of` sweep is the one
idiom every TS-first reader (typed-struct, restructure) offers and we do not. It is also
the natural close to the S11 typed-reads work: an iterator that yields the S11 `RowTuple<S>`
makes `for (const row of reader.rows(sink))` both zero-GC AND typed per field. Doing it
LAST is correct -- it composes readRow (S4) + RowTuple (S11), both already shipped.

===============================================================================
## What exists today (grounded in Reader.js / Reader.d.ts, not assumed)
===============================================================================
  - NO iterator surface: no `Symbol.iterator`, no `rows()`, no `entries()`, no generator
    anywhere in Reader.js (grep-confirmed). A sequential sweep today is a hand-written
    index loop plus getX / seek+cursor / readRow.
  - `readRow(row, out) -> out` (S4) already fills a caller-owned Array/TypedArray sink by
    field id, zero-alloc, and throws R_BAD_LENGTH on a null/short sink. This is the exact
    per-row body an iterator should reuse -- S12 is a CURSOR over readRow, not a new read.
  - `seek(row) -> this` + the cursor reads (f64..u8 / val) already own the "one mutable
    cursor" model; S12's iterator is the same cursor advanced automatically.
  - S11 gives `RowTuple<S>` (a per-field-typed tuple) as the typed readRow sink -- the
    iterator's typed value type is already defined; S12 only threads it through.
  - `bytes(row,id[,len])` is the ONLY sanctioned span accessor and its contract is
    "BORROWED view; copy what you keep." The NOT-FOR explicitly says decoding a span into
    a STRING "stays with the producer" -- string() would REVERSE that (see D3).

===============================================================================
## The design (a reused-result iterator; the generator is the trap, not the goal)
===============================================================================
  THE TRAP (why this needs the torture loop): the obvious implementation is a generator
  `*rows() { for (i..) yield this.readRow(i, sink); }`. A generator allocates a FRESH
  `{ value, done }` IteratorResult record on EVERY `yield` -- that is a per-row heap
  allocation the torture gate MUST reject. A zero-alloc iterator therefore CANNOT be a
  generator; it must be a hand-written iterator object that mutates and RE-YIELDS a single
  result record.

  THE SHAPE:
    - `rows(out) -> Iterable` -- returns an iterable/iterator over a CALLER-owned sink.
      Its `next()` increments an internal row counter, calls `readRow(row, out)`, and
      returns the SAME reused `{ value: out, done }` record each step (value re-pointed,
      never re-created). Zero alloc per row: the sink is the caller's, the result record
      is reused, the counter is a field. Cold cost: one iterator object + one result
      record at `rows()` call, amortized over `count` rows.
    - `[Symbol.iterator]()` -- so `for (const r of reader)` works out of the box. It
      iterates over a READER-OWNED reused sink (built cold, size fieldCount). The SAME
      array is yielded every row -- documented like bytes(): a value read out of it is
      safe; the array itself is borrowed, copy what you keep (`[...r]` / `r.slice()` to
      retain). This is the one honesty line the surface must carry loudly.
    - TYPED (S11 tie-in): `rows(out: RowTuple<S>)` yields `RowTuple<S>`; the bare
      `[Symbol.iterator]` yields the reader-owned sink typed as `RowTuple<S>` when S is a
      const schema, `(number|bigint)[]`-ish otherwise. Pure .d.ts, no runtime cost.

  BOUNDARY (D1): does the iterator OWN a default sink (so `for (const r of reader)` needs
  no argument -- most ergonomic, but a hidden reused array is a footgun magnet), or is a
  sink ALWAYS caller-supplied via `rows(out)` (safer, explicit, but `for...of` bare needs
  SOME owned sink to yield)? RECOMMEND: both -- `rows(out)` for the explicit zero-alloc
  path, and a bare `[Symbol.iterator]` over a lazily-built reader-owned sink for ergonomics,
  with the borrowed-array warning front and centre. Same "safe default + explicit fast
  path" split as getX (stateless) vs seek+cursor (stateful).

===============================================================================
## Tasks (full pipeline -- this DOES allocate-risk, so it IS torture-gated)
===============================================================================
  T1  planner -> spec: the iterator protocol, the reused-result-record invariant, the
      owned-vs-caller sink decision (D1), and the falsifiable 0-B/op assertion.
  T2  coder: Reader.js -- a hand-written iterator (NOT a generator): a reused
      `{ value, done }` record, an internal row counter, `next()` -> readRow into the
      sink -> re-yield the record; `rows(out)` and `[Symbol.iterator]()`. VERSION const
      bumps at /release only. Every per-row body delegates to the existing readRow (no
      new read math). Reader.d.ts: `rows(out: RowTuple<S>): IterableIterator<RowTuple<S>>`
      + `[Symbol.iterator](): IterableIterator<RowTuple<S>>`, with the Field[] fallback.
  T3  reviewer: adversarial pass for the generator trap (assert NOT a generator), a fresh
      allocation per next(), any retained reference to the sink, and the "same array
      re-yielded" contract (a caller that pushes `r` into an array must see aliasing, and
      that must be DOCUMENTED, not a silent bug).
  T4  qa + torture: a NEW tier (t10?) -- iterate `count` rows via `for...of` and via
      `rows(sink)`, assert 0 B/op and 0 retained across the sweep, values cell-identical
      to a getX oracle (Object.is, so NaN/-0 cannot slip); a control that swaps the
      hand-iterator for a generator MUST fail the gate (teeth). node:test: iterator
      protocol conformance (done flips exactly at count; empty reader yields nothing;
      re-entrancy / two concurrent iterators do not share the counter), the borrowed-array
      aliasing test (documented), and the typed path via test:types (RowTuple yield).
  T5  dts-drift: extend to pin `rows` + `[Symbol.iterator]` in the .d.ts (a later edit
      cannot silently drop the iterator surface).
  T6  docs: CHANGELOG 1.4.0; llms.txt + README one "sequential sweep" example (bare
      for...of + explicit rows(sink)), the borrowed-array warning, and the 0-B/op line.
      test count updated. ASCII-only; grep new files for stray tool-call tags.

===============================================================================
## Assertions (the DONE-WHEN, each falsifiable)
===============================================================================
  - `for (const r of reader)` and `for (const r of reader.rows(sink))` both sweep all
    `count` rows, values cell-identical to getX (Object.is); the iterator is NOT a
    generator (assert `reader.rows` is not a GeneratorFunction / result record is reused).
  - 0 B/op and 0 retained across a full sweep (torture tier); the generator control FAILS
    the gate (a gate that cannot fail is decorative).
  - The yielded sink is the SAME object each row (documented borrowed-array contract);
    `[...reader]` / per-row copy is the retain path, tested.
  - Typed: with a const schema, the iterator value is `RowTuple<S>` (test:types); an
    untyped Field[] schema keeps the permissive union.
  - Runtime otherwise unchanged: getX/seek/readRow/laneOf/bytes byte-identical; R_* union
    10, type table 10; pack still 7 files (no new shipped file).

===============================================================================
## Non-goals / boundaries
===============================================================================
  - NO new R_* code, NO type-table move (drift inventories unchanged but the VERSION bump).
  - The iterator does NOT materialize a record object per row -- yielding a fresh object
    per row is the rejected design (it is the whole reason this is torture-gated).
  - No async iterator (`Symbol.asyncIterator`) -- the reader is synchronous over an owned
    buffer; streaming is lite-query's job (the S6 proof), not a new reader surface.
  - `typescript` stays a DEVdep (S11); no runtime dep added.

===============================================================================
## Decisions for you (recommendation inline)
===============================================================================
  D1 -- SINK ownership: `rows(out)` explicit-sink only, vs ALSO a bare
        `[Symbol.iterator]` over a reader-OWNED reused sink for `for (const r of reader)`.
        RECOMMEND both (explicit fast path + ergonomic default), with the borrowed-array
        warning loud -- mirrors getX (safe/stateless) vs seek+cursor (fast/stateful).
  D2 -- YIELD shape: yield the reused SINK (an Array/TypedArray of field values, the
        readRow model -- RECOMMEND, it composes S4+S11 with zero new concepts) vs yield a
        reused CURSOR object with named getters (`row.f64('x')` -- richer, but a second
        row-view abstraction competing with seek+cursor, more surface, more trap area).
  D3 -- string() -- THE BOUNDARY DECISION (currently a documented NOT-FOR):
        the NOT-FOR says decoding a span into a string "stays with the producer." Adding
        `string(row, id[, len]) -> string` would REVERSE that. A string is a heap value,
        so it can NEVER be zero-GC -- it would be a THIRD documented allocating exception
        (alongside bytes() and the 64-bit BigInt lanes). RECOMMEND: DECLINE for S12 -- keep
        strings with the producer; bytes() already hands the borrowed span and
        `TextDecoder` is one caller line. If ever added, it is a SEPARATE cold, explicitly-
        allocating helper (like bytes()), NOT part of the zero-GC iterator, and it reopens
        the NOT-FOR line as a deliberate scope change -- its own session, not a rider on
        S12. Say "add string()" to fold the decision in; default is decline.
  D4 -- WHETHER this is the last session at all: after S12 the additive-minor track is
        done. Options beyond it are a 2.0.0 (a breaking contract change -- none proposed)
        or pure proof/demo/branding releases (VERSION-const-only, like S5/S6). Say if you
        want S12 to be the final feature session or if there is a surface I have not planned.

===============================================================================
===============================================================================
# Shipped log (most recent first) -- context, not active work
===============================================================================

## S11 -- v1.3.0 -- type-level record inference (Reader.d.ts generic)  [DONE, published]
  Reader.d.ts generic `LiteBinaryReader<S extends readonly Field[] = readonly Field[]>`
  (S inferred from the constructor schema); exported helpers TypeOf<C> / NameOf<S> /
  RowSink / RowTuple<S>; name-safe `field(name: NameOf<S>)`; typed
  `readRow(row, RowTuple<S>): RowTuple<S>` overload beside the permissive
  `readRow<T extends RowSink>`. Backward-compatible: a plain Field[] schema keeps the
  pre-S11 number|bigint unions (fallback overloads). PURE .d.ts -- Reader.js byte-identical
  (VERSION const only at /release). NOT a torture-pipeline session: the gate is a real
  `tsc --noEmit` type-test (test/types/reader.test-d.ts + tsconfig, NodeNext/strict,
  `test:types` script, `typescript` ^7.0.2 DEVdep -- zero runtime dep) + dts-drift extended
  +2 to pin the generic surface with a de-generify teeth control; torture ran only as the
  "runtime did not move" regression. D1=S11, D2a=real tsc test, D2b=safe set (no branded-id
  get) all accepted; the type-test proven non-vacuous (reverting field() to the loose
  signature makes tsc fail TS2578). verify 108/0 (was 106), test:types exit 0, torture ok,
  controls ok; pack still 7 files (test/types is test-only). `/release 1.3.0` green.
  Published; catalog card + suite _index synced to 1.3.0 (typescript tag + typed-inference
  GOOD FOR bullet).

## S10 -- v1.2.0 -- per-field endianness (mixed-endian wire structs)  [DONE, published]
  Optional `Field.littleEndian?` (absent inherits the reader flag) -> one reader reads a
  BE prefix in front of an LE payload. Built via a per-field `_leOf` Uint8Array(0/1) at
  the door (explicit `=== undefined` default -- the BR-03 discipline, so a legitimate
  big-endian `false` is not swallowed); every multi-byte getter / cursor / get / val /
  readRow reads `_leOf[id]` instead of the single `_le`; the laneOf host-endian gate is
  PER FIELD (a mixed reader serves its host-endian fields a lane, declines the
  opposite-endian ones to null). `_le` retained as reader-level introspection only.
  D1 accepted: single `_leOf` array, NOT dual getter classes -- consistent with S13's
  rejection of doubling the getter surface; proven WITHIN-NOISE on bench (n=5 A/B: getX
  1.25 vs 1.22, laneOf identical 0.564, 0 B/op everywhere; an n=3 false alarm I raised
  was corrected by the n=5 run). No new R_* code, no type-table move -- drift inventories
  unchanged but the lock-step VERSION bump. Results byte-identical on any pre-S10 schema.
  Full pipeline (planner -> coder -> reviewer -> qa + torture). Reviewer nit (the
  reader-level `!!` coercion asymmetry) GRANDFATHERED + documented, not fixed -- tightening
  it would reject previously-accepted input in a minor. decisions/0011 records it. verify
  106/0, torture ok, controls ok; `/release 1.2.0` green. Published; catalog card + suite
  _index synced to 1.2.0 (per-field endianness surface).

## Demo refresh (post-1.1.0) -- commit bf35c27  [DONE]
  demo/ only, no module change. T1 compound.mjs zero-alloc join (seek + readRow into
  one reused sink) split from a cold print; T2 standalone.mjs got a 64-bit event record
  (getU64/getI64 + a variable-length bytes(row,id) span) with the BigInt-allocation note;
  T3 NEW demo/webgl-handoff.mjs (laneOf -> exact gl.vertexAttribPointer args, honest
  decline for f64/i64/u64 + BE); V1+V2 NEW demo/visuals.html (byte grids generated from
  the LIVE reader offsetOf/typeOf/stride, a real WebGL upload of reader.buffer, an
  endianness-reinterpret toggle showing 3.5 vs 3.45e-41 on the same 4 bytes, and the
  padding reframe). package.json +demo:webgl; README Demos 3 -> 5. V3 (ecosystem flow
  scene) DEFERRED -- lowest value, most generic; a later branding pass. Suite green
  throughout (101/101, torture ok, controls ok).

## S9 -- v1.1.0 -- 64-bit integer lanes  -- commit f7027f9  [DONE, published]
  T_I64=8 / T_U64=9; getI64/getU64 + cursor i64/u64 + get/val/readRow return
  number|bigint; laneOf yields BigInt64Array/BigUint64Array views. Type table moved
  8 -> 10 in lock-step with the drift gate (the ONE sanctioned 1.0.0-invariant move);
  R_* union unchanged at 10. The 64-bit lanes ALLOCATE (BigInt is a heap value) -- the
  second documented exception alongside bytes(); t6 Gate 5 PROVES it (retain + heapUsed,
  ~32 B/read). All 8 primitive read bodies byte-identical (diff-proven; 0-B/op gates
  intact). D1-D4 accepted as recommended (D2/D4 = no). decisions/0010 records it.
  verify 101/0. Catalog card synced to 1.1.0.
