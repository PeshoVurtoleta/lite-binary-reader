# S5 -- v0.5.0 -- cooperation proof: lite-bake / lite-bake-stream  [APPROVED -- SCOPE LOCKED]

status: APPROVED -- SCOPE LOCKED (all decisions resolved by review). Pipeline authorized:
  planner -> coder -> reviewer -> qa; reviewer REJECTED returns to coder, not forward.
  RESOLVED:
    D-1 = (b) MultiReader-style helper is a TEST/EXAMPLE, NOT a core export. Reader.js stays
      byte-identical (VERSION const only); R_* union 10, type table 8, dts-drift floor 32 all HOLD.
    D-2 = (a) siblings consumed as file: devDependencies (import by real scope name); the pack
      leak gate must confirm no devDep/sibling/test in the tarball.
    D-3 = (a) bump VERSION 0.4.0 -> 0.5.0 across the three sites; a proof-release, CHANGELOG says so.
    T5.8 Cookbook.md = REPO-ONLY (NOT added to package.json files[]); the shipped file list STAYS
      at 7. Cookbook is dev-facing docs, still test-backed (each recipe cites a passing test).
  PRE-STEP (part of this session): correct the stale ROADMAP version slots
    (S5 v0.4.0 -> v0.5.0, S6 v0.5.0 -> v0.6.0) -- done at session start, before the planner.
version_target: 0.5.0   (the reflow after S4b took v0.4.0: S5 cooperation -> v0.5.0, S6 lite-query
  -> v0.6.0. ROADMAP.md:584/587 and :619/622 still print the OLD slots (S5=v0.4.0, S6=v0.5.0) --
  a pre-step of this session, or a standalone doc fix, corrects them. Flagged in Housekeeping.)
depends_on: S2 (DONE, fail-closed door -- the coded doors on fromBaked/fromLBK1Shard, BR-06). NOT
  S4 and NOT S4b -- the cooperation constructors are S0 surfaces; laneOf and the cursor sit beside
  them and are irrelevant to this proof.
blocks: S6 (lite-query adapter, v0.6.0) depends on this -- it consumes the reader inside a stream.
roadmap anchor: ROADMAP.md:584 "S5 -- cooperation proof". The roadmap's "if you only do a subset"
  (ROADMAP.md:384) ranks S5 as THE cross-package rep: fromBaked / fromLBK1Shard reading the REAL
  sibling output cell-for-cell, no import edge, "is the whole cooperation claim."

