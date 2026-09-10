# Changelog

All notable changes to `@zakkster/lite-binary-reader`.

## 1.2.0

Per-field endianness (S10). One reader can now read a MIXED-endian record -- e.g. a
big-endian length/type prefix in front of a little-endian payload -- the next step of
"endianness is explicit and owned." Additive: any pre-S10 schema (no per-field
`littleEndian`) reads byte-identically to 1.1.0. No new R_* code and no type-table
move; the `dts-drift` inventories are unchanged.

### Added
- An optional `Field.littleEndian?: boolean` on a schema field. Absent inherits the
  reader-level `littleEndian`; present, it overrides byte order for THAT field only.
- `Reader.d.ts`: the optional `littleEndian` on the `Field` shape, documented as
  inheriting the reader flag and declining a `laneOf` lane when it differs from host.

### Changed
- Every multi-byte read surface (getF64..getU16, getI64/getU64, the cursor reads,
  and the `get` / `val` / `readRow` arms) reads the field's own endianness from a
  per-field `_leOf` table. `getI8`/`getU8` and `bytes()` are endianness-agnostic and
  unchanged. `get littleEndian()` still reports the reader-level flag.
- `laneOf` eligibility is now PER FIELD: a field whose endianness differs from the
  host declines to `null` (served by getX) while its host-endian siblings in the same
  reader still get a lane. An all-default reader's lanes are identical to 1.1.0.

