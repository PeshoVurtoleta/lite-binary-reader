# @zakkster/lite-binary-reader -- enriched roadmap (A+ tier target)

Eight BRIEF sessions on one greenfield package, plus a shared torture-suite spec
and a findings table that every session is anchored to.

**Why it grew.** The first draft of this roadmap assumed `Reader.js` was small,
pure and correct -- "smoke-verified 21/21" -- and that the work ahead was tests,
docs, and additive API. Following the discipline of `../BLUEPRINT_ROADMAP.md`, I
pulled the file and ran it instead of reading it. It is not correct. Six findings
are listed in section 2 and **every one was reproduced from a five-line probe**,
not inferred. Two of them are S1: an incoherent input crosses the construction
door, is silently accepted, and surfaces as garbage or a read past the buffer --
in the one module whose entire contract is "fail closed at the door, then read
without checking." A door that fails open is not a smaller bug in a reader; it is
the bug.

The testing spec (section 4) is modeled on the three packages this module is
built to cooperate with -- `lite-bake`, `lite-bake-stream`, and `lite-query` --
all of which ship a ten-tier torture gate with a seeded-replay harness, a
retained-alloc gate that closes V8's async-GC blind spot, and in-process controls
that prove every gate can fail. This roadmap adopts that machinery verbatim
rather than inventing a lighter one.

**State.** v0.1.0 shipped the core: `Reader.js` (a `DataView` reader over a
caller-supplied offsets/type table), `package.json`, `LICENSE`,
`decisions/0001-structure.md`. The load-bearing capability works -- an `f64`
read at byte offset 1, which a `Float64Array` view cannot construct, is
bit-exact (probe P4); explicit endianness byte-swaps correctly (C3); the generic
`get` matches every typed `getX` (C4); and a pooled/offset view is copied so
poison outside its window is never read (P12). But the door is porous (section 2),
and none of the test/torture/docs/`.d.ts`/cooperation work exists yet.

| Piece | State |
| --- | --- |
| `Reader.js` core (getX/get/field/bytes/fromBaked/fromLBK1Shard) | **built; capabilities verified, door porous (BR-01..BR-06)** |
| package scaffold (package.json, LICENSE) | **built; metadata verified self-consistent (section 0)** |
| decisions/0001-structure | **written** |
| node:test suite + torture harness + controls + findings visible | S1 |
| fail-closed door: fix BR-01..BR-06 | S2 |
| Reader.d.ts | S3 |
| API sugar (row cursor, out-param fill, variable-length, typed lanes) | S4 |
| cooperation proof: lite-bake / lite-bake-stream | S5 |
| cooperation adapter: lite-query streaming | S6 |
| README + llms.txt + CHANGELOG | S7 |
| release gate | S8 |

---

## 0. Scope + metadata check (do this before trusting a devDep or a URL)

The published scope is **`@zakkster`** (one `s`) -- the CLAUDE.md law and every
sibling `package.json` agree. `@zakksters/*` does not exist; the BLUEPRINT caught
a devDep line pointing at the non-existent scope. `Reader.js` imports nothing
(D10), and `package.json` devDeps are `@zakkster/lite-gc-profiler` and
`@zakkster/lite-leak` -- both correct.

**Metadata is NOT cross-wired here** -- verified, not assumed. The BLUEPRINT found
`@zakkster/lite-arena@1.4.0` shipping `homepage`/`repository`/`bugs` all pointing
at `lite-scheduler`. This package's three URLs all resolve to
`github.com/PeshoVurtoleta/lite-binary-reader`, and `PeshoVurtoleta` is the
suite-wide org (548 references across the ecosystem's `package.json` files; the
only anomalies are 3 stray `github.com/zakkster` and 1 `nicatspark` elsewhere,
none in this package). So the repo name matches the package and the org matches
the norm.

The one residual check, deferred to S8 because it needs the registry and cannot
be done offline: confirm `@zakkster/lite-binary-reader` and the
`PeshoVurtoleta/lite-binary-reader` repo actually exist and are the intended
homes before `/release`. Do not inherit a sibling's URL on a later copy-paste.

---

## 1. Shared law (holds every session)

Inherited from `../CLAUDE.md`, plus reader-specific rules:

1. **Zero allocation on the read hot path.** `getX` / `get`. All allocation and
   branching live at the construction DOOR or the throw path. Proven by the T6
   gate AND the retained-alloc gate (section 4). Bytes in a hot body, not
   instructions.
2. **Fail closed at the door.** Every incoherent input throws a coded `R_*` error
   BEFORE any read. null is not zero. A too-small buffer is refused, never read
   past. The read methods stay unchecked (stated contract) so the door pays the
   cost once, not every read. **This law is currently broken three ways
   (BR-01, BR-02, BR-03); S2 makes it true.**
3. **The reader never mutates the bytes.** It is read-only by definition; a
   returned `bytes()` view is BORROWED ("copy what you keep", D9). No method
   writes through to the buffer.
4. **Endianness is explicit and owned (D4).** No read assumes host order. This is
   the portability hole the siblings leave open; owning it is a core feature, and
   every read path must carry `_le`.
5. **Type codes are unambiguous at every boundary (D3).** Our table is lite-bake's
   `Types`; any foreign table (LBK1 `lane_kind`) is TRANSLATED at ingress. A raw
   integer type code from one format is never trusted as another's.
6. **Cooperation adds no import edge (D10).** `lite-bake` / `lite-bake-stream` /
   `lite-query` are OPTIONAL peers consumed in the caller's code, never imported.
   `grep -r "from \"@zakkster" Reader.js` must stay empty.
7. **Every gate must be provably able to fail.** Each torture tier ships a
   deliberately broken control variant that exits non-zero, plus an in-process
   control (T9) that flips one knob and asserts the divergence is caught.

---

## 2. Verified findings

Reproduced against `Reader.js` on 2026-09-08 with two probe scripts (P* and C*
cases; the reproduction column names the exact probe). Severity: **S1** = silent
corruption or a read past the buffer, **S2** = a broken documented guarantee,
**S3** = hygiene / contract gap. Every one crosses the construction door -- the
one place this module promises to be strict.