===============================================================================
## Gating precondition -- MET (verified this planning turn)
===============================================================================
All three siblings exist as REAL, published packages in the suite, each with an llms.txt:
  - ../LiteBake          v1.3.1   (bake, Reader, Reader.fromBytes, Types)
  - ../LiteBakeStream    v1.7.1   (Writer, Reader, MultiReader, shardPayload, ... via subpaths)
  - ../LiteQuery         v2.2.0   (S6's peer, not this session)
So S5 is a REAL cross-package proof, not the emulated-oracle stand-in torture T5 Oracle B/C uses
today. This is the entire point of the session: replace "reads emulated bytes" with "reads the
sibling's actual output," cell-for-cell.

===============================================================================
## What S5 is (and what it is NOT) -- the risk profile differs from S4b
===============================================================================
S4b was a NEW read path (laneOf): highest correctness risk to the reader itself. S5 is a PROOF:
fromBaked / fromLBK1Shard ALREADY EXIST (S0 surfaces, coded doors added in S2/BR-06). S5 does not
add a public read surface. Its risk is elsewhere, and it is real:
  1. HIDDEN IMPORT EDGE (D10). The siblings must be devDependencies of the TEST only. A stray
     `import ... from "@zakkster/lite-bake"` in Reader.js is a suite-law violation. Gated by grep.
  2. TARBALL LEAK. Pulling siblings in as devDeps must NOT add them (or test files) to the shipped
     tarball. The pack gate must still show ONLY the 7 shipped files, no devDep, no test/.
  3. THE PROOF CAN FAIL HONESTLY. If a real sibling buffer reads WRONG through fromBaked /
     fromLBK1Shard, that is a fidelity BUG in a cooperation constructor -- the fix is a real reader
     change (reviewer diffs it; it is a correctness fix, not a feature). Likely trigger points:
     lite-bake sorts fields by DESCENDING SIZE and pads stride to max field alignment + buffer to a
     multiple of 8, so the offsets/stride our fromBaked consumes MUST come from lite-bake's own meta
     (`{ stride, count, schema }`) / Reader, never be assumed. The D3 wire-code divergence (below)
     is the other. If the proof is clean, Reader.js changes ONLY its VERSION const. If it exposes a
     bug, that is the session earning its keep -- but it means a pinned-core edit, so call it out
     loudly and let the reviewer diff it.

===============================================================================
## THE THREE DECISIONS FOR YOUR REVIEW (resolve before the pipeline runs)
===============================================================================

### D-1  MultiReader-style helper: SHIPPED core export, or test/example helper?
The roadmap lists "a MultiReader-style helper: a thin union mapping a global row index to
(shard, localRow), dispatching to the per-shard LiteBinaryReader" (mirrors bake-stream's own
`MultiReader`). Two ways to land it:
  (a) EXPORT it from Reader.js -> it moves Reader.d.ts, RAISES the dts-drift member floor again,
      is a genuine new PUBLIC surface (higher review cost), and makes v0.5.0 a FEATURE release.
  (b) TEST/EXAMPLE helper (in test/ or examples/) -> Reader.js stays byte-identical (only VERSION
      moves), all frozen invariants (R_* union 10, type table 8, drift floor 32) untouched, and
      S5 stays a pure PROOF.
  RECOMMEND (b). S5's job is to PROVE cooperation, mirroring S6's explicit "cookbook, not an
  import" discipline. Shipping a union type is a separate feature (call it S5b) with its own d.ts /
  drift / version-as-feature cost; do not smuggle it into the proof. If you WANT MultiReader as a
  shipped surface, say so and I re-scope it as its own brief.

### D-2  How the tests consume the siblings (this decides the tarball-leak gate)
  (a) file: devDependencies -- `"@zakkster/lite-bake": "file:../LiteBake"`, etc. -> tests import by
      the REAL scope name (`@zakkster/lite-bake`, `@zakkster/lite-bake-stream/writer`), reading
      exactly as a downstream consumer would; npm resolves locally, no network; devDependencies are
      excluded from `npm pack` by construction.
  (b) relative import -- `../../LiteBake/Bake.js` -> no package.json change, but imports a sibling's
      internal path (fragile to their file moves) and does NOT exercise their public entry.
  RECOMMEND (a) file: devDeps. It is the honest consumer test and keeps the pack clean. CAVEAT: it
  adds a `devDependencies` block to package.json for the FIRST time. The suite Law is "zero RUNTIME
  deps"; test-only devDeps are allowed (node:test is already one in spirit), but confirm you are OK
  adding lite-bake + lite-bake-stream as file: devDeps. The planner must VERIFY the pack gate still
  lists only the 7 shipped files after this.

