# 0006 -- cooperation proof vs real lite-bake / lite-bake-stream (v0.5.0)

Status: accepted (v0.5.0). Context: S5 turns fromBaked / fromLBK1Shard from "reads
EMULATED sibling bytes" (torture's Oracle B/C) into "reads the sibling's REAL
output," proven by cross-package node:test suites WITHOUT an import edge (D10). This
is a PROOF release: Reader.js changes ONLY its VERSION const (0.4.0 -> 0.5.0); the
cold cooperation constructors and every read body are byte-identical to 0.4.0. The
D3 wire-code translation the proof depends on ALREADY existed (Reader.js
LANEKIND_TO_TYPE) -- the proof confirmed it, it did not add it.

## Scope decisions (resolved at review, recorded here)

- D-1 = MultiReader-style helper is a TEST/EXAMPLE (`ShardUnion` in
  test/coop-multireader.test.js), NOT a core export. Reason: S5 is a PROOF, mirroring
  S6's "cookbook, not an import" discipline. Keeping it out of Reader.js means the
  reader stays byte-identical and the frozen invariants (R_* union 10, type table 8,
  dts-drift member floor 32) do not move. A shipped union type would be its own
  feature session with its own d.ts / drift cost.
- D-2 = the siblings are `file:` devDependencies of the TEST only
  (`@zakkster/lite-bake` -> ../LiteBake, `@zakkster/lite-bake-stream` -> ../LiteBakeStream).
  The tests import by the REAL scope name, exactly as a downstream consumer would;
  npm resolves them locally (no network); devDependencies are excluded from the
  tarball by construction. The pack gate confirms only the 7 shipped files remain.
- D-3 = VERSION bumps to 0.5.0 (the roadmap's earmark for the cooperation proof),
  even though no runtime surface changed. The CHANGELOG states plainly it is a
  proof-release with no runtime change.
- Cookbook.md is REPO-ONLY -- NOT added to package.json files[]. It is dev-facing
  docs, test-backed (each recipe cites a passing test), and does not ship. The
  shipped file list stays at 7.

## Ruling A -- fromBaked consumes lite-bake's OWN reported layout

lite-bake sorts fields by DESCENDING SIZE and pads the stride to max field
alignment (buffer to a multiple of 8), so the offsets are lite-bake's to STATE, not
ours to compute. The coop-bake proof reads them from lite-bake's returned
`{ buffer, stride, count, schema:[{name,type,offset}] }` and from its own Reader
(`ora.offsetBytes(name)`), and ASSERTS our reader agrees
(`lbr.offsetOf(id) === baked.schema[k].offset`, `lbr.typeOf(id) === baked.schema[k].type`)
rather than assuming it. The type codes are IDENTICAL on both sides
(F32=0..U8=7), so the in-memory bake path's code map is the identity -- asserted, not
presumed. Two independent oracles per cell: `ora.get(i,name)` and a raw typed-array
lane read from lite-bake's own eight views.

## Ruling B -- the D3 wire-code map already exists (no core edit)

The LBK1 WIRE lane_kind codes DIVERGE from ours: wire F64=1 (coincidentally shared
with our T_F64=1) but wire U32=3, which ALIASES our T_I16=3. fromLBK1Shard's
LANEKIND_TO_TYPE translates wire 3 -> our T_U32=5 (and wire 1 -> T_F64, plus
forward-compat entries for wire lanes bake-stream cannot currently mint). Because
the translation was already present and correct, S5 required NO constructor change:
it PROVES the map with a positive read (typeOf(tag) === T_U32) and a no-translate
CONTROL (below). Had the map been absent, this would have been a fidelity fix and a
pinned-core edit -- it was not.

## Ruling C -- the shard carve, and the payload_len/count RISK

The carve is `{ bytes: r.shardPayload(s), rowStride: r.strideBytes(),
fields: r.schema.fields }`. fromLBK1Shard forwards NO count -- it derives count from
the payload byte length. This is correct ONLY because bake-stream's Writer emits the
8-byte shard pad OUTSIDE payload_len, so `payload_len === rowCount * rowStride`
EXACTLY. The proof does not trust this: it ASSERTS
`payload.byteLength === rowCount * rowStride` and `lbr.count === r.shards[s].rowCount`
on every shard. Those two assertions are the guard against silent ghost rows if a
future bake-stream release ever changed its padding contract. `shardPayload(s)`
returns a DataView (nonzero byteOffset), so the read also exercises our DataView
source path and the BR-07 partial-window copy.

## The U32-is-a-string-index ownership boundary

An LBK1 U32 lane is a STRING-TABLE INDEX, not a value. Our reader returns the raw
index number; RESOLUTION stays in bake-stream. The proof asserts
`r.shardStringTable(s).get(lbr.getU32(row, id)) === r.get(globalRow, name)` -- i.e.
our index, resolved by bake-stream, reproduces bake-stream's own resolved string.
Adding a string table to this reader is a different package's job; the reader's
contract is bytes-to-numbers, and an index is a number.

## The D3 no-translate control (teeth)

test/coop-lbk1.test.js T5.5 builds a SECOND reader over the SAME shard bytes with
the u32 field typed as the RAW wire code 3 (= our T_I16, width 2, signed) and
asserts it DIVERGES from the correctly-translated U32 read. To make the divergence
real (not a coincidence of small values), it forces per-shard string indices
>= 32768, where an I16 misread of a wide U32 index cannot equal the U32 value. The
test FAILS if the two agree -- so the D3 claim is falsifiable, not decorative. The
translated reader's correctness is separately asserted non-vacuous in the same loop.

## D10 -- no import edge (enforced, not claimed)

test/no-import-edge.test.js reads Reader.js and Reader.d.ts as text and asserts no
`from "@zakkster/..."` import appears, with a positive control proving the regex can
match. A sibling import in the reader would trip CI, not merely review.

## What ships / what does not

- Ships (files[], 7): Reader.js, Reader.d.ts, llms.txt, README.md, CHANGELOG.md,
  LICENSE, package.json. The `file:` devDeps and every test/ + mock/ file are
  excluded from the tarball; Cookbook.md is repo-only.
- Torture unchanged and sibling-free: `node --expose-gc test/torture.mjs` still runs
  standalone with its emulated oracles. The REAL-sibling proof lives only in npm test.

## /release 0.5.0 breadcrumb (records under Added / Changed)

- Added: coop-bake / coop-lbk1 (+ D3 no-translate control) / coop-multireader /
  coop-join cooperation-proof suites; test/mock fixtures (all-8-lane + NaN/+/-Inf/-0
  + real sample); no-import-edge assertion; Cookbook.md (repo-only); this record.
- Changed: test count 73 -> 81; VERSION 0.4.0 -> 0.5.0 (Reader.js, package.json,
  llms.txt); `@zakkster/lite-bake` + `@zakkster/lite-bake-stream` added as `file:`
  devDependencies (test-only). No runtime change: Reader.js diff is the VERSION line.
