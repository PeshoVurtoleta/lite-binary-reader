# 0003 -- the detached-source door (BR-08) + the .d.ts drift guard

Status: accepted (v0.2.0). Context: S2 closed BR-01..BR-06; the S2 QA adversarial
sweep found BR-08 (a detached ArrayBuffer throws a raw `TypeError` at
`new DataView`, not a coded `R_*`) and deferred it here alongside the new
TypeScript surface (`Reader.d.ts`) and its drift gate. Both land as cold-path /
test-only additions; the numeric read hot path (`getF64..getU8`, `get`, `bytes`)
is BYTE-IDENTICAL to v0.1.2.

## Why R_BAD_SOURCE, not a new R_DETACHED code

A detached buffer IS a bad source: its backing store has been transferred away, so
there are no bytes to read. It is the same failure CLASS as a plain array or a
`null` -- "the thing you handed me is not a live sequence of bytes." Minting an
11th code (`R_DETACHED`) would split one concept across two greppable tags for no
caller benefit: a caller catches `R_BAD_SOURCE` and fixes their source either way.
Keeping the union at exactly 10 is also a hard suite constraint the drift gate now
enforces (`failCodes(JS).size === 10`). So the detached case reuses `R_BAD_SOURCE`
and the message ("source ArrayBuffer is detached") carries the specificity.

## The detached-detection technique

A detached buffer reports `byteLength === 0` yet is still `instanceof ArrayBuffer`,
so it must be DISTINGUISHED from a legitimately zero-length buffer
(`new ArrayBuffer(0)`), which is live and constructs a valid count-0 reader. The
check keys on detachment, never on `byteLength === 0`.

`isDetached(buffer)` (module scope, cold path):
  1. `byteLength > 0` -> not detached (fast path; only length 0 is ambiguous, so
     the probe never runs for a normal buffer).
  2. else if `HAS_DETACHED` -> read the standard `buffer.detached === true`.
  3. else -> `try { new DataView(buffer); return false } catch { return true }`.

`HAS_DETACHED` is a module-load feature probe beside `IS_LITTLE_ENDIAN`:
`typeof Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "detached") === "object"`.
`ArrayBuffer.prototype.detached` is Node 21+ / modern browsers only. On the
package floor (`engines: node>=18`) `HAS_DETACHED` is FALSE, so the
guarded-DataView fallback (step 3) is the REAL detection path there -- a live
zero-length buffer constructs a DataView fine; a detached one throws. Both branches
are covered by Reader.test.js BR-08 and t9 Control 10.

For an ArrayBuffer source the check sits AFTER the source coercion if/else and
BEFORE schema validation (the `buffer = source` case). For a VIEW source the
detached check must run INSIDE the `ArrayBuffer.isView(source)` branch and BEFORE
any of the view's own getters are read -- see BR-09 below for why. Both catch a
dead backing store at the same coded `R_BAD_SOURCE` door before `new DataView`.
The harness `checkCoherence` re-derives the SAME probe locally (the harness
imports nothing from Reader.js source, by rule) and flags a detached source before
its schema checks, so the door <-> coherence agreement law holds on all t2 matrix
cells.

## Why the view detached check must precede any view getter (BR-09)

The first draft of BR-08 placed the single `isDetached(buffer)` guard AFTER the
coercion if/else, on the RESOLVED `buffer`. That is correct for an ArrayBuffer and
for a TypedArray view (whose `byteOffset`/`byteLength` getters return `0` on a
detached buffer, so the full-span test just resolves `buffer = source.buffer` and
the post-coercion guard fires). It is NOT correct for a `DataView`: unlike a
TypedArray, `DataView.prototype.byteOffset` / `byteLength` are getters that THROW a
raw `TypeError` when the backing buffer is detached. So the view branch's
`source.byteOffset === 0 && source.byteLength === source.buffer.byteLength` test
read a THROWING getter and escaped with an uncoded `TypeError` before the
resolved-buffer guard was ever reached. A DataView is `ArrayBuffer.isView`-true and
a documented source (`Reader.d.ts`: `ArrayBuffer | ArrayBufferView`), so this is a
supported shape, and the BR-08 tests never fed one.

The fix: probe `isDetached(source.buffer)` INSIDE the view branch, BEFORE the
full-span getter test. `source.buffer` is a plain ArrayBuffer whose
`byteLength`/`detached` getters do NOT throw on a detached backing store, so the
probe is always safe. This closes a detached DataView AND a detached TypedArray at
the same coded door and never touches a throwing view getter or reaches
`new DataView` with a dead store. The general rule this codifies: for a view
source, NEVER read a view-owned getter before proving the backing buffer live --
read only `source.buffer`, whose getters are total. The `detached` and new
`dataview` source kinds in the t2 matrix (now 2700 cells) pin the agreement law.

## The drift guard's three inventories (test/dts-drift.test.js)

Shipping a hand-written `.d.ts` is only safe if a gate proves it never drifts. The
guard reads file TEXT (never imports) and asserts three regex-derived inventories:

  (a) code-union parity : the `R_*` tags at `fail("R_...")` CALL SITES in Reader.js
      (regex, NOT the header comment) EQUAL the `R_*` literals in the
      `type ReaderErrorCode` union in Reader.d.ts. Set equality both ways; the
      union stays exactly 10. This is what would catch a forgotten
      `R_DUPLICATE_FIELD`/`R_BAD_LENGTH`.
  (b) export parity : the value exports (`const`/`class`/`function` + `default`) of
      Reader.js EQUAL the value exports of Reader.d.ts; every member the d.ts class
      declares is a real member of the source class.
  (c) version parity : the `VERSION` literal in Reader.js EQUALS the `version` in
      package.json. The `.d.ts` carries NO version literal (deliberately, to keep
      one owner of the three-place sync); if a future `.d.ts` adds one, extend this
      assertion.

Each check is a PURE function over text, so the same function proves teeth: three
mutation controls feed it a mutated COPY (drop one union member; delete the
`IS_LITTLE_ENDIAN` export; change the version) and assert it then reports a diff; a
vacuity control asserts the unmutated text reports zero diffs.

## S7 CHANGELOG breadcrumb

S7 records (under the appropriate headings): Fixed -- BR-08: a detached
ArrayBuffer (and a view over one) now throws a coded `R_BAD_SOURCE` instead of a
raw DataView `TypeError`; BR-09: a DataView source over a detached buffer now
throws the same coded `R_BAD_SOURCE` instead of a raw `TypeError` from a throwing
`DataView` getter (the view-branch detached probe was moved ahead of any view
getter). Added -- `Reader.d.ts` ambient TypeScript surface, guarded against drift
by `test/dts-drift.test.js`.
