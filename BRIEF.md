# S11 -- v1.3.0 -- type-level record inference in Reader.d.ts  [IMPLEMENTED -- awaiting /release 1.3.0 + publish]

status: IMPLEMENTED + verified (all recommendations accepted: D1=S11, D2a=real tsc
type-test, D2b=safe set only -- no branded-id get). Reader.js is BYTE-IDENTICAL
(untouched this session; the VERSION const bumps at `/release`). This was a `.d.ts` +
type-test session, NOT the coder -> reviewer -> qa torture loop: the gate is a TYPE-LEVEL
`tsc --noEmit` compile test + the extended dts-drift assertion, with `torture` run only
as the "runtime did not move" regression. GATE RESULTS: `npm run verify` green (npm
test 108/0 -- was 106, +2 dts-drift generic-surface checks; `test:types` tsc exit 0;
torture prints "ok"; controls "ok"); the type-test has teeth (reverting field() to the
loose signature makes tsc fail TS2578 unused-@ts-expect-error); pack still 7 files
(test/types/ is test-only). Additive minor: 1.2.0 -> 1.3.0. No new R_* code, no
type-table move -- the drift gate's three inventories (R_* union 10, type table 10,
VERSION===package.json) are unchanged except the lock-step VERSION bump at `/release`.

WHAT LANDED: Reader.d.ts is generic `LiteBinaryReader<S extends readonly Field[] =
readonly Field[]>` (S inferred from the constructor `schema`); new exported type helpers
`TypeOf<C>` / `NameOf<S>` / `RowSink` / `RowTuple<S>`; `field(name: NameOf<S>)` (name-safe);
a typed `readRow(row, RowTuple<S>): RowTuple<S>` overload beside the permissive
`readRow<T extends RowSink>(row, T): T`; `Options<S>` threads the schema type. Backward-
compatible: a plain `Field[]` schema keeps the pre-S11 number|bigint unions. Gate:
`test/types/reader.test-d.ts` + `test/types/tsconfig.json` (NodeNext, strict), `test:types`
script folded into `verify`; `typescript` ^7.0.2 devDep only (package-lock is gitignored;
package.json is the tracked source of truth). dts-drift +2 checks pin the generic surface
(class generic + helpers + field()/readRow signatures) with a de-generify teeth control.
Docs: CHANGELOG 1.3.0, README "Typed reads (TypeScript)" subsection + test count 106->108
+ test:types line, llms.txt Status S11 paragraph. NOT bumped this session (per plan): the
four VERSION sites -- Reader.js:80, package.json, llms.txt Status/API/VERSION, and the
README/llms version strings -- all move together at `/release 1.3.0`.

--- original plan (for reference) ---

why_now: two consecutive HOT-PATH module changes just shipped back to back (S9 64-bit
lanes, S10 per-field endianness). S11 is the lower-risk DX counterpart -- pure types,
zero runtime risk -- and it closes the one competitive gap the S13 bench review named
against the TS-first readers (typed-struct, restructure): a `const`-typed schema should
infer TYPED reads (a per-field `number` / `bigint`) instead of the bare `number|bigint`
union `get`/`readRow` return today. It is also a genuinely DIFFERENT kind of session --
a types + type-test session, no torture loop -- which is a healthy change of pace and a
clean, self-contained win before the heavier S12 iterator work.

===============================================================================
## What exists today (grounded in Reader.d.ts, not assumed)
===============================================================================
  - `LiteBinaryReader` is declared as a NON-generic class. `field(name)` takes
    `string|number` and returns `number`; `get(row,id)` / `val(id)` return
    `number|bigint`; `readRow(row,out)` takes a loosely-typed sink; the per-type
    getters (getF64..getU8 -> number, getI64/getU64 -> bigint) are already precise.
  - The `Field` interface carries `{ name, type, offset, lengthField?, littleEndian? }`.
    `T_F32=0 .. T_U8=7` (number lanes), `T_I64=8 / T_U64=9` (bigint lanes) are const
    literals -- so the RETURN type of a field is a pure function of its `type` code, but
    nothing in the .d.ts derives it from a schema literal.
  - A caller passing a `const`-typed schema gets NO inference: `field('typo')` compiles,
    `get(0, id)` is `number|bigint` regardless of the field's real type, and `readRow`'s
    sink is untyped per slot.
  - The dts-drift gate (`test/dts-drift.test.js`) reads the TEXT of Reader.js / .d.ts /
    package.json via regex and asserts the R_* union (10), the type table (10), and
    VERSION agreement. It does NOT type-check -- a generic surface cannot be kept honest
    by regex alone (see D2).