### Notes (the honest boundary)
- "Byte-identical default" means identical RESULTS plus within-noise performance
  (measured on `bench/bench.mjs`), NOT a literal source diff: the getter now reads one
  extra L1 typed-array index (`_leOf[id]`) so it can serve per-field byte order. A
  single `_leOf` array was chosen over doubling the getter surface (decisions/0011, D1;
  consistent with S13's rejection of a second getter class).
- A per-field `false` is honored, never swallowed (the BR-03 discipline). The
  reader-level `littleEndian` keeps its pre-1.2.0 loose coercion (grandfathered to
  avoid a breaking change in a minor); the new per-field flag is strictly
  boolean-or-absent -> `R_BAD_SCHEMA` (decisions/0011).
- Reader-only feature: no sibling translation. `fromBaked` stays native-endian,
  `fromLBK1Shard` stays little-endian by spec.

## 1.1.0

64-bit integer lanes (S9). The one sanctioned move of a frozen 1.0.0 invariant: the
type-code table goes 8 -> 10, in lock-step with the drift gate. Additive -- every
1.0.0 read body for the 8 primitive lanes (codes 0-7) is byte-identical; the new
lanes only ADD switch arms and two methods, never edit an existing one.

### Added
- `T_I64 = 8`, `T_U64 = 9` type codes; `TYPE_BYTES`/`TYPE_CTOR` grow to 10 entries
  (`BigInt64Array` / `BigUint64Array` constructors).
- `getI64(row, id) -> bigint` and `getU64(row, id) -> bigint`; the matching cursor
  reads `i64(id)` / `u64(id)`. `get`, `val`, and `readRow` gain the two cases and
  now return / write `number | bigint`.
- `laneOf` over a 64-bit field returns a `BigInt64Array` / `BigUint64Array` view
  (same host-endian + 8-aligned eligibility). Obtaining the view is 0 B/op; each
  element read allocates a BigInt (labelled an allocating lane).
- `Reader.d.ts`: `T_I64` / `T_U64` literals, the `bigint` getter/cursor signatures,
  and the `number | bigint` union on `get` / `val` / `readRow`.

### Changed
- The type-code table is now **10** (codes 0-9). The `dts-drift` gate's
  `TYPE_COUNT` / `TYPE_BYTES`-length assertions move to 10 in lock-step, with the
  R_* union assertion unchanged at exactly 10 (no new error code).

### Notes (the honest boundary)
- A JS BigInt is a heap value by spec, so a 64-bit read ALWAYS allocates: both
  `getI64`/`getU64` and a `BigInt64Array` element read mint a BigInt (measured
  ~32 B/read retained). i64/u64 is therefore the SECOND documented allocating
  exception alongside `bytes()`; the zero-GC guarantee stays unqualified on the 8
  primitive-number lanes. A new torture gate (t6 Gate 5) PROVES the allocation
  rather than asserting it, while the 8 primitive lanes' 0-B/op gates are unchanged.
- A mixed 64-bit row read with `readRow` needs an `Array` sink (a `Float64Array`
  sink throws on a BigInt cell); an all-64-bit row can use a `BigInt64Array` sink.
- No sibling translation this release: neither lite-bake nor lite-bake-stream mints
  a 64-bit lane today (decisions/0010, D4). `fromBaked` / `fromLBK1Shard` unchanged.

## 1.0.0

Stable release. No runtime change: `Reader.js` is byte-identical to 0.7.0 (only its
`VERSION` const moves, 0.7.0 -> 1.0.0). This version declares the public contract
stable -- breaking any of the frozen items below is a 2.0.0.

### Frozen (the 1.0.0 contract)
- The `R_*` error-code union is exactly **10**: `R_BAD_COUNT`, `R_BAD_LENGTH`,
  `R_BAD_OFFSET`, `R_BAD_SCHEMA`, `R_BAD_SOURCE`, `R_BAD_STRIDE`, `R_BAD_TYPE`,
  `R_BUFFER_TOO_SMALL`, `R_DUPLICATE_FIELD`, `R_UNKNOWN_FIELD`.
- The type-code table is exactly **8** (codes 0-7): `T_F32`, `T_F64`, `T_I32`,
  `T_I16`, `T_I8`, `T_U32`, `T_U16`, `T_U8`.
- The read surface is stable: `getF64`..`getU8` / `get`, `seek` + the cursor reads /
  `val`, `readRow`, `laneOf`, `bytes` (both overloads), `field` / `typeOf` /
  `offsetOf`, and the `fromBaked` / `fromLBK1Shard` cold constructors.
- All three inventories (code union, type table, version) are gated by
  `test/dts-drift.test.js` against `Reader.js`, `Reader.d.ts`, and `package.json`.

### Changed
- `package.json`, `Reader.js` `VERSION`, `llms.txt` (status + API header + `VERSION`
  literal), and the `test/Reader.test.js` version assertion synced to 1.0.0.
- Package status: building -> stable.

### Deferred (additive, post-1.0 -- do not change what 1.0.0 shipped)
- S9 (1.1.0) 64-bit integer lanes (i64/u64 via BigInt) -- the one place the type
  table moves (8 -> 10), in lock-step with the drift gate. S10 (1.2.0) per-field
  endianness. S11 (1.3.0) `.d.ts` record inference (types only). S12 (1.4.0)
  zero-alloc iterator sugar. See `ROADMAP.md` and `decisions/0009-v1.0.0.md`.

## 0.7.0

Benchmark suite: no runtime change. `Reader.js` is byte-identical to 0.6.2 (only its
`VERSION` const moves, 0.6.2 -> 0.7.0). Brought forward ahead of the 1.0.0 freeze so
the endianness split-class question could be answered before the contract locks. The
benchmark and its comparison peers are repo-only (excluded from the tarball -- shipped
file list stays 7).

### Added
- `bench/bench.mjs` (`npm run bench`, `node --expose-gc bench/bench.mjs`): a
  reproducible, seed-replayable benchmark across the four value axes. Modeled on
  `../LiteQuery/bench/bench.mjs` -- warmup, `gc()`-bracketed `process.hrtime.bigint()`
  timing, and both transient and retained bytes/op columns. Every contender is verified
  to decode identical values (an exact checksum vs a `DataView` oracle) before its
  timings are trusted; a `SUMMARY_JSON` footer is emitted for tooling.
  - FAST + ZERO-GC: every read surface vs a hand-written `DataView` loop -- `getX`
    matches the baseline, `laneOf` beats it, all at 0 B/op.
  - vs comparable read libraries on the same tight little-endian record:
    `binary-parser` (the fair marquee, a bulk parser) ~8.6x slower and ~3 B/row where
    the reader allocates nothing; `restructure` and `typed-struct` reported for
    completeness with caveats (their object/lazy-view models are not built for bulk
    primitive decode).
  - TINY: one 9.5 KB (gzip) shipped file, 0 deps, vs 199-484 KB installed peers.
  - SAVES TRAFFIC: fixed-stride binary vs JSON -- ~5.2x smaller raw, ~1.8x gzipped, and
    ~100x cheaper to decode with zero allocation.
- `README.md` `## Performance` section (blueprint spine) + a top-of-file headline
  blockquote citing the multipliers; `llms.txt` Performance section.
- `decisions/0008-benchmark.md`: methodology, fairness discipline, and the split-class
  decision with its data.
- `binary-parser`, `typed-struct`, `restructure` as bench-only devDependencies (the
  comparison peers; not shipped, no runtime dependency added).

### Tests (hardening, prompted by an external review)
- `readRow` IEEE-754 edge fidelity: the t8 schema fuzzer now also fills a `readRow`
  sink at a random row per schema and asserts every cell `Object.is`-equal to the
  `DataView` oracle across BOTH an `Array` and a `Float64Array` sink -- so `readRow`
  inherits the same NaN/-0 bit-exactness `getX` already had. A focused unit test pins
  `readRow` and the cursor against `NaN`, `-0`, and `+/-Infinity` explicitly.
- `readRow` assertions in `test/torture/t2-adversarial.mjs` and `test/Reader.test.js`
  (A2) changed from `===` to `Object.is` (a `===` cell check silently can neither
  prove NaN/-0 fidelity nor survive a NaN fixture).
- Post-construction detach: a new test proves that transferring an `ArrayBuffer` away
  AFTER a reader is built makes a subsequent read throw a CATCHABLE error (no native
  crash, no silent poison) -- the complement to the construction-time `BR-08`/`BR-09`
  doors. (A `SharedArrayBuffer` cannot reach this state; it is non-transferable.)
- Test count 96 -> 98. No `Reader.js` behavioural change.

### Changed
- `README.md`, `llms.txt`, `CHANGELOG.md`, `package.json`, `Reader.js` `VERSION`,
  `test/Reader.test.js` version assertion synced to 0.7.0; test count 96 -> 98.

### Decided (not built)
- The endianness split-class idea (hardcoded-LE / hardcoded-BE getter classes) was
  measured and CLOSED. A literal-endianness getter is ~4% faster in an isolated loop
  (repeatable), but the shipped `getF32` already matches a hand-written `DataView` loop
  and `laneOf` already beats the floor, so the ~4% does not appear in the method callers
  use. Splitting would double the hot-getter surface for a fallback-only micro-gain.
  Reader.js stays byte-identical. Recorded in `decisions/0008-benchmark.md`.

## 0.6.2

Demos: no runtime change. `Reader.js` is byte-identical to 0.6.1 (only its `VERSION`
const moves). Adds the two runnable demos every A-tier sibling ships; both are
repo-only (excluded from the tarball -- shipped file list stays 7).

### Added
- `demo/standalone.mjs` (`npm run demo`): the reader alone -- a foreign big-endian wire
  packet with an UNALIGNED f32 (a layout a typed-array lane and lite-bake cannot
  address) read zero-GC, plus the `laneOf` fast path on a host-endian aligned column
  and its decline on the unaligned/BE field.
- `demo/compound.mjs` (`node demo/compound.mjs`): the ecosystem pipeline -- `@zakkster/
  lite-bake` bakes a parent (orders) and children (line items) table separately, one
  `LiteBinaryReader` per table via `fromBaked`, a caller-side join by key, then a
  `@zakkster/lite-query` `streamQuery` decoding the rows reactively. Deterministic (no
  timers/network); lite-bake and lite-query are demo-only `file:` devDependencies, no
  import edge in the reader.
- `demo/index.html` (`npm run demo:scope`): a browser OSCILLOSCOPE -- three `i16`
  channels packed into an `ArrayBuffer` each frame (like an ADC capture) and decoded
  by `LiteBinaryReader` into live canvas traces; the render loop reads through
  `laneOf()` (a raw `Int16Array` view, zero `DataView` calls / sample), with an
  endianness toggle that flips a "big-endian wire" source to the `getI16` byte-swap
  path (where `laneOf` declines). Imports only `../Reader.js`.
- README "Demos" section and `demo` / `demo:compound` / `demo:scope` npm scripts.

### Changed
- `VERSION` 0.6.1 -> 0.6.2 (`Reader.js`, `package.json`, `llms.txt`).

## 0.6.1

A hardening pass: no runtime change. `Reader.js` moves only its `VERSION` const;
every read body is byte-identical to 0.6.0. Adds a schema-space fuzzer and two
negative/doc-drift gates, all pre-1.0 belt-and-braces.

### Added
- Torture tier `t8` (schema-space fuzz): thousands of RANDOM legal schemas -- random
  field count, a random subset/order of the 8 type codes, random inter-field padding
  (arbitrary, often unaligned offsets), random stride tail pad, LE or BE -- read
  cell-for-cell (`Object.is`) against a `DataView` oracle built from the same layout.
  Seed-replayable (`TORTURE_SEED`), non-vacuous (all 8 lanes + both endiannesses),
  with a deliberate wrong-offset teeth control. Exercises the layout arithmetic the
  fixed-schema tiers cannot.
- `test/bytes-alloc-boundary.test.js`: a negative gate pinning that `bytes()` mints a
  FRESH view per call -- it stays a cold-path allocator and cannot be silently pooled
  into the zero-GC hot path (which would let it ship under a false zero-alloc claim).
- `test/readme-codes.test.js`: asserts every `R_*` code the README names is one
  `Reader.js` actually throws (subset check), with the thrown union pinned at 10 and a
  positive control. Complements the `.d.ts` drift guard.

### Changed
- Test count 90 -> 96 (the two gates above); torture gains tier `t8`.
- `VERSION` 0.6.0 -> 0.6.1 (`Reader.js`, `package.json`, `llms.txt`).
- `test/coop-lbk1.test.js`: a version-pin comment recording the
  `@zakkster/lite-bake-stream` floor the LBK1 proof was verified against, so a major
  bump is a conscious re-verify rather than a silent drift.
- Docs: a "not a concurrency primitive" boundary note (README + llms.txt) -- reads over
  a `SharedArrayBuffer` like any `DataView`, but provides no atomics; cross-worker
  synchronization is the caller's.

## 0.6.0

A PROOF/EXAMPLE release: no runtime change. `Reader.js` moves only its `VERSION`
const; every read body is byte-identical to 0.5.0. This release proves the reader
drops into a real `@zakkster/lite-query` `streamQuery` `stream:` generator and
decodes binary zero-GC, abort-clean, with no import edge.

### Added
- `test/coop-query.test.js`: the streaming-adapter proof. (a) A FOREIGN fixed-stride
  feed wrapped per window in `LiteBinaryReader` inside a real `streamQuery` (latest
  mode), yielding primitives (`readRow` into a hoisted reused sink), observed
  in order; (b) a real `@zakkster/lite-bake-stream` shard read through
  `fromLBK1Shard` inside the stream, F64 cells bit-exact vs bake-stream's own Reader.
  Plus abort-on-detach (the generator cancels its in-flight source; no value after
  abort), reactive-key restart, the structural zero-alloc frame path, and the D9
  copy-what-you-keep ownership boundary.
- `test/peer-surface.test.js`: a fail-closed guard asserting the lite-query symbols
  this session consumes (`queryClient`, `streamQuery`, the handle shape) exist at
  runtime -- nothing trusted from a peer's docs.
- `test/helpers/query-observer.mjs` (repo-only helper): observes a lite-query handle
  through the SAME lite-signal instance lite-query resolves (the peer-dedup topology
  a published consumer has), plus the foreign-window + cancellable-source utilities.
- `examples/streamQuery-adapter.md` (repo-only, not shipped): the runnable adapter.
- `Cookbook.md`: recipes R6 (stream a foreign feed) and R7 (`fromLBK1Shard` inside a
  streamQuery), each citing its passing test.
- `decisions/0007-lite-query-adapter.md`: the recipe scope, the zero-alloc boundary,
  the signal-cancel contract, the D9 ownership boundary, and the temporary devDeps.

### Changed
- Test count 81 -> 90 (the streaming-adapter and peer-surface suites above).
- `VERSION` 0.5.0 -> 0.6.0 (`Reader.js`, `package.json`, `llms.txt`).
- `@zakkster/lite-query` (plus its `@zakkster/lite-signal` / `@zakkster/lite-stream`
  peers) added as TEST-only `file:` devDependencies; consumed by the test only,
  excluded from the published tarball. These devDeps are temporary and are to be
  reconsidered at the S8 v1.0.0 gate (decisions/0007).
- The torture harness is unchanged and stays sibling-free: the reader's per-frame
  contribution (`readRow` into a reused sink) is already gated at 0 B/op by torture
  t6; the streaming proof lives only in `npm test`.

## 0.5.0

A PROOF release: no runtime change. `Reader.js` moves only its `VERSION` const; the
cold cooperation constructors (`fromBaked`, `fromLBK1Shard`) and every read body are
byte-identical to 0.4.0. This release proves those constructors against the siblings'
REAL output instead of emulated bytes.

### Added
- `test/coop-bake.test.js`: `fromBaked` reads `@zakkster/lite-bake`'s real baked
  output cell-for-cell against lite-bake's own `Reader`, across all 8 lanes. Offsets
  and stride are read from lite-bake's reported layout, never recomputed.
- `test/coop-lbk1.test.js`: `fromLBK1Shard` reads a real `@zakkster/lite-bake-stream`
  shard -- F64 cells bit-exact (`Object.is`), a U32 lane read as the raw string-table
  INDEX (string resolution stays in bake-stream, by contract). Includes the D3
  no-translate CONTROL: reading the LBK1 U32 lane without the wire-to-ours code
  translation (wire 3 read raw as our T_I16) must diverge -- teeth on the translation.
- `test/coop-multireader.test.js`: a test-only `ShardUnion` mapping a global row to
  (shard, localRow) over same-schema shards, matched against bake-stream's own reader.
- `test/coop-join.test.js`: a query-builder PARENT + CHILDREN result -- each table
  baked separately, one `LiteBinaryReader` per table, joined parent-to-children by key
  in caller code (different schemas joined by key is a recipe, not a shipped API).
- `test/no-import-edge.test.js`: asserts `Reader.js` and `Reader.d.ts` import no
  sibling (`from "@zakkster/..."`) -- the D10 no-import-edge law, enforced not claimed.
- `test/mock/fixtures.js`: named flat fixtures (single-lane, all-8-lane, nested-then-
  flattened, NaN/+/-Infinity/-0 on F64, a real-data sample) driving both coop paths.
- `Cookbook.md` (repo-only, not shipped): five recipes beginner to pro, each citing
  its passing test; the flagship is the parent/children multi-reader join.
- `decisions/0006-cooperation-proof.md`: the rulings, the D3 wire-code map, the
  U32-is-a-string-index ownership boundary, and the `payload_len`/count risk + guard.

### Changed
- Test count 73 -> 81 (the cooperation-proof suites above).
- `VERSION` 0.4.0 -> 0.5.0 (`Reader.js`, `package.json`, `llms.txt`).
- `@zakkster/lite-bake` and `@zakkster/lite-bake-stream` added as `file:`
  devDependencies -- consumed by the TEST only; excluded from the published tarball.
- The torture harness is unchanged and stays sibling-free: `node --expose-gc
  test/torture.mjs` still runs standalone with its emulated oracles.

## 0.4.0

### Added
- `laneOf(fieldId)`: an opt-in native typed-array lane offered alongside `getX` for
  the hot loop over one column. A lane-eligible field returns a precomputed, frozen
  `{ view, elemStride, elemOffset }` read as `view[row*elemStride + elemOffset]` (no
  `DataView` call, no branch); an ineligible field, or an out-of-range id, returns
  `null` and is served by `getX`. Resolve it once outside the loop, like `field()`;
  the call is a lookup that allocates nothing and returns the same descriptor each time.
- Eligibility is computed cold at construction: a field is lane-eligible iff the
  reader is host-endian (`littleEndian === IS_LITTLE_ENDIAN`), the field's first byte
  is aligned (`(byteOffset + field.offset) % width === 0`), and the stride keeps every
  row aligned (`stride % width === 0`). A width-1 field (`T_U8`/`T_I8`) is always
  eligible on a host-endian reader. There is no unaligned lane and no in-lane
  endianness swap: `laneOf` hands back a host-order typed read or declines.
- At most one typed view per present eligible type is built cold over the owned
  buffer; this is the only new construction-time allocation.
- `Reader.d.ts`: a `Lane` interface (the eight TypedArray view types plus `elemStride`
  and `elemOffset`) and `laneOf(fieldId): Lane | null` on the class.

### Changed
- Test count 60 -> 73 (the `laneOf` boundary suite: eligibility across all 8 types,
  the decline contract on unaligned/odd-stride/opposite-endian/out-of-range fields,
  frozen-descriptor identity, and lane-vs-`getX` parity including a BR-07 partial-window
  source).
- Torture: a t5 lane-vs-`getX` differential across the alignment x endianness x type
  matrix, a t6 zero-alloc + retained gate for the `laneOf` call and the lane read loop,
  and a t9 control that mutates a lane's `elemStride`/`elemOffset` to prove the
  differential has teeth (plus non-vacuous decline checks).
- The drift gate's class-member floor raised 31 -> 32 for `laneOf`. The `R_*` union
  stays exactly 10 and the type-code table exactly 8 (no new code of either kind).
- The v0.3.0 numeric read bodies (`getF64`..`getU8`/`get`/`bytes`/`seek` + `f64`..`u8`/
  `val`/`readRow`) are byte-identical: `laneOf` is a second read path added beside them,
  with no per-read eligibility branch in any pinned getter.

## 0.3.0

### Added
- Row cursor: `seek(row)` (chainable, returns `this`) plus `f64`/`f32`/`i32`/`u32`/
  `i16`/`u16`/`i8`/`u8(fieldId)` and `val(fieldId)`, which read at the seeked row
  without re-passing it. The cursor read bodies inline the same address arithmetic
  as `getF64`..`getU8`/`get`; each is zero-allocation in steady state.
- `readRow(row, out)`: fills a caller-owned sink indexed by field id (`Array` or any
  `TypedArray`), no record object materialized; returns `out`. A sink that is null,
  has no numeric `length`, or is shorter than `fieldCount` throws `R_BAD_LENGTH`
  before any write.
- Variable-length `bytes(row, fieldId)`: a two-argument overload that resolves the
  span length from a sibling field named by a new optional `lengthField` on a schema
  field. Dispatched on `len === undefined`; the resolved length flows through the
  existing `R_BAD_LENGTH` / `R_BUFFER_TOO_SMALL` doors. The three-argument
  `bytes(row, fieldId, len)` is unchanged.
- `Reader.d.ts`: declarations for `seek`, the eight cursor reads, `val`, `readRow`,
  the two-argument `bytes` overload, and the optional `Field.lengthField`.

### Changed
- Test count 49 -> 60 (cursor/`readRow`/variable-length boundary and adversarial
  cases, including nonzero-base and partial-view sources, `readRow` door and
  reentrancy, and out-of-contract-row fail-closed).
- Torture: a t5 cursor-vs-`getX` differential, dedicated t6 zero-alloc + retained
  gates for the cursor and `readRow` surfaces, and t9 controls for the cursor,
  the `readRow` door, and the variable-length span.
- The drift gate now also asserts the type-code table stays at 8 entries, alongside
  the existing exactly-10 `R_*` union check.

## 0.2.0

### Added
- `Reader.d.ts`: hand-written ambient TypeScript surface for the full runtime API
  (`VERSION`, `T_*` type-code literals, `IS_LITTLE_ENDIAN`, `Field`/`Options`/`Baked`/`Shard`,
  the reader class with all getters/methods/statics, and `LiteBinaryReaderError` with a
  `code` union of all 10 `R_*` tags).
- `test/dts-drift.test.js`: a drift gate asserting the `.d.ts` error-code union, value
  exports, and version stay in lock-step with `Reader.js` and `package.json`, with mutation
  controls proving the gate has teeth.

### Fixed
- BR-08: a detached `ArrayBuffer` (and a view over a detached buffer) now throws a coded
  `R_BAD_SOURCE` instead of a raw `DataView` `TypeError`. Detection via an
  `ArrayBuffer.prototype.detached` probe (Node 21+) with a guarded `DataView` fallback on
  the `node>=18` floor; a legitimately zero-length buffer is not misclassified as detached.
- BR-09: a `DataView` source over a detached buffer now throws a coded `R_BAD_SOURCE`. A
  `DataView`'s `byteOffset`/`byteLength` getters throw on a detached buffer (unlike a
  `TypedArray`'s, which return 0), so the view branch now probes the underlying buffer for
  detachment before reading any view getter.

### Changed
- Torture door matrix expanded to 2700 cells across 6 source kinds (added a `DataView`
  kind and a detached kind); added a t9 detached-door control (teeth + non-vacuity).
- Test count 37 -> 49.

## 0.1.2

### Fixed
- BR-01: a `byteOffset` past the buffer end now throws `R_BAD_OFFSET` (was a silent
  negative derived count).
- BR-02: a non-integer type code now throws `R_BAD_TYPE` (was a silent retype and read-past).
- BR-03: a `NaN`/`Infinity`/fractional `byteOffset` now throws `R_BAD_OFFSET` (was swallowed
  by `|| 0` and read as offset 0).
- BR-04: a duplicate field name now throws `R_DUPLICATE_FIELD` (was a silent shadow).
- BR-05: `bytes()` past the buffer or with a bad length now throws `R_BUFFER_TOO_SMALL` /
  `R_BAD_LENGTH` (was a raw `RangeError` with no `.code`).
- BR-06: `fromBaked` / `fromLBK1Shard` given a malformed source now throw `R_BAD_SOURCE` /
  `R_BAD_SCHEMA` (was a raw `TypeError` while dereferencing the argument).
- BR-07: a zero-offset partial view no longer reads past its own window; a non-full-span
  view is copied to an owned window so a derived or explicit count can never exceed the
  bytes the view owns.

## 0.1.0

### Added
- Initial `LiteBinaryReader`: a zero-dependency, zero-GC `DataView` reader over a
  caller-supplied `{schema, stride, count, byteOffset, littleEndian}` layout. Typed getters
  (`getF64`..`getU8`), a data-driven `get`, a borrowed-view `bytes()` escape hatch, name
  resolution (`field`/`typeOf`/`offsetOf`), and the `fromBaked` / `fromLBK1Shard` sibling
  cooperation constructors.