| ID | Sev | Finding | Reproduction |
| --- | --- | --- | --- |
| **BR-01** | **S1** | **The door fails open when `count` is derived and `byteOffset` is past the buffer.** With `count` omitted, the constructor computes `count = floor((byteLength - base) / stride)`. There is no check that `base <= byteLength`, so `avail` goes negative, `count` is derived NEGATIVE, and the final `count*stride > avail` guard passes because both sides are negative. An incoherent reader is silently constructed. The identical input with an EXPLICIT count is correctly refused (`R_BUFFER_TOO_SMALL`), so the door is not just porous, it is inconsistent. | `new LiteBinaryReader(buf64, {schema, byteOffset:1000})` -> `count === -117`, no throw (P1). Same with `count:3` -> throws `R_BUFFER_TOO_SMALL` (P1b). |
| **BR-02** | **S1** | **A non-integer or non-number `type` code passes the `t >= 0 && t < 8` door.** The check tests the range but not `Number.isInteger(t)`. `TYPE_BYTES[2.5]` is `undefined`, so the field's `end = offset + undefined = NaN`, which never updates `maxEnd`; the field contributes nothing to the derived stride, then `type[i] = 2.5` truncates to `2` (I32) in the `Uint8Array`. The field is silently retyped AND the record is sized too small, so late rows read past their record. `type:"1"` is likewise coerced to `1`. | `type:2.5` at offset 4 with a U8 at 0 -> derived `stride === 1`, `count === 16`, field read as I32 across a 1-byte stride, reading past every record (C1). `type:"1"` accepted, `typeOf === 1` (P2b). |
| **BR-03** | **S1** | **`byteOffset: NaN` is swallowed by `opts.byteOffset \|\| 0` and silently read as 0.** `NaN` is falsy, so `base` becomes `0` before the `Number.isInteger(base)` guard ever sees it. A caller who computed a NaN offset (a common arithmetic slip) gets row 0 of the buffer, not a refusal. | `new LiteBinaryReader(buf64, {schema, byteOffset:NaN})` -> `count === 8`, base silently 0 (C6). |
| **BR-04** | S2 | **Duplicate field names are silently accepted; the name->id map is last-wins.** Two fields named `x` both build entries in the SoA tables, but `name.set` overwrites, so `field('x')` returns the second id and the first field is unreachable by name -- present in `fieldCount` and readable only by raw integer id. A schema typo silently shadows a field. | `schema:[{name:'x',...},{name:'x',...}]` -> `field('x') === 1`, `fieldCount === 2`, id 0 orphaned (P11). |
| **BR-05** | S2 (FIXED) | **`bytes()` reading past the buffer throws a raw `RangeError`, not a coded `R_*`.** The documented escape hatch has no door of its own; the failure is a native `Uint8Array` constructor throw with no `.code`, breaking the "every failure is a greppable `R_*`" contract. | `reader.bytes(7, 0, 100)` on a 64-byte buffer -> raw `RangeError`, no `.code` (P5). |
| **BR-06** | S2 (FIXED) | **The cooperation constructors have no coded door.** `fromBaked(null)` and `fromLBK1Shard({bytes,rowStride})` (no `.fields`) throw raw `TypeError` while dereferencing the argument, not a coded `R_BAD_SOURCE`/`R_BAD_SCHEMA`. The two seams most likely to be fed a malformed sibling object fail with the least useful error. | `fromBaked(null)` -> raw `TypeError` (P8); `fromLBK1Shard({bytes,rowStride})` -> raw `TypeError` (P7). |
| **BR-08** | S3 (FIXED) | **A DETACHED ArrayBuffer throws a raw `TypeError`, not a coded `R_BAD_SOURCE`.** A transferred/detached `ArrayBuffer` is still `instanceof ArrayBuffer`, so it passes coercion and reaches `new DataView(buffer)`, which throws raw ("Cannot perform DataView constructor on a detached ArrayBuffer"). Same uncoded-door class as BR-06; it fails SAFELY (no read past), only with the least useful error. Found by the S2 QA adversarial sweep; DEFERRED (fold into S3's door-hardening / d.ts pass, not fixed in S2 -- a detached buffer is an exotic input and the fix must distinguish detached from a legitimately zero-length buffer, e.g. `ArrayBuffer.prototype.detached` on Node 20+ or a try/catch around the DataView construction). FIXED in S3: a cold-path `isDetached` guard (Node 21+ `detached` getter with a guarded-DataView fallback on the node>=18 floor) refuses a detached ArrayBuffer or a view over one with a coded `R_BAD_SOURCE` (decision 0003); `new ArrayBuffer(0)` still constructs (count 0). FIXED in S3; a follow-on hole (BR-09) surfaced for one source shape the fix's own tests never exercised. | `mc.postMessage(buf,[buf])` then `new LiteBinaryReader(buf, {schema})` -> raw `TypeError` (probe2). |
| **BR-09** | S3 (FIXED) | **A DataView source over a detached buffer threw a raw `TypeError`.** `DataView.prototype.byteOffset` / `byteLength` getters THROW on a detached backing buffer (TypedArray getters return `0` instead), so the `ArrayBuffer.isView(source)` branch read a throwing getter (`source.byteOffset === 0 && source.byteLength === source.buffer.byteLength`) BEFORE the BR-08 `isDetached(buffer)` guard was ever reached -- an uncoded door for exactly the input the BR-08 fix was meant to close. A DataView is `ArrayBuffer.isView`-true and the shipped `Reader.d.ts` documents `ArrayBuffer \| ArrayBufferView` as a valid source, so this is a supported shape. Fixed by probing `source.buffer` (a plain ArrayBuffer whose length/detached getters never throw) for detachment BEFORE any view getter, catching a detached DataView AND a detached TypedArray at the same coded `R_BAD_SOURCE` door. Found by S3 QA: DataView was absent from the t2 door matrix and the unit tests (both used ArrayBuffer + Uint8Array views only), so the BR-08 tests never fed a DataView. Test hole closed: a `dataview` kind added to the t2 M_SOURCES matrix (5 kinds x450 -> 6 kinds x450 = 2700 cells) and BR-09 boundary cases added to Reader.test.js. | `const b=new ArrayBuffer(64); const dv=new DataView(b); structuredClone(b,{transfer:[b]}); new LiteBinaryReader(dv,{schema})` -> raw `TypeError`, `e.code === undefined` (probe3). |
| **BR-07** | **S1** | **A zero-offset PARTIAL view reads past its own window (D7 hole).** The coercion at the door unwraps ANY `byteOffset === 0` view to its full underlying `buffer` zero-copy -- but a partial view (`byteLength < buffer.byteLength`, e.g. `new Uint8Array(buf, 0, 8)` or `arr.subarray(0, 8)`) owns only its window. The reader then derives/accepts a `count` over the FULL buffer and reads bytes the view does not own -- the same read-past class as BR-01, via the D7 path that was supposed to prevent exactly this. Only a NONZERO-offset view is copied; a zero-offset partial one is not. Found by the S2 reviewer; the S1 door matrix missed it because every cell used an `ArrayBuffer` source, never a view. | 8-byte view over a 16-byte buffer -> derived `count === 2`; `getF64(1,0)` returns poison `424242.5` from beyond the window; explicit `count:2` also accepted (reviewer probe, reconfirmed). |

**Verified-correct behaviours (pin these so a refactor cannot regress them):**
unaligned `f64` at offset 1 is bit-exact (P4, the D2 headline); explicit
endianness byte-swaps (C3); `get(row,id) === getX(row,id)` for every type (C4);
a pooled/offset view is COPIED and poison outside the window is never read (P12,
the D7 guarantee); and the doors that DO work -- `R_BUFFER_TOO_SMALL` on explicit
overflow (C2), `R_BAD_STRIDE` on `stride < maxEnd` (C5), `R_BAD_OFFSET` on a
negative or fractional offset (P13, C7), `R_BAD_COUNT` on a fractional count (P3),
`R_BAD_SCHEMA` on missing options (P9), `R_BAD_SOURCE` on a plain array (P10).

### The one door invariant that catches BR-01, BR-02 and BR-03 at once

```
0 <= base                        AND base <= buffer.byteLength           (BR-01, BR-03)
count is a non-negative integer  AND base + count*stride <= byteLength   (BR-01)
for every field f:
    Number.isInteger(type[f]) AND 0 <= type[f] < 8                       (BR-02)
    Number.isInteger(offset[f]) AND offset[f] >= 0
    offset[f] + TYPE_BYTES[type[f]] <= stride                            (BR-02 stride derivation)
```

Asserted at the door, all three S1 findings die at construction. It is O(fields)
to check and runs exactly once per reader, so it costs the hot path nothing. This
is the door half of the fidelity story; section 3 is the read half. Make the door
invariant the centrepiece of S2 and the read-fidelity invariant the centrepiece
of S1.

BR-07 adds one coercion rule the invariant assumes but S0 did not enforce: the
resolved buffer must be the bytes the caller actually owns. Only a FULL-SPAN
zero-offset view may unwrap zero-copy to its `buffer`; a zero-offset PARTIAL view
(`byteLength < buffer.byteLength`) must be COPIED to a window of its own length,
exactly as a nonzero-offset view already is. Then `checkCoherence` (which bounds
by `source.byteLength`) and the constructor agree for every view, and the door
matrix must carry a source dimension -- ArrayBuffer, full-span view, zero-offset
partial view, nonzero-offset view -- so the agreement is proven across views, not
just ArrayBuffers.

---

## 3. The read-fidelity invariant (catches most read bugs at once)

```
For every field f and row r in [0,count):
    getX_f(r) === DataView.getX(base + r*stride + off[f], le)   (reads what was written)
count * stride + base <= buffer.byteLength                       (never read past)
field(schema[i].name) === i                                      (name<->id bijection)
typeOf(field(name)) and offsetOf(field(name)) match the schema   (tables agree)
```

O(count x fields) to check, so it belongs in `validate()` and between torture
phases, never on a hot path. The first line is checked against an independent
`DataView` oracle in T5. Note the bijection line is FALSE today under a duplicate
name (BR-04) -- S2 decides whether `validate()` reports it or the door refuses it.
Make this the centrepiece of S1.

---

## 4. The torture suite (`test/torture.mjs`) -- spec

Modeled directly on `../LiteBake/test/torture` and
`../LiteBakeStream/test/torture` (this module is the same shape of package: a
zero-alloc reader over typed-array backing stores, so it inherits their gate,
not a lighter one). One harness, ten tiers in order, prints exactly "ok" / exits
0-1. Built in S1, extended by later sessions. `test/` never enters `package.json`
`files[]` (`npm pack --dry-run` proves it).

### Entry contract (`test/torture.mjs`), copied from the siblings

- **`--expose-gc` guard.** If `globalThis.gc` is not a function, print the remedy
  and `exit(1)` -- the GC gate is meaningless without it.
- **Peer preflight.** `@zakkster/lite-gc-profiler` and `@zakkster/lite-leak` are
  devDeps; a fresh clone that skipped `npm install` must `exit(2)` with a remedy,
  not a raw `ERR_MODULE_NOT_FOUND`. Import the peers DYNAMICALLY, after the check
  (a static import hoists past it and makes the exit-2 path unreachable).
- **Sequential tiers.** lite-gc-profiler is one-measurement-at-a-time and throws
  "already in flight" if nested. Tiers run strictly in order, never nested.
- **Replay.** Every failure prints the seed and op index:
  `TORTURE_SEED=<n> node --expose-gc test/torture.mjs`.

### Layout

```
test/
  Reader.test.js      # node:test boundary suite (semantics + every R_* door)
  torture.mjs         # entry: preflight, then runs tiers in order
  torture/
    harness.mjs       # SEED/PRNG, RULES, ALLOC_RULES, check(), die(),
                      #   runOpsGate, runAllocsGate, checkCoherence(), oracle
    t0-fidelity.mjs   # round-trip every type at random offset/stride/endianness
    t1-degenerate.mjs # odd strides, single field, base offset, empty count
    t2-adversarial.mjs# unaligned every type, stride==maxEnd exactly, the door matrix
    t5-differential.mjs# vs a DataView oracle AND vs emulated lite-bake / LBK1 reads
    t6-alloc.mjs      # zero-alloc gate on getX/get; buffer + views never grow
    t7-soak.mjs       # many readers over churned buffers; fidelity per cycle
    t9-controls.mjs   # every gate above, deliberately broken, must fail
  controls.mjs        # entry for the standalone control (must-fail) variants
```

(T3/T4 -- adversarial-sequence and handle-abuse tiers -- do not apply: a reader
has no mutable tree state to corrupt across a sequence. T8 cross-package is folded
into T5 oracle B/C and proven for real in S5.)

### Harness rules (the four disciplines the siblings enforce in one place)

1. **Scratch once.** Every buffer, schema, reader and scratch value is allocated
   OUTSIDE every measured loop. No `new`, no `subarray`, no closure per iteration.
2. **Failure-only messages.** `check(cond, msgThunk)` builds its string ONLY on
   failure -- a template literal per iteration is an allocation that would fail
   the T6 gate. Pass a thunk, never a pre-built string.
3. **Seeded replay.** `SEED` is a seeded xorshift32 from `TORTURE_SEED` (0-guarded
   to 1, since xorshift32 must not seed 0).
4. **One measurement window at a time.** `runOpsGate` opens and closes a single
   `measureOps` window per call; tiers never nest.

`RULES = { maxMajor: 0, maxPauseMs: 4, maxArrayBuffersGrowth: 0 }`. The last rule
is the one that bites: the reader's `ArrayBuffer` and its `DataView` live OUTSIDE
the V8 heap, invisible to a `heapUsed` gate, and `maxArrayBuffersGrowth` needs
`measureOps` `stabilize:'deep'` (which `runOpsGate` supplies). RULES never widens
to pass a machine; a budget that moves is not a gate.

`ALLOC_RULES = { maxBytesPerCall: 1 }` for a SECOND gate the ops gate cannot
provide. Node delivers `'gc'` PerformanceObserver entries ASYNCHRONOUSLY, so
`measureOps`' synchronous `gc.major` read can be 0 on a loop that retains plain
(non-ArrayBuffer) objects -- exactly what a buggy `get` returning `{value}` would
do. `runAllocsGate` (over `measureAllocs`/`checkAllocs`) forces a collection at
each batch boundary and gates per-call SURVIVING bytes at 1 (a floor set by the
process, strictly below `MIN_HEAP_OBJECT_BYTES = 16`; an inconclusive verdict or
an unsettled batch set is a FAIL, never a skip). This is the gate that would catch
a `get` that boxed its result.

`checkCoherence(source, options)` is a cold-path EVIDENCE function (the analogue
of lite-bake's `checkLayout`): it returns a STRING naming the first violated door
invariant from section 2, or `null` if coherent. T2 asserts it returns `null` on
every valid input; T9 asserts it returns non-null on hand-fabricated broken ones
(polarity: a valid input must pass, a corrupt one must not -- so the checker is
not vacuous). It is how BR-01..BR-03 stay dead after S2.

### Tier T0 -- read-fidelity laws

- For each of the 8 type codes, write N values with a `DataView`, read them back
  with the matching `getX` -- exact for ints, bit-exact for f32/f64 round-trips.
- Read at an UNALIGNED offset (f64 at offset 1, u32 at offset 3) -- the D2 claim.
- `get(row,id)` equals the typed `getX(row,id)` for every type.
- Both endiannesses: LE bytes read BE are byte-swapped; round-trip in the matching
  order is exact.
- `field(name)` bijection; `typeOf`/`offsetOf` agree with the schema.

### Tier T1 -- degenerate layouts

Odd strides (1,3,7,9), a single-field record, a record with `base` byteOffset into
a larger buffer, `count===0`, `stride===maxEnd` (tight pack), a field at the very
end of the record, a buffer sized to EXACTLY `count*stride`, and `byteOffset`
EXACTLY equal to `byteLength` (must derive `count===0`, verified P1c).

### Tier T2 -- adversarial + the door matrix

- Every type placed at every misaligned offset within a wide record.
- **The door matrix.** Cross `{count derived, count explicit}` x `{byteOffset
  in-range, == byteLength, past end, negative, NaN}` x `{type integer, type 2.5,
  type "1", type -1, type 8}` x `{offset integer, offset 1.5, offset -1}` x
  `{stride derived, stride == maxEnd, stride < maxEnd}`. Every cell has a decided
  policy -- a coded `R_*` throw or a documented value -- pinned by name. The cells
  that fail open today (BR-01, BR-02, BR-03) are registered here as
  reproduced-todos in S1 and become passing throws in S2.
- `stride` one byte too small -> `R_BAD_STRIDE` (C5, the boundary).
- `count*stride` one byte over the buffer -> `R_BUFFER_TOO_SMALL` (C2).
- Pooled `Uint8Array` window whose bytes outside the window are poisoned -> the
  copied reader must NOT see the poison (D7, P12).

### Tier T5 -- differential vs oracles

- Oracle A: a plain `DataView` reading the same positions -- cell-for-cell equal
  over 100k random (row,field) reads. Divergence prints seed + index.
- Oracle B: emulate a lite-bake buffer (native-endian, `Types` schema) and prove
  `fromBaked` reads every cell identically to a direct native `DataView` read.
- Oracle C: emulate a carved LBK1 shard (LE, `lane_kind` 1/3) and prove
  `fromLBK1Shard` translates and reads every cell (F64 exact, U32 index exact).

### Tier T6 -- the zero-alloc gate

```js
// getX / get hot loop over a prefilled buffer: STRICT zero.
const { report, summary } = runOpsGate(runHotReads, { ops, warmup });   // RULES
// plus the channel runOpsGate cannot see (async-gc blind spot):
const g = runAllocsGate(runHotReads, { iterations: 50000, batches: 8 }); // ALLOC_RULES
// and the structural facts a heap gate cannot check:
assert.equal(reader.buffer.byteLength, BYTES_BEFORE);
assert.ok(reader._dv === DV_BEFORE);       // the DataView was never reallocated
assert.equal(reader._off.length, FIELDS_BEFORE);
```

The read path allocates nothing -- there is no Map-resize caveat here (unlike
lite-lru), because the schema Map is built once at the door and never touched by a
read. This module can claim STRICT zero-GC on the hot path from S1.

### Tier T7 -- soak

Construct/discard many readers over churned buffers; sample the heap across
cycles; the read-fidelity invariant holds after each. Proves no retention through
the borrowed `bytes()` views (a kept view must be the caller's choice, not a leak)
-- witnessed with a `lite-leak` tracker, `size()` back to 0 per cycle.

### Tier T9 -- controls (the gate must be able to fail)

Two layers, both from the sibling pattern:

- **Whole-suite BREAK.** `LBR_TORTURE_BREAK=1 node --expose-gc test/torture.mjs`
  injects a retained allocation into the T6 hot loop; the run must exit non-zero.
- **In-process controls.** Each runs a deliberately broken variant IN PROCESS and
  asserts the matching gate flags it, plus proves non-vacuity (the checker returns
  clean on a genuinely valid input):
  - an allocating hot loop passed to `runOpsGate` -> rejected;
  - a `get` that returns `{v}` passed to `runAllocsGate` -> rejected (the async-gc
    channel);
  - `checkCoherence` on a valid reader returns `null`, and on each of the BR-01 /
    BR-02 / BR-03 fabricated inputs returns non-null;
  - a `getF64` that drops the `_le` flag (wrong bytes on a BE reader);
  - a `fromLBK1Shard` that forgets to translate `lane_kind` (reads an LBK1 U32
    lane 3 as if it were our U32 -- catches the D3 collision);
  - a corrupted DataView oracle -> the T5 differential diverges and dies.

### Reproduced-todo registry (S1 -> S2 handoff)

The suite has no fix mechanism of its own; findings ride the harness as the
siblings do. A `todo` runs the exact probe body a finding was found with and must
STILL reproduce it: `true` (still broken) keeps the gate neutral, `false` (fixed)
FAILS the run and demands the todo's promotion to an enforced check. S1 registers
BR-01..BR-06 as reproduced-todos; S2 fixes each and flips its todo to a passing
door/oracle assertion. A probe that throws its OWN expected coded error must catch
it and return `false` (so a fix-that-throws reads as "fixed", not "reproduced").

---

## 5. Session order

```
S0 (done, shipped the porous door)
   --> S1 --> S2 --> S3 --> S4 --> S5 --> S6
                     \--> S7 --------------/
   ------------------------------------------> S8 (release)
```

S1 (tests + torture + findings visible) blocks everything -- do not build on an
unproven reader. **S2 (fail-closed door) blocks S3/S4/S5** -- the `.d.ts` error
union, the API sugar, and the cooperation proofs all depend on the door's coded
`R_*` surface being complete and correct, and no feature should be layered on a
door that fails open. S5 (baker cooperation) depends on S2; S6 (lite-query
adapter) depends on S5 (it consumes the reader inside a stream). S7 (docs) can run
parallel to S3/S4/S5 but must land after S2 so it documents the real door. S8 is
the publish gate.

### If you only do a subset

1. **S2 is non-negotiable, right after S1.** BR-01, BR-02, BR-03 are three silent
   ways to construct a corrupt reader in a module whose one job is to fail closed
   at the door. The trigger is ordinary caller arithmetic (a NaN offset, a derived
   count over a bad base, a typo'd type code), and each fix is a few lines at a
   cold path. Nothing else here has that ratio.
2. **S1 first regardless.** Every later session leans on one torture command and
   the reproduced-todo registry; without it S2's fixes cannot be proven to fail
   before and pass after.
3. **S5 is the cross-package rep.** `fromBaked`/`fromLBK1Shard` reading emulated
   bytes is not proof; reading the REAL sibling output, cell-for-cell, without an
   import edge, is the whole cooperation claim.

---

## 6. The briefs

===============================================================================
# S0 -- v0.1.0 -- core reader  [DONE]
===============================================================================
```markdown
package: "@zakkster/lite-binary-reader"
version_target: 0.1.0
status: done
decisions: [D1, D2, D3, D4, D5, D6, D7, D8, D9, D10]
findings: [BR-01, BR-02, BR-03, BR-04, BR-05, BR-06]   # shipped WITH these
blocks: [S1]
```
Built: `Reader.js` (DataView reader; schema->SoA tables; getX/get/field/bytes;
fromBaked; fromLBK1Shard; explicit endianness; fail-closed doors for the
SIMPLE cases), `package.json`, `LICENSE`, `decisions/0001-structure.md`. The
D2 capability (unaligned reads), D4 (explicit endianness), D6 (get==getX) and
D7 (pooled-view copy) are all verified working. NON-GOALS met: no tests, no
docs, no d.ts. NOT met, discovered by probing in this roadmap: the door fails
open on a derived count over a bad base (BR-01), a non-integer type (BR-02),
and a NaN byteOffset (BR-03). Those are S2's job; S1 makes them visible first.

===============================================================================
# S1 -- v0.1.1 -- node:test suite + torture harness + findings made visible
===============================================================================
```markdown
version_target: 0.1.1
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0        # STRICT -- the read path has no resize frontier
alloc_bytes_per_call: 1      # the retained-alloc gate floor (async-gc channel)
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [BR-01, BR-02, BR-03, BR-04, BR-05, BR-06]   # registered, not fixed
depends_on: [S0]
blocks: [S2]
```
PURPOSE
  Stand up the proof harness the whole package leans on, and make every finding
  reproducible in it. This session makes the bugs VISIBLE and the good behaviour
  PINNED; S2 fixes the bugs. Highest priority; nothing else starts until the gate
  is green, its controls fail, and the six findings reproduce on demand.
TASKS
  - `test/Reader.test.js` (node:test): every getX, generic get, field/typeOf/
    offsetOf, both endiannesses, stride/count derivation, all seven R_* doors
    that DO work, fromBaked, fromLBK1Shard, the pooled-view copy. Pin every
    "verified-correct behaviour" from section 2 by name.
  - `validate()` (test/debug only): the full read-fidelity invariant (section 3).
  - `checkCoherence()` in the harness: the door-invariant evidence function
    (section 2), returning the first violated invariant or null.
  - `test/torture.mjs` + harness: the entry contract (--expose-gc guard, peer
    preflight exit-2, dynamic imports, sequential tiers, seeded replay) and
    tiers T0, T1, T2, T5 (oracle A at least), T6, T7, T9.
  - `test/controls.mjs` + T9 in-process controls: the BREAK hot-loop allocation,
    the async-gc retained-alloc control, the dropped-`_le` control, the
    no-translate LBK1 control, the corrupted oracle, and the checkCoherence
    non-vacuity pair.
  - Register BR-01..BR-06 as reproduced-todos (section 4) with the exact probe
    bodies from this roadmap (P1, P2/C1, C6, P11, P5, P7/P8).
  - T6 STRICT: assert zero major GC, the retained-alloc gate at 1 B/call, AND
    that `buffer.byteLength`, `_dv`, and `_off.length` never change across the
    window. No pre-fill caveat (there is no Map on the read path).
ASSERTIONS
  - `node --test` green; every fidelity law and every working door named.
  - `node --expose-gc test/torture.mjs` prints exactly "ok", exit 0.
  - `LBR_TORTURE_BREAK=1 ...` exits non-zero; every T9 in-process control fails
    its gate; checkCoherence returns null on valid and non-null on each broken.
  - Peer preflight exits 2 with a remedy when a devDep is missing.
  - The six reproduced-todos all still reproduce (they are unfixed).
  - `npm pack --dry-run` excludes test/.
DONE WHEN
  tests green; torture "ok"; controls fail; strict zero-alloc + retained-alloc
  gates proven on getX; all six findings reproduce on demand.

===============================================================================
# S2 -- v0.1.2 -- fail-closed door (the six findings)
===============================================================================
```markdown
version_target: 0.1.2
status: planned
gc_maxMajor: 0
gc_maxPauseMs: 4
alloc_bytes_per_op: 0
leak_cycles: 4096
peers: ["@zakkster/lite-gc-profiler", "@zakkster/lite-leak"]
findings: [BR-01, BR-02, BR-03, BR-04, BR-05, BR-06]
depends_on: [S1]
blocks: [S3, S4, S5]
```
PURPOSE
  Make law #2 true. Six ways an incoherent input crosses the door today; every
  fix is a cold-path guard at construction, and none of them may add a byte to
  getX/get. This is the highest-severity work in the package and every feature
  session waits on it.
WHY THESE SIX TOGETHER
  They are one bug in several costumes: the door validates a value's RANGE but
  not its COHERENCE (integer-ness, base-within-buffer, name uniqueness, argument
  shape). Fixing them together means writing the door-coherence invariant
  (section 2) once, not six guards.
TASKS
  - **BR-01 base-within-buffer.** Reject `base > buffer.byteLength` at the door
    (`R_BAD_OFFSET` or `R_BUFFER_TOO_SMALL`), BEFORE deriving count. Then a
    derived count can never go negative. Add the `count >= 0` post-derivation
    assertion as a belt-and-braces.
  - **BR-02 integer type.** `R_BAD_TYPE` requires `Number.isInteger(t) && t>=0 &&
    t<8`. A fractional or string type is refused, not truncated. Re-derive
    `maxEnd` only from valid widths.
  - **BR-03 coherent byteOffset.** Replace `opts.byteOffset || 0` with an
    explicit `undefined` check so `NaN`/`false`/other falsy non-zero values reach
    the `Number.isInteger` guard and are refused, not silently read as 0.
  - **BR-04 duplicate-name policy.** DECIDE and record: refuse
    (`R_DUPLICATE_FIELD`) or document last-wins. Recommended: refuse -- a name
    collision is always a caller bug and a silent shadow is the worst outcome.
    Whichever, `checkCoherence` and `validate()` enforce it.
  - **BR-05 coded `bytes()` door.** Bounds-check `off + len` against the buffer
    and throw `R_BUFFER_TOO_SMALL` (or a new `R_BAD_LENGTH` for negative len)
    instead of letting the `Uint8Array` constructor throw a raw `RangeError`.
    This is a COLD guard on the escape hatch, not the numeric hot path.
  - **BR-06 coded cooperation doors.** `fromBaked` and `fromLBK1Shard` validate
    their argument shape (`R_BAD_SOURCE`/`R_BAD_SCHEMA`) before dereferencing, so
    a null or malformed sibling object yields a coded error.
  - Flip the six reproduced-todos to enforced door/oracle assertions; fill the
    T2 door matrix completely.
  - Update `decisions/0001-structure.md` (or add `0002-door.md`) with the
    door-coherence invariant and the BR-04 policy.
HOT PATH
  Every change is at the construction door or the `bytes()`/cooperation cold
  paths. `getF64..getU8` and `get` MUST diff byte-identical. Prove it: `assertOps`
  / `runOpsGate` on the hot read loop within noise of the v0.1.1 baseline, and a
  diff showing the eight typed getters and `get` are untouched.
ASSERTIONS
  - Each finding has a named failing-before / passing-after test.
  - BR-01: `byteOffset` past end with derived count throws; with `count===byteLength`
    derives 0; explicit-count overflow still throws `R_BUFFER_TOO_SMALL`.
  - BR-02: `type` of 2.5, "1", -1, 8, NaN each throw `R_BAD_TYPE`; the stride is
    never mis-derived by an invalid width.
  - BR-03: `byteOffset` of NaN/Infinity/1.5/-1 each throw `R_BAD_OFFSET`.
  - BR-04: duplicate names behave per the recorded policy, pinned by name.
  - BR-05: `bytes()` past the buffer and with negative len throw a coded `R_*`.
  - BR-06: `fromBaked(null)` and a fieldless `fromLBK1Shard` throw a coded `R_*`.
  - `checkCoherence` returns non-null on every BR fabricated input and null on a
    valid one; the read-fidelity bijection line now holds unconditionally.
  - Hot-path `runOpsGate`/retained-alloc gate within noise of v0.1.1; diff proves
    the read bodies unchanged. torture "ok"; controls fail.
NON-GOALS
  No new read features (S4). No d.ts (S3). No per-read bounds checks on getX.
DONE WHEN
  all six findings fixed with failing-before/passing-after tests; the door matrix
  is complete; the read hot path measured unchanged; torture "ok".

===============================================================================
# S3 -- v0.2.0 -- Reader.d.ts
===============================================================================
```markdown
version_target: 0.2.0
status: planned
depends_on: [S2]
blocks: [S4]
```
TypeScript surface: `LiteBinaryReader`, the `Field`/`Schema` shapes, the `T_*`
type-code consts, `fromBaked(Baked)` and `fromLBK1Shard(Shard)` signatures,
`LiteBinaryReaderError` with a `code` union of the R_* tags -- now including any
tag S2 added (`R_DUPLICATE_FIELD`, `R_BAD_LENGTH`) -- and `VERSION`. Add a
docs/type-drift guard to the test suite: assert the `.d.ts` `code` union equals
the set of `R_*` tags actually thrown in `Reader.js` (the BLUEPRINT lists d.ts
drift and thrown-vs-declared error-code divergence as recurring finding classes;
lite-bake ships exactly this inventory gate). Add `Reader.d.ts` to `files[]`
(already present -- verify it resolves).

===============================================================================
# S4 -- v0.3.0 -- API sugar (each pinned zero-alloc)
===============================================================================
```markdown
version_target: 0.3.0
status: planned
depends_on: [S2]
```
Additive, hot bodies stay byte-identical:
  - **Row cursor**: `seek(row)` + `f64(id)/u32(id)/...` that read at the seeked
    row without re-passing it -- ergonomic sequential scans, still zero-alloc.
  - **Out-param row fill**: `readRow(row, out)` writes each field into a
    caller-owned object/array (no materialized record) -- the SoA/AoS bridge.
  - **Native typed-lane fast path**: when `_le === IS_LITTLE_ENDIAN` AND a field
    is aligned, expose `f32`/`f64`/... views + pre-shifted element strides
    (lite-bake's `f32[i*strideF32+off]` shape) for the absolute hot loop; fall
    back to DataView otherwise. Guarded, opt-in, documented.
  - **Variable-length fields**: a `length`-carrying descriptor + `bytes(row,id)`
    that reads the run length from a sibling field -> blob/string spans, still
    borrowed ("copy what you keep"), now behind the coded `bytes()` door from S2.
NON-GOALS: no write path; no schema mutation; no per-read bounds checks on getX.
Each new surface gets its own T6 zero-alloc + retained-alloc gate.

===============================================================================
# S5 -- v0.5.0 -- cooperation proof: lite-bake / lite-bake-stream
===============================================================================
```markdown
version_target: 0.5.0
status: planned
depends_on: [S2]
peers_optional: ["@zakkster/lite-bake", "@zakkster/lite-bake-stream"]
```
PURPOSE
  Turn `fromBaked` / `fromLBK1Shard` from "reads emulated bytes" into "reads the
  REAL sibling output," proven by a cross-package test -- WITHOUT an import edge
  (D10). The siblings are devDependencies of the TEST only.
TASKS
  - `test/coop-bake.test.js`: `bake(records)` in lite-bake -> `fromBaked` ->
    assert every cell equals lite-bake's own `Reader` cell-for-cell (native
    endianness path, all 8 `Types` lanes). Read `../LiteBake/llms.txt` for the
    exact current API; do not write it from memory.
  - `test/coop-lbk1.test.js`: write a container with lite-bake-stream's `Writer`
    -> open with its `Reader` -> carve `{ bytes: shardPayload(i), rowStride:
    strideBytes(), fields: schema.fields }` -> `fromLBK1Shard` -> assert F64 cells
    exact and U32 cells equal the raw string-table INDEX (document that string
    resolution stays in bake-stream). Read `../LiteBakeStream/llms.txt` first.
  - A `MultiReader`-style helper: a thin union that maps a global row index to
    (shard, localRow) and dispatches to the per-shard `LiteBinaryReader` --
    mirrors bake-stream's `MultiReader`, but over foreign shards.
ASSERTIONS
  - Cell-for-cell equality vs both sibling readers on their own output.
  - The D3 collision is exercised: an LBK1 U32 (lane 3) is read correctly only
    BECAUSE it was translated; the T9 no-translate control fails.
  - `grep -r "from \"@zakkster" Reader.js` is empty -- no import edge.
DONE WHEN
  both siblings' real buffers read correctly through the shared core; no import
  edge; the translation control fails.

===============================================================================
# S6 -- v0.6.0 -- lite-query streaming adapter (cookbook, not an import)
===============================================================================
```markdown
version_target: 0.6.0
status: planned
depends_on: [S5]
peers_optional: ["@zakkster/lite-query"]
```
PURPOSE
  Ship the proven pattern for feeding a `lite-query` streaming query with
  zero-GC binary reads -- as an EXAMPLE + test, never a code dependency. lite-query
  has no decode hook (its `transform` was removed on purpose); the seam is the
  caller's `stream:` generator (research: Cookbook recipe 20 does exactly this
  with bake-stream's RangeReader). Read `../LiteQuery/Cookbook.md` and
  `../LiteQuery/llms.txt` first.
TASKS
  - `examples/streamQuery-adapter.md` + a runnable test: a `streamQuery` whose
    `stream:` generator opens an abortable range source, wraps each fetched
    `Uint8Array` window in a `LiteBinaryReader`, and `yield`s decoded values
    (or an out-param record) with ZERO per-frame allocation.
  - Honor `ctx.signal`: when the last observer detaches, the query aborts the
    iterator -> the generator stops fetching (the abort-on-detach law). Route the
    abort to "relinquish", never to an error (bake-stream's `R_ABORTED` shape).
  - Document the ownership contract: a reader over a POOLED/streamed buffer copies
    what the caller keeps (D9); a retained value must be copied out before the next
    frame overwrites the window.
ASSERTIONS
  - The streamed query populates its signal with correct decoded values.
  - Detaching all observers stops fetches within one tick (signal honored).
  - The frame path allocates 0 bytes/op (measured, both gates) -- the reader adds
    no per-value allocation over lite-query's own zero-alloc latest mode.
  - No import edge into lite-query; it is a test/example devDependency only.
DONE WHEN
  a real streamQuery reads binary through LiteBinaryReader, zero-GC, abort-clean,
  documented as a cookbook recipe.

===============================================================================
# S7 -- v0.x -- README + llms.txt + CHANGELOG
===============================================================================
```markdown
status: planned
depends_on: [S2]
```
README modeled on `../LiteSepforge/README.md` (the suite blueprint spine, in
order): the positioning is "the reader the ecosystem was missing -- raw/foreign
bytes the bakers can't touch." Show the unaligned-offset read and the explicit-
endianness read as the headline demos, then the `fromBaked` / `fromLBK1Shard` /
streamQuery composability section. Document the coded `R_*` door surface as it is
AFTER S2 (do not describe the porous v0.1.0 door). llms.txt. CHANGELOG from S0,
with S2's fixes under a "Fixed" section naming BR-01..BR-06. ASCII-only; grep for
stray tool-call tags in every new file. Add README + llms.txt to `files[]`.

===============================================================================
# S8 -- v1.0.0 -- release gate
===============================================================================
```markdown
status: planned
depends_on: [S2, S3, S4, S6]
```
`npm run verify` green (test + torture + controls). Three-place VERSION sync
(`Reader.js` `VERSION`, `package.json`, `.d.ts`). Confirm the registry residual
from section 0: `@zakkster/lite-binary-reader` and the
`PeshoVurtoleta/lite-binary-reader` repo exist and are the intended homes; the
homepage/repository/bugs/funding URLs all resolve there (verified self-consistent
offline; confirm live before publish). `/release 1.0.0`.
```

===============================================================================
# Post-1.0.0 -- feature roadmap (additive minors; each is its own session)
===============================================================================
These close genuine feature gaps vs top-tier binary readers (surfaced in the S7b
review). They are DELIBERATELY held until after 1.0.0 so the current frozen contract
(R_* union 10, type table 8, dts-drift floor) ships as the stable 1.0 baseline; each
is then an ADDITIVE, backward-compatible minor. The existing 8 lanes and every read
body stay byte-identical -- these ADD surface, they do not change what 1.0.0 shipped.
Pre-1.0 hardening (S7b: schema-space fuzzer + bytes() negative gate + README-code
subset check) lands before S8, not here.

===============================================================================
# S9 -- v1.1.0 -- 64-bit integer lanes (i64 / u64 via BigInt)  [HIGH VALUE]
===============================================================================
```markdown
status: planned (post-1.0)
depends_on: [S8]
```
PURPOSE
  The one real feature a top-tier reader has that we do not: 64-bit integers. Real DB
  rows and wire formats carry i64/u64; DataView reads them natively
  (`getBigInt64`/`getBigUint64`). Add `T_I64` / `T_U64` type codes returning BigInt.
TASKS
  - Two new type codes; TYPE_BYTES gains two 8-byte entries. getBigInt64/getBigUint64
    getters + `get`/cursor/readRow dispatch; laneOf eligibility via
    BigInt64Array/BigUint64Array (host-endian + 8-aligned only, same rule as the rest).
  - Reader.d.ts: the two codes, the two getters, the BigInt return type on the data-
    driven paths (readRow into a BigInt64Array sink; number|bigint union documented).
  - Coordinate with @zakkster/lite-bake's Types (does it mint i64/u64? read its
    llms.txt -- do NOT assume). fromBaked/fromLBK1Shard translation extended if so.
INVARIANT CHANGE (deliberate, gated): the dts-drift "type table exactly 8" assertion
  becomes exactly 10; the R_* union is UNCHANGED at 10. This is the ONE place the
  frozen type-table count moves, and it is an explicit, additive 1.1.0 decision -- the
  drift gate is updated in lock-step, not bypassed. Torture gains i64/u64 fidelity +
  0-B/op lane rows (BigInt reads box; the zero-alloc claim is scoped honestly -- a
  BigInt result is not a primitive number, so getBigX allocates the BigInt; laneOf
  over a BigInt64Array is the zero-alloc path for the hot 64-bit loop).
DONE WHEN
  i64/u64 read bit-exact vs a DataView oracle across LE/BE; laneOf serves the aligned
  host-endian 64-bit lane; drift gate asserts table=10; CHANGELOG notes the additive
  type-table change.

===============================================================================
# S10 -- v1.2.0 -- per-field endianness  [MEDIUM]
===============================================================================
```markdown
status: planned (post-1.0)
depends_on: [S8]
```
PURPOSE
  Mixed-endian wire structs: today `littleEndian` is ONE per-reader flag. Allow an
  optional per-field `littleEndian` on a schema field, defaulting to the reader flag
  (so existing schemas are byte-identical).
TASKS
  - Optional `Field.littleEndian?`; the getter reads the field's endianness, falling
    back to the reader's. laneOf eligibility becomes per-field (a field whose endian !=
    host declines to null, as today). Reader.d.ts adds the optional field.
  - The door validates it (boolean or absent); no new R_* code needed (reuse
    R_BAD_SCHEMA for a non-boolean).
DONE WHEN
  a single reader reads an LE field and a BE field in the same row, both bit-exact;
  laneOf declines the non-host field; default-absent path is byte-identical to 1.1.0.

===============================================================================
# S11 -- v1.3.0 -- type-level record inference in Reader.d.ts  [DX, zero runtime]
===============================================================================
```markdown
status: planned (post-1.0)
depends_on: [S3]
```
PURPOSE
  Pure DX, ZERO runtime cost (types only -- fits the ethos). A `const`-typed schema
  should infer a typed record so `get`/`readRow` are typed per field instead of
  returning a bare `number`. Top TS readers (typed-struct, restructure) have this.
TASKS
  - Generic `LiteBinaryReader<S extends readonly Field[]>` inferring field name -> type
    from the schema literal; typed `field(name)`, typed `readRow` sink. Runtime
    unchanged -- Reader.js is byte-identical; this is a .d.ts-only enhancement.
  - dts-drift extended to keep the generic surface honest.
DONE WHEN
  a `const` schema yields typed reads with no runtime change; the non-generic call
  path still compiles (backward-compatible overload).

===============================================================================
# S12 -- v1.4.0 -- zero-alloc iterator sugar (+ optional string() hatch)  [DX]
===============================================================================
```markdown
status: planned (post-1.0)
depends_on: [S4]
```
PURPOSE
  Modern looping ergonomics WITHOUT breaking the zero-GC contract:
  `for (const row of reader) row.f32(id)`. Matches high-performance ECS iteration.
TASKS
  - `[Symbol.iterator]()` that advances the internal cursor (reusing seek/_cursor)
    and yields the READER ITSELF as the row handle -- no per-row object. CRITICAL:
    the iterator protocol allocates a `{ value, done }` result per step UNLESS you
    return a SINGLE REUSED result object (mutated in place) -- so the "zero object
    per iteration" claim holds ONLY with a reused result object, and it MUST be
    torture-gated (a new t6 sub-case: 0 B/op across a full for-of pass) with a
    LBR_TORTURE_BREAK-style control. A naive generator implementation FAILS this.
  - Reader.d.ts: `[Symbol.iterator](): IterableIterator<this>` (or a typed row view).
  - OPTIONAL, only if the maintainer decides the string boundary should MOVE (today
    the docs say "string resolution stays with the producer"): a `string(row, id,
    length?, decoder?)` escape hatch that takes an INJECTED TextDecoder (zero-dep
    preserved) and decodes the field's span. It INHERENTLY allocates (a JS string is
    a heap object), so it is a COLD hatch beside `bytes()`, documented as allocating
    and EXCLUDED from the zero-alloc gate -- pairs with S7b's bytes() negative gate.
    If the boundary stays, this is dropped and `bytes()` + caller-side decode remains
    the contract.
DONE WHEN
  a full `for-of` pass is measured 0 B/op (reused result object, torture-gated with a
  teeth control); if shipped, `string()` is documented as an allocating cold hatch and
  the NOT-FOR/boundary docs are updated to match the decision.

===============================================================================
# S13 -- benchmark suite + headline numbers (vs similar modules)  [also a decision gate]
===============================================================================
```markdown
status: planned (post-1.0)
depends_on: [S8]
```
PURPOSE
  Publishable, REPRODUCIBLE numbers that PROVE the module's reason to exist across its
  four value axes -- not just ns/op:
    1. FAST     -- ns/op vs a plain-DataView baseline and vs similar modules.
    2. ZERO-GC  -- 0 B/op + 0 retained across every read surface (cite the torture
                   gates: getX / cursor / readRow / laneOf, and the bytes() negative
                   gate). The differentiator most peers cannot claim.
    3. TINY     -- shipped bundle size (min+gz KB) and ZERO runtime dependencies, side
                   by side with peers' install size + dep count.
    4. SAVES TRAFFIC -- bytes-on-the-wire for N records as compact fixed-stride binary
                   vs JSON (and the decode cost of each), showing the payload the reader
                   makes cheap to consume. HONEST boundary: the bakers PRODUCE the
                   bytes; this reader is what makes consuming them zero-copy/zero-GC --
                   frame the traffic win as the reader+baker story, not the reader alone.
  Also the DECISION GATE for the V8 endianness split-class idea (measure before
  building; the suite's law is measured claims, never folklore).
TASKS
  - A ns/op harness on a FIXED fixture (pinned Node version + warmup + percentiles +
    replay seed), covering: getX, the cursor reads, `laneOf` (the typed-array hot
    path), `get`/`readRow`, and (after S9) the 64-bit lanes. Use the suite's
    @zakkster/lite-perf-gate / lite-gc-profiler idiom; keep it ADVISORY (report), not
    a hard CI fail (wall-clock is noisy) unless a stable >X% regression bound is set.
  - BASELINE row: a hand-written plain-DataView loop -- the honest floor; show `laneOf`
    at or near memory-bandwidth and getX vs the DataView baseline.
  - THE V8 SPLIT-CLASS EXPERIMENT: build a throwaway LE/BE hardcoded-endianness getter
    and measure it against the current dynamic-`_le` getter on the SAME fixture. If it
    is a real, repeatable win on the FALLBACK (non-lane) path -> promote to a feature
    session; if it is within noise (the modern-V8 expectation) -> record the negative
    result and CLOSE the idea. Either way the decision is data, not opinion.
  - COMPARATIVE numbers vs named similar modules WHERE THE COMPARISON IS FAIR (same
    read-only, fixed-stride primitive workload): a plain DataView loop always; and,
    with explicit CAVEATS about differing feature sets (read-only vs read+write,
    schema DSL overhead), peers such as binary-parser / restructure / typed-struct.
    Never cherry-pick; state the workload, the versions, and what is NOT comparable.
  - Land the headline table in README (a new "Performance" section) and llms.txt, with
    the fixture + command so anyone can reproduce it. Numbers with a repro, or they do
    not ship.
  BLUEPRINT -- copy ../LiteQuery/bench/bench.mjs, do NOT reinvent the harness:
    - Location + script: `bench/bench.mjs`, `"bench": "node --expose-gc bench/bench.mjs"`.
    - Methodology it pins (mirror exactly): WARMUP_RATIO ~0.05 (warm before timing),
      `gc()` bracketing each timed loop, `process.hrtime.bigint()` timing, and per
      scenario report BOTH ops/sec AND `transient/op` + `retained/op` bytes
      (process.memoryUsage heapUsed delta) -- the bytes/op columns ARE the zero-GC
      headline, so keep them; a peer that allocates per read loses on that axis alone.
    - Report format: `> <scenario>` then a line per contender then
      `lite is <N>x FASTER, allocates <N>x LESS transient`.
    - README: a `## Performance` ops/sec table with an x-factor column + a top-of-file
      headline blockquote citing the standout multipliers and linking to the section
      (lite-query's exact shape).
    - FAIRNESS discipline (the honest part): state the apples-to-apples baseline (for
      us: a plain-DataView loop, always fair), same workload/fixture on every
      contender, and -- like lite-query's "why no SWR" note -- explicitly say which
      peers are EXCLUDED and why (e.g. write-only encoders, React-coupled, or a schema
      DSL that measures a different thing). Never a comparison the reader would call rigged.
DONE WHEN
  a reproducible ns/op table exists (own surfaces + DataView baseline + fair peer
  comparison), the V8 split-class question is answered with data (promote or close),
  and the README/llms.txt carry the numbers WITH the repro command.

===============================================================================
# On demand (not scheduled -- only if a consumer needs them)
===============================================================================
- BITFIELDS / sub-byte lanes: real for flag/wire formats, but sub-byte masking adds
  hot-path complexity; defer until a concrete consumer asks.
- FLOAT16 (half-precision): GPU/ML data; DataView getFloat16 is newly/partially
  available -- gate on engine support. Niche.
INTENTIONAL BOUNDARIES (NOT gaps -- the package's scope, by design):
- No write/encode path -- the bakers (lite-bake / lite-bake-stream) own writing.
- No nested / array-of-struct DSL, no codegen -- lite-bake owns layout; this reads
  flat fixed-stride bytes a producer already laid out.