===============================================================================
## The design (a backward-compatible generic; the reach is the real decision)
===============================================================================
  Make the class generic over the schema literal, with a DEFAULT param so every
  existing call site compiles unchanged:

      class LiteBinaryReader<S extends readonly Field[] = readonly Field[]>

  Two small type-level helpers do the work:
    - `TypeOf<C>`  -- maps a `type` code literal to its TS type: `0..7 -> number`,
      `8|9 -> bigint`. One conditional type; mirrors TYPE_BYTES' number/bigint split.
    - `NameOf<S>`  -- the union `S[number]['name']`, the set of field names actually in
      the schema. `field(name: NameOf<S>)` makes a typo a COMPILE error (the runtime
      still throws R_UNKNOWN_FIELD; the type just catches it one step earlier).

  THE SCOPE DECISION (D2b): the clean, low-risk, high-value wins are the generic class
  param + `NameOf` name-safety on `field()` + a TYPED `readRow` sink (a tuple keyed by
  field order, each slot `TypeOf<S[i]['type']>`). The HARDER reach is typing
  `get(row, id)` per field: `id` is a runtime integer, so precise per-id return typing
  needs field ids BRANDED with their type (a `FieldId<T>` phantom returned by a typed
  `field()`), which is a bigger .d.ts surface and the classic way an inference feature
  becomes unmaintainable. Recommend: ship the safe set now; hold branded-id `get`
  typing as a STRETCH only if the type-test shows it stays legible. Over-reaching the
  .d.ts is a rejected design, same discipline as "no doubled getter surface" (S13/D1).

  BACKWARD COMPAT is non-negotiable: every generic signature keeps a fallback overload
  matching today's surface, so an untyped or non-`as const` schema resolves EXACTLY to
  the current `number|bigint` unions. This ADDS inference; it never narrows an existing
  call in a way that could stop compiling.

===============================================================================
## Tasks (types + a type-test; NO coder/reviewer/qa torture loop)
===============================================================================
  T1  Reader.d.ts: `LiteBinaryReader<S extends readonly Field[] = readonly Field[]>`;
      `TypeOf<C>` (code -> number|bigint); `NameOf<S>` (name union); typed `field()`;
      typed `readRow` sink (tuple). Keep the non-generic fallback overloads so existing
      code compiles untouched. (Stretch, D2b: branded `FieldId<T>` + typed `get`/`val`.)
  T2  The gate (D2a): add `test/types/reader.test-d.ts` type-assertions compiled by
      `tsc --noEmit`, wired as a `"test:types"` script (adds a `typescript` DEVdep only --
      zero runtime dep, ships nothing). It asserts BOTH the new inference AND that the
      legacy untyped path still resolves to the old unions. RECOMMEND this over a
      text-only drift extension -- a typed surface with no compile test is exactly the
      d.ts drift the roadmap flags as a recurring finding class.
  T3  dts-drift: extend `test/dts-drift.test.js` to assert the generic surface is present
      (class declared generic; the fallback overloads exist) so a later edit cannot
      silently drop the generics and regress to bare unions.
  T4  Reader.js: VERSION const only, at `/release` (byte-identical otherwise). Prove the
      runtime did not move: `npm run torture` prints "ok" unchanged; `npm test` green
      with the SAME 106 count (the type-test is a separate `test:types` run, not a
      node:test case).
  T5  Docs: CHANGELOG 1.3.0 "Added" (typed reads from a `const` schema; backward-compat
      note); llms.txt + README -- one "typed reads" example with `as const`, and the
      explicit "untyped schema keeps the old unions" line. ASCII-only; grep new files
      for stray tool-call tags. No new file enters `files[]` (type-test is test-only).

===============================================================================
## Assertions (the DONE-WHEN, each falsifiable)
===============================================================================
  - With a `const`-typed schema: `field('notAField')` is a COMPILE error; `field('x')`
    resolves; `readRow` yields a typed tuple (number for 0..7 fields, bigint for i64/u64).
  - Legacy path intact: an untyped / non-`as const` schema returns today's `number|bigint`
    unions and every existing call site still compiles (a fallback-overload test proves it).
  - `tsc --noEmit` over `test/types/` passes (D2a); dts-drift green (R_* 10, type table
    10, VERSION 1.3.0, generic surface present).
  - Runtime UNCHANGED: `npm test` 106/0; `node --expose-gc test/torture.mjs` prints "ok";
    controls ok; `git diff Reader.js` is VERSION-only.
  - Pack still 7 files (no type-test, no new source file, ships in the tarball).

===============================================================================
## Non-goals / boundaries
===============================================================================
  - No runtime change; no new R_* code; no type-table move (drift inventories unchanged
    but the VERSION bump).
  - No branded-id `get(row,id)` per-field typing unless the D2b stretch is taken (id is a
    runtime int; branding is a larger, riskier .d.ts surface).
  - Not a torture-pipeline session -- types do not allocate, so there is no new tier and
    no coder/reviewer/qa loop; torture runs only as the "runtime did not move" regression.
  - `typescript` is a DEVdep for the type-test only -- the zero-runtime-dep law is intact.

===============================================================================
## Decisions for you (recommendation inline)
===============================================================================
  D1 -- WHICH session next: S11 (RECOMMEND) vs S12. S11 is pure types, zero runtime
        risk, closes the typed-read gap, and is a lighter different-kind session after
        two back-to-back hot-path releases. S12 (v1.4.0, zero-alloc `for-of` iterator)
        is higher user value but a TORTURE-GATED module change (the reused-result-object
        0-B/op trap -- a naive generator FAILS the gate) AND it carries the `string()`
        boundary decision (does string-decoding move into the reader, or stay with the
        producer?). Say "S12" to flip; both are additive minors and order-independent.
  D2 -- S11 gate + reach (only if D1 = S11):
        D2a -- gate: a real `tsc --noEmit` type-test (RECOMMEND; adds a `typescript`
               devDep + `test:types` script, no runtime dep) vs a lighter text-only
               dts-drift extension (weaker -- cannot actually check inference).
        D2b -- reach: the safe set {generic class, `field()` name-safety, `TypeOf`
               mapping, typed `readRow` tuple} (RECOMMEND) vs ALSO branding field ids so
               `get(row,id)` is typed per field (bigger .d.ts surface -- stretch only).

===============================================================================
===============================================================================
# Shipped log (most recent first) -- context, not active work
===============================================================================

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