### D-3  Does a test-only proof bump VERSION to 0.5.0, or is it a 0.4.1?
If S5 lands with Reader.js untouched (decision (b) on both above), there is no runtime surface
change -- only new test files, a decisions record, and doc prose. Two honest framings:
  (a) 0.5.0 -- honor the roadmap's version_target; the CHANGELOG 0.5.0 head records a headline
      capability CLAIM now PROVEN against real siblings (cooperation is the package's whole reason
      to exist). Bump the three VERSION sites; the drift gate still asserts VERSION === pkg.
  (b) 0.4.1 -- a patch, since no public surface changed; reserve 0.5.0 for a surface change.
  RECOMMEND (a) 0.5.0. The cooperation proof is the strategic centre of the package, and the
  roadmap already earmarks 0.5.0 for it. But it IS a proof-release, not a feature-release -- the
  CHANGELOG must say so plainly (facts only: "Added tests proving fromBaked/fromLBK1Shard read real
  lite-bake / lite-bake-stream output cell-for-cell; no runtime change"). If the proof exposes a
  fidelity bug (see risk #3), that fix is a real 0.5.0 change and the CHANGELOG gets a Fixed entry.

===============================================================================
## State check (what is already true, so S5 does NOT redo it)
===============================================================================
- fromBaked / fromLBK1Shard EXIST and have coded doors (S2/BR-06): a malformed sibling object
  throws R_BAD_SOURCE / R_BAD_SCHEMA, not a raw TypeError. S5 feeds them WELL-FORMED real output;
  it does not re-litigate the door (that is torture t9's job and stays as-is).
- The R_* union is exactly 10, the type table exactly 8, the dts-drift member floor is 32. S5 adds
  NO new R_* code and NO new type code. Under D-1(b)/D-3(a) it adds NO new d.ts member either --
  so the drift gate's numbers do NOT move. (If you pick D-1(a), they do; re-scope accordingly.)
- torture.mjs is a STANDALONE alloc/fidelity harness (t5 uses EMULATED lite-bake/LBK1 oracles).
  It stays sibling-free so `node --expose-gc test/torture.mjs` needs no devDep. The REAL-sibling
  proof lands in node:test (npm test), NOT inside torture. (See Torture/gate impact.)
- Our type codes: T_F64=1, T_U32=5 (order F32,F64,I32,I16,I8,U32,U16,U8; TYPE_BYTES=[4,8,4,2,1,4,2,1]).
  lite-bake's in-memory Types.U32 is also 5 -> the bake path's code map is near-identity. The LBK1
  WIRE codes DIVERGE: wire F64=1 (shared) but wire U32=3 (ours 5). That divergence is the D3 proof.

===============================================================================
## Tasks
===============================================================================
PLANNER PRE-STEP (mandatory, before writing any test): read ../LiteBake/llms.txt AND
../LiteBakeStream/llms.txt IN FULL and confirm the EXACT current API names. The ROADMAP was written
speculatively: `shardPayload(i)` is confirmed present, but `strideBytes()` is NOT in the llms.txt --
find the real stride/rowStride accessor (or derive rowStride from the schema) before relying on it.
Do NOT write any sibling API from memory. lite-bake-stream exports via SUBPATHS (`/writer`,
`/reader`, `/multi-reader`) -- get the specifiers right.

### T5.1 -- coop-bake.test.js (real lite-bake -> fromBaked, cell-for-cell)
  - `bake(records)` in lite-bake -> its `ArrayBuffer` + meta. Build our reader input from lite-bake's
    OWN layout (stride/count/schema/offsets it reports via its Reader or `fromBytes` meta), NOT from
    assumed offsets -- lite-bake sorts fields descending-size and pads stride, so the offsets are its
    to state. -> `fromBaked(...)` -> assert EVERY cell equals lite-bake's own `Reader` cell read
    (`f32[i*strideF32+off]` / `offsetXxx(name)`), native-endian, across the lanes lite-bake infers.
  - Because lite-bake infers the SMALLEST type, force coverage of all 8 lanes with `Types` overrides
    (or craft records whose inference spans the lanes). Map lite-bake's `Types` code -> our T_* code
    (near-identity for the in-memory path); assert the mapping, do not assume it.
  - Non-vacuity: assert >= 1 cell per exercised lane actually compared (a test that compares nothing
    passes vacuously).

### T5.2 -- coop-lbk1.test.js (real lite-bake-stream -> fromLBK1Shard, the D3 proof)
  - Write a container with lite-bake-stream's `Writer` (mixed lanes: at least one f64 + one u32).
    Open it with bake-stream's `Reader`. Carve a shard via the raw hatch:
    `{ bytes: shardPayload(i), rowStride: <verified stride accessor>, fields: schema.fields }`
    -> `fromLBK1Shard(...)`.
  - Assert F64 cells are bit-exact vs bake-stream's own `Reader.get(row, field)`.
  - Assert U32 cells equal the raw STRING-TABLE INDEX (an LBK1 U32 lane is a string index, not a
    value). Document that string RESOLUTION stays in bake-stream -- our reader returns the index, by
    contract. This is the ownership boundary, state it in the test and in decisions/0006.
  - THE D3 TRANSLATION is the point: LBK1 wire U32=3 must be translated to our T_U32=5 inside
    fromLBK1Shard. Confirm fromLBK1Shard already does this (it is an S0 surface); if it does NOT, the
    proof fails and the fix is a real fromLBK1Shard edit (flag per risk #3).

### T5.3 -- MultiReader-style helper (per D-1: default = test/example, NOT a core export)
  - A thin union mapping a global row index -> (shard, localRow), dispatching to the per-shard
    LiteBinaryReader over the foreign shards from T5.2. Mirrors bake-stream's own `MultiReader`, but
    over shards read through OUR core. Lives in test/ (or examples/) under D-1(b). Assert a global
    read hits the correct shard+localRow and matches bake-stream's `MultiReader.get` cell-for-cell.

### T5.4 -- the D10 no-import-edge assertion (a test, so it is enforced, not just claimed)
  - `grep -r 'from "@zakkster' Reader.js` MUST be empty (the reader imports no sibling). Encode this
    as an assertion (a tiny node:test that reads Reader.js and asserts no such import), so a future
    regression trips CI, not just review. Reader.d.ts likewise imports no sibling.

### T5.5 -- the D3 no-translate CONTROL (teeth -- it MUST be able to fail)
  - A control that reads the LBK1 U32 lane WITHOUT the wire->ours code translation (wire 3 read as
    our code 3 = T_I16, width 2) and asserts the result DIVERGES from the correct value. If the
    no-translate path accidentally matched, the D3 claim would be decorative. This is the
    reproduced "the collision is exercised" assertion from ROADMAP.md:611.

### T5.6 -- VERSION + records + docs (per D-3)
  - Under D-3(a): bump VERSION 0.4.0 -> 0.5.0 in Reader.js AND package.json AND llms.txt (the three
    sites the release skill checks). Drift gate asserts Reader.js VERSION === package.json.
  - decisions/0006-cooperation-proof.md: record D-1/D-2/D-3 as resolved, the D3 wire-code map
    (wire F64=1 shared, wire U32=3 -> our 5), the U32=string-index ownership boundary, and a
    /release 0.5.0 breadcrumb (what lands under Added/Changed/Fixed).
  - README + llms.txt NARRATIVE for the cooperation proof is a FOCUSED DOCS PASS before /release
    (the recurring lesson: the release skill checks doc PRESENCE, not FRESHNESS). The Composability
    section of README already promises fromBaked/fromLBK1Shard -- extend it to say the proof now
    reads REAL sibling output, and add the U32-is-a-string-index note.

### T5.7 -- mock data-variant fixtures (YOUR REVIEW SUGGESTION -- mirror bake-stream's real-mocked data)
  - Add `test/mock/` (test-scoped, so the existing "test/ absent from tarball" pack gate already
    covers it -- do NOT put it at repo root or a new pack-exclusion assertion is needed). Fixtures
    as small, named record sets fed through BOTH cooperation paths (T5.1 bake, T5.2 LBK1):
      - shallow: a flat single-lane and a flat multi-lane record set (the baseline).
      - nested: records with nested objects/arrays as the BAKER INPUT -- the baker flattens them;
        our proof is that fromBaked/fromLBK1Shard read whatever FLAT layout the baker emitted. (The
        reader itself is flat/fixed-stride; "nested" exercises the baker's flattening, not a reader
        feature. State that boundary in the fixture's comment so it is not mistaken for a reader
        capability.)
      - NaN: an F64/F32 lane carrying NaN -- assert bit-exact via `Number.isNaN`, NOT `===`
        (`NaN === NaN` is false). This is where a naive read silently lies; it is the point of the
        variant.
      - +/-Infinity: assert the sign survives (`Infinity` vs `-Infinity`, distinct).
      - +/-0: assert signed-zero survives (`Object.is(-0, x)`), since it is a real F64 bit pattern.
      - real data: one non-synthetic sample (e.g. a small real record dump) baked and read back.
    NOTE lite-bake is STRICT since 1.1.0 (non-numbers/absents/extras refuse E_*), and infers the
    smallest lane; craft the mock records (or use Types overrides) so the intended lane is actually
    produced. NaN/Infinity force a FLOAT lane in lite-bake by design -- lean on that.

### T5.8 -- Cookbook.md (YOUR REVIEW SUGGESTION -- LiteQuery-style recipes, TEST-BACKED)
  - Seed a `Cookbook.md` modeled on `../LiteQuery/Cookbook.md`, beginner -> pro. SCOPE DISCIPLINE:
    S5 seeds ONLY the recipes S5 already PROVES with a passing test (each recipe cites its test), so
    the cookbook starts real, never aspirational. The broader beginner->pro spread grows in S7
    (docs) -- do not let a full cookbook balloon the proof session.
  - Recipes S5 can back with tests, in order of difficulty:
      1. beginner: read a raw/foreign buffer (schema + offset + endianness) -- the headline demo.
      2. read a lite-bake buffer via fromBaked (T5.1).
      3. read a lite-bake-stream shard via fromLBK1Shard; note the U32-is-a-string-index boundary
         (T5.2).
      4. union same-schema shards via the MultiReader-style helper (T5.3).
      5. PRO / flagship (your scenario): a query-builder result with a PARENT table + CHILDREN
         outputs -- bake each table separately, open one LiteBinaryReader per table, and join
         parent->children by key in CALLER code. This is DIFFERENT schemas joined by key, NOT a
         same-schema union, so it is a RECIPE, never a shipped API -- join semantics are the
         caller's. Back it with a test that bakes a parent + a child table, reads both through
         separate readers, and asserts the joined shape. This recipe is the concrete argument for
         D-1(b): the multi-instance/parent-child pattern is inherently caller-side.
  - Cookbook.md is a shipped doc IF you want it discoverable from npm: then add it to package.json
    `files[]` and the pack gate asserts its presence (like llms.txt/README). Or keep it repo-only
    (not in files[]) as dev-facing docs. RECOMMEND ship it (files[] += Cookbook.md) -- a recipe book
    is a consumer asset; confirm, since it changes the shipped file list from 7 to 8.

===============================================================================
## Torture / gate impact
===============================================================================
- torture.mjs stays STANDALONE and sibling-free. Its t5 EMULATED lite-bake/LBK1 oracles (Oracle
  B/C) remain -- they are the alloc-gated, dep-free fidelity check. S5's REAL-sibling proof is a
  node:test suite (npm test), so `node --expose-gc test/torture.mjs` gains no devDep and stays
  runnable with zero siblings installed. (Optional, planner's call: a comment in t5 noting the real
  proof now lives in test/coop-*.test.js. No torture BODY change is required by this session.)
- The pinned core (getF64..getU8 / get / bytes / seek+cursor / readRow / laneOf) stays
  byte-identical -- Reader.js changes ONLY its VERSION const under the clean-proof path. Reviewer
  diffs it. The ONLY exception is risk #3: if the proof exposes a fromBaked/fromLBK1Shard fidelity
  bug, that constructor body changes and the reviewer diffs the fix explicitly.
- No new T6 gate: S5 adds no new READ surface, so there is no new hot loop to alloc-gate. (The
  cooperation constructors' existing t6 cold-construction posture is unchanged.)

===============================================================================
## DONE WHEN
===============================================================================
1. coop-bake.test.js: real `bake()` output reads cell-for-cell equal through `fromBaked` vs
   lite-bake's own Reader, across all exercised lanes, non-vacuously.
2. coop-lbk1.test.js: real bake-stream `Writer` output reads through `fromLBK1Shard` with F64 cells
   bit-exact and U32 cells equal to the raw string-table index; the ownership boundary documented.
3. The D3 translation control (T5.5) FAILS without the wire->ours code map (teeth); the D10
   no-import-edge assertion (T5.4) passes (`grep 'from "@zakkster"' Reader.js` empty).
4. MultiReader-style helper reads a global row through the correct shard, matching bake-stream's
   MultiReader (lands per D-1; default = test/example, no core export).
4b. Mock variants (T5.7) drive both cooperation paths: NaN (Number.isNaN), +/-Infinity (sign),
   +/-0 (Object.is), nested-baker-input flattened correctly, and a real-data sample -- all read
   cell-exact. Cookbook.md (T5.8) seeded with the test-backed recipes incl. the parent/children
   multi-reader flagship.
5. `npm pack --dry-run` lists ONLY the shipped files -- 7, or 8 if Cookbook.md ships (D-2/T5.8) --
   with no sibling, no devDep, no test/ (mock/ included) in the tarball (D-2's leak gate).
6. Frozen invariants HOLD unchanged: R_* union 10, type table 8, dts-drift member floor 32 (no new
   d.ts member under D-1(b)). VERSION synced across the three sites (D-3).
7. `npm run verify` green (test + torture + controls). decisions/0006 records D-1/D-2/D-3 and the
   D3 code map. IF the proof exposed a fidelity bug, the fix is diffed and gets a CHANGELOG Fixed.

===============================================================================
## NON-GOALS (later sessions -- guard against scope creep)
===============================================================================
- No lite-query streaming adapter -- that is S6 (v0.6.0), depends on this. Do not pull LiteQuery in.
- No string RESOLUTION inside the reader -- an LBK1 U32 is a string-table index by contract; the
  reader returns the index, bake-stream resolves it. Adding a string table to our reader is a
  different package's job.
- No MultiReader as a SHIPPED export unless you pick D-1(a) -- default keeps it test/example.
- No import edge into ANY sibling (D10) -- siblings are devDeps of the TEST only.
- No write path, no schema mutation, no new R_* code, no new type code -- all frozen invariants.
- No new READ surface, so no new laneOf-style hot path and no new T6 gate.
- Do NOT touch torture.mjs's emulated oracles into real-sibling imports -- torture stays standalone.

===============================================================================
## Housekeeping flagged for you (decide before or alongside the session)
===============================================================================
- ROADMAP.md version slots are STALE: :584/:587 print "S5 -- v0.4.0 / version_target: 0.4.0" and
  :619/:622 print "S6 -- v0.5.0 / version_target: 0.5.0". After S4b took 0.4.0 the true slots are
  S5=0.5.0, S6=0.6.0. This is roadmap PLANNING prose (not a shipped version site, so it did not gate
  /release 0.4.0), but it should be corrected -- either as a pre-step of this session or a one-off
  doc fix now. Say the word and I bump both slots.
- The LiteCatalog card is now STALE at 0.3.0 (0.4.0 just published). Per /sync-card ("the card must
  match the repo"), I should re-run /sync-card lite-binary-reader to bump the card + _index.md to
  0.4.0. This is a NOW follow-up to the publish, independent of S5 -- I can do it on your go-ahead.
- scratchpad/ is still UNTRACKED and NOT in .gitignore (.gitignore lists only /node_modules/ and
  /package-lock.json). A blanket `git add -A` sweeps it in. Offer stands to add `/scratchpad/`.
- decisions/0005-typed-lane.md landed with the 0.4.0 commit you reviewed. S5 would add
  decisions/0006-cooperation-proof.md.
