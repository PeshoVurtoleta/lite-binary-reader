# 0011 -- per-field endianness (S10, v1.2.0)

Status: accepted (v1.2.0). Context: S10, the second post-1.0 feature minor. Today
`littleEndian` is ONE flag per reader; real wire structs are mixed -- a big-endian
length/type prefix in front of a little-endian payload, protocol headers, some GPU
readback. This is the next step of law #4 ("endianness is explicit and owned") and a
READER-only capability: neither baker emits mixed-endian, so no sibling translation is
involved. Additive -- any pre-S10 schema (no per-field `littleEndian`) reads exactly as
it did in 1.1.0.

## The one real decision: the hot-path shape (D1)

A per-field getter cannot keep hard-coding the single `this._le`; it must read a
per-field flag. The options were:

- **D1 (accepted): a single `_leOf` `Uint8Array` (0/1), read as `this._leOf[fieldId]`
  in every multi-byte getter.** One extra L1 typed-array index per read; the branch
  predictor eats it. The default-absent path yields byte-IDENTICAL RESULTS (for a
  schema with no overrides, `_leOf[i] === (_le ? 1 : 0)` for every field) and is
  WITHIN-NOISE on `bench/bench.mjs` vs 1.1.0.
- **Rejected: two getter classes** (dynamic-`_le` vs per-field), chosen at the door, so
  the no-override default stays a literal byte-identical getter. This DOUBLES the
  hot-getter surface -- exactly what S13 (decisions/0008) already rejected for the
  ~4% split-endianness micro-gain. The same logic applies: a predicted L1 index is not
  worth a second getter set to maintain and keep in lock-step.

So "byte-identical default" is discharged as **identical results + within-noise perf,
proven with data**, not as a literal source diff -- the honest reading, since the
feature by definition changes what the getter reads.

## What moved, and what did not

- Schema: an OPTIONAL `Field.littleEndian?: boolean`. Absent inherits the reader flag.
  Validated boolean-or-absent at the door -> `R_BAD_SCHEMA` otherwise (reuse; NO new
  R_* code). The default uses an explicit `=== undefined` check, NOT `|| / ??`, so a
  legitimate `false` (a big-endian field) is never swallowed as "omitted" -- the same
  BR-03 discipline as `byteOffset`.
- Door: build `_leOf` (a `Uint8Array` of 0/1) once, alongside `_off` / `_type`, in the
  fixed constructor freeze order (one shared hidden class).
- Read surface: every multi-byte getter (getF64..getU16, getI64/getU64), the cursor
  reads (f64..u16, i64/u64), and the `get` / `val` / `readRow` switch arms read
  `_leOf[id]` instead of `_le`. `getI8`/`getU8` and `bytes()` are unchanged
  (single-byte / raw). `this._le` survives ONLY as the reader-level introspection flag
  (`get littleEndian()`).
- laneOf: the host-endian test moved from a single global `_le === IS_LITTLE_ENDIAN`
  wrapping the whole lane-build loop to a PER-FIELD `leOf[i] !== (IS_LITTLE_ENDIAN?1:0)
  -> continue`. A big-endian field in an otherwise host-endian reader declines to null
  (served by getX) while its host-endian siblings still get a lane. An all-default
  reader's lanes are identical to 1.1.0.
- Drift gate: UNCHANGED. No new R_* code (union stays 10) and no type-table move
  (stays 10). This session touches neither frozen inventory -- only `VERSION` bumps in
  lock-step at `/release`.
- Torture: t0/t5 fidelity/differential gain a mixed-endian record checked cell-for-cell
  vs a DataView oracle (LE-host and BE-host); the t2 door matrix gains the
  `littleEndian` dimension; a t9 control that reads `_le` instead of `_leOf[id]` on a
  mixed fixture must be CAUGHT by the differential. The 8 primitive 0-B/op gates and the
  S9 64-bit positive-alloc gate are untouched (the per-field index allocates nothing).

## A known, deliberate asymmetry (not fixed here)

The reader-level `opts.littleEndian` is still `!!`-coerced (a truthy non-boolean like
`"false"` reads as LE), whereas the NEW per-field flag is strictly boolean-or-absent.
Tightening the reader-level flag would REJECT input 1.1.0 accepted -- a breaking change
in a minor -- so it is grandfathered. The new surface is strict because it has no prior
contract to break; the asymmetry is documented, and any tightening waits for a major.

## Non-goals

- No write / encode path (the bakers own writing). No new R_* code, no type-table move.
- No doubled getter surface (D1). No sibling endianness translation -- fromBaked stays
  native-endian, fromLBK1Shard stays LE-by-spec; per-field override is a caller-schema
  feature, not a container concern.
- No change to any 1.0.0/1.1.0 read RESULT for a schema without per-field overrides,
  pinned by a regression test and the unchanged 0-B/op gates.
