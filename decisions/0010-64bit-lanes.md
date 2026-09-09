# 0010 -- 64-bit integer lanes (i64 / u64 via BigInt) (S9, v1.1.0)

Status: accepted (v1.1.0). Context: S9, the first post-1.0 feature minor and the
first substantive `Reader.js` change since the door work. It exercises the ONE
sanctioned move of a frozen 1.0.0 invariant (decisions/0009): the type-code table
goes 8 -> 10, in lock-step with the `dts-drift` gate. Additive -- every 1.0.0 read
body for codes 0-7 is byte-identical; the new lanes only ADD switch arms and two
methods.

## The governing measurement: 64-bit reads CANNOT be zero-GC

Measured under `node --expose-gc`, not assumed. Reading a 64-bit integer in JS
ALWAYS mints a `BigInt`, which is a heap value by spec. Both `dv.getBigInt64()` and
a `BigInt64Array` element read allocate. Retaining 200000 `getI64` results grew the
heap ~6.4 MB (~32 B/read); the same figure measured through a retention-only gate
looks like ~0.5 B/read only because the transient BigInts are collected before the
post-settle read -- the allocation is real, the residue is not the whole cost.

So i64/u64 is a COMPLETENESS feature that is inherently allocating -- the SECOND
documented exception to the zero-GC guarantee, alongside `bytes()`. This is not a
competitive disadvantage: every JS reader that returns 64-bit integers allocates
BigInts. The zero-GC guarantee stays UNQUALIFIED on the eight primitive-number
lanes (codes 0-7); the two new lanes are opt-in and explicitly outside it.

(This corrects the earlier roadmap note that "laneOf over a BigInt64Array is the
zero-alloc 64-bit path" -- there is no zero-alloc way to obtain a 64-bit VALUE.)

## Decisions

- **D1 (accepted YES): ship i64/u64 as `BigInt`,** documented as an allocating read
  surface. BigInt is the only faithful full-range 64-bit representation, peers all
  allocate too, and the honest scoping keeps the core zero-GC claim clean.
- **D2 (accepted NO): no non-allocating fallback** (no `getU64AsNumber`, no
  `readHiLo`). It doubles the surface for a niche; `getU32` already covers the
  two-halves case for callers who want it. Held as "on demand".
- **D3 (accepted YES): expose `laneOf` for the 64-bit lanes** -- a `BigInt64Array` /
  `BigUint64Array` view under the same host-endian + 8-aligned eligibility rule.
  Obtaining the view is 0 B/op and it is the fastest BULK 64-bit path, but each
  element read allocates a BigInt, so it is labelled an allocating lane, distinct
  from the 8 that are truly zero-alloc.
- **D4 (accepted NO translation): no `fromLBK1Shard` / `fromBaked` 64-bit mapping**
  this release. `@zakkster/lite-bake-stream` lists "I64 lane" as a FUTURE addition
  and `@zakkster/lite-bake` mints no 64-bit lane (it infers F64, refusing
  `E_UNSAFE_INTEGER` past 2^53-1). Neither sibling needs translation now. An unknown
  `lane_kind` still throws `R_BAD_TYPE` (unchanged); wire the mapping in the session
  that follows bake-stream shipping its I64 lane.

## What moved, and what did not

- Type table: `T_I64 = 8`, `T_U64 = 9`; `TYPE_COUNT` 8 -> 10; `TYPE_BYTES` and
  `TYPE_CTOR` gain two 8-byte / BigInt-array entries. The construction door already
  gates `0 <= type < TYPE_COUNT`, so it now admits 8/9 and rejects 10.
- Read surface: `getI64`/`getU64`, cursor `i64`/`u64`, and the two new arms in
  `get` / `val` / `readRow`. Return type widens to `number | bigint` on the
  data-driven paths.
- Drift gate: `TYPE_COUNT = 10` and `TYPE_BYTES` length 10, in lock-step with
  `Reader.js`. The R_* union assertion is UNCHANGED at exactly 10 -- NO new error
  code. A 64-bit field is an ordinary field with a wider type; every failure reuses
  an existing coded door.
- Torture: t0/t5 fidelity and t8 fuzz extended to lanes 8/9 (Object.is vs a
  DataView oracle, LE + BE, at 0n / -1n / INT64_MIN / INT64_MAX / UINT64_MAX). A new
  t6 Gate 5 PROVES the 64-bit surface allocates (retained heap far past a 100 KB
  floor, and strictly above the identical-shape primitive loop) -- the positive
  companion to the eight 0-B/op gates, which are untouched.

## Non-goals

- No write / encode path (the bakers own writing). No lo/hi convenience (D2). No
  sibling 64-bit translation (D4). No change to any 1.0.0 read body for codes 0-7,
  proven by diff and the unchanged t6 0-B/op gates.
