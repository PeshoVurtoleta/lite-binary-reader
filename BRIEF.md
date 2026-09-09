# Demo refresh (post-1.1.0) -- code demos + a visualization layer  [IMPLEMENTED]

status: IMPLEMENTED (D3 accepted: one pass, T1 -> T2+V2 -> T3+V1; V3 deferred).
Shipped this session (demo/ only, no Reader.js change, no version bump):
  - T1  demo/compound.mjs -- zero-alloc join (seek + readRow into one reused sink),
        separated from the cold print; honest framing. Verified: 13 units, runs clean.
  - T2  demo/standalone.mjs -- new 64-bit event record: getU64/getI64 (bigint) + a
        variable-length bytes(row,id) borrowed span, with the BigInt-allocation note.
  - T3  demo/webgl-handoff.mjs (NEW) -- laneOf proves eligibility + prints exact
        gl.vertexAttribPointer args; declines honestly for f64/i64/u64 and BE buffers.
  - V1+V2 demo/visuals.html (NEW) -- byte grids generated from the LIVE reader
        (offsetOf/typeOf/stride, never hand-drawn): interleaved VBO + a real WebGL
        upload of reader.buffer; unaligned-BE record with an endianness-reinterpret
        toggle (3.5 vs 3.45e-41 on the same 4 bytes) + the padding reframe.
  - package.json adds `demo:webgl`; README Demos section rewritten (3 -> 5 demos).
DEFERRED: V3 (ecosystem flow scene) -- lowest value, most generic; a later branding pass.
Full suite still green (101/101, torture ok, controls ok) -- no module change.
NOTE: package.json + README carry BOTH the 1.1.0 release edits and these demo edits in
the working tree; sequence the commits as you prefer (1.1.0 first, then a demo commit).

-- Original plan preserved below for reference --

status: DRAFT, plan-only. Nothing implemented until you say "run it". This session
touches ONLY `demo/` (+ possibly a new `demo/` SVG/HTML) -- `Reader.js` and the
shipped surface are UNCHANGED, so there is NO version bump and NO module torture gate.
Demos are repo-only (not in `package.json` files[]), so this lands as its own commit
on top of the published 1.1.0, no release needed. The demo hot-path law
(`demo-audit` skill: 0 alloc/frame, no forced reflow) governs every interactive scene.

why_now: 1.1.0 shipped the 64-bit lanes, which UNBLOCKS the last piece the demos
couldn't show. A friend's/Gemini's review (agreed) found the demos prove baseline
capability but (a) contradict the zero-GC claim in one place, (b) never exercise
`bytes()`/`lengthField` or 64-bit, and (c) miss the GPU zero-copy story -- the single
most persuasive use for a systems/graphics audience.

===============================================================================
## What exists today (grounded, not assumed)
===============================================================================
  - demo/standalone.mjs -- unaligned + foreign big-endian read; `laneOf` fast path
    for the aligned host-endian case; `laneOf` decline for the BE/unaligned case.
    Does NOT touch `bytes()`, `lengthField`, or 64-bit.
  - demo/compound.mjs -- lite-bake -> fromBaked -> caller-side join -> lite-query
    stream. Ecosystem story is good; the join's DISPLAY loop uses `.map()` +
    template strings (allocations), so the "reads are zero-GC" comment sits next to
    allocation-heavy code. Reads were already zero-GC; the S4 surfaces (seek/readRow)
    are unused.
  - demo/index.html -- a live oscilloscope: 3-ch i16 interleaved, rendered through
    `laneOf` (raw Int16Array) at 0 alloc/frame, with a BE-wire `getI16` fallback.
    Already honest and already respects the hot-path law. This is the canvas host a
    new scene would extend.

===============================================================================
## The work, in priority order
===============================================================================

### T1 -- fix compound.mjs (credibility; highest priority)
  Exercise the S4 surfaces and stop the visible allocation in the hot loop:
  - Pre-allocate ONE reusable sink (`const itemOut = new Array(3)`) outside the loop.
  - Use the row cursor for the sequential parent scan (`pr.seek(p)` + `pr.u32(...)`).
  - Use `cr.readRow(childRow, itemOut)` for the child side -- caller-owned sink, no
    per-row temp object/array.
  - Keep the indexing `Map` (it is COLD -- built once). That is fine and correct.
  HONESTY GUARDRAIL: this is a PRINT demo -- the human-readable strings still
  allocate BY NECESSITY. Frame it accurately: "zero-alloc read/accumulate path,
  separated from a cold print", NOT "the demo is now zero-GC". The win is that the
  READ path is zero-alloc AND finally shows seek/readRow, not that printing is free.

### T2 -- enrich standalone.mjs (now unblocked by 1.1.0)
  - Add a variable-length span: a field with `lengthField`, read via the 2-arg
    `bytes(row, id)`. This is the shipped zero-copy blob/string escape hatch the demo
    never exercises. Show "borrowed view -- copy what you keep".
  - Add a REAL 64-bit read: a `T_U64`/`T_I64` field read with `getU64`/`getI64`
    (returns a `bigint`). Inline the honest note: "this read allocates a BigInt --
    the second documented exception alongside bytes(); the 8 primitive lanes stay
    zero-GC." No two-u32 workaround needed anymore.
  - Pair it with the unaligned-BE BYTE GRID visual (see V2).

### T3 -- WebGL/WebGPU hand-off demo = the zero-copy visual (biggest new value)
  A new demo showing `laneOf` as a zero-copy GPU feed. Build it with the REAL
  semantics, not the loose sketch from the review:
  - `laneOf` returns a SCALAR per-field lane (`{view, elemStride, elemOffset}`), not
    a vecN. A `vec3 position` is N consecutive scalar fields OR is driven off the
    record stride -- handle the components/`size` dimension explicitly; `laneOf`
    does not carry it.
  - You upload `reader.buffer` (the whole interleaved ArrayBuffer), zero-copy. The
    honest claim `laneOf` earns: it PROVES host-endian + alignment (i.e. the buffer
    is uploadable as-is) AND hands you the exact arithmetic:
    `byteStride = elemStride * width`, `byteOffset = elemOffset * width`.
  - Node-friendly committed version: assert lane eligibility and PRINT the exact
    `gl.vertexAttribPointer` args + "0 copies, 0 unpack loops, 0 allocations". No GL
    dependency in Node. The LIVE upload belongs in the browser (extend demo/index.html
    or a sibling .html), where a real GL context exists.
  - Throw honestly if the field is ineligible (opposite-endian / unaligned) -- the
    decline contract is part of the story, not an error to hide.

===============================================================================
## The visualization layer (folds INTO the demos above)
===============================================================================
  The zero-copy visual IS T3; the byte grids render the SAME buffers T1/T2 build.
  So visuals are not a separate effort -- they are how these demos are presented.

### V1 -- AoS/SoA + laneOf mapping / the zero-copy illusion (build FIRST among visuals)
  The highest-value AND most honest visual: `laneOf` literally IS "an SoA column
  exposed as a typed-array view aliasing the buffer" -- the actual mechanism, not a
  metaphor. One interleaved buffer grid -> the chosen lane highlighted as a
  contiguous typed-array slice -> a dashed arrow into a WebGL VBO box. Caption:
  "0 allocations, 0 unpack loops, 0 copies." This is the T3 companion.

### V2 -- unaligned big-endian byte grid (standalone)
  A 1-byte-cell grid with colored multi-byte field spans and offsets. Show the f32
  at offset 1 (bytes 1-4) with "a Float32Array cannot be CONSTRUCTED here; DataView /
  the reader can", and the BE reinterpret on an endianness toggle.
  PADDING REFRAME (do NOT borrow the generic "wasted space in red" trope naively --
  this library's tight layouts often have NO padding, which is the point): the
  TRUE, library-specific version is a side-by-side -- "a typed-array lane REQUIRES
  padding (red gaps) vs the DataView reader reads the tight UNALIGNED layout with no
  gaps." That is a claim only this reader can make.

### V3 -- ecosystem flow scene (LOWEST priority; context/branding, not a differentiator)
  lite-bake -> reader.fromBaked -> caller join -> lite-query stream -> decode -> viz.
  Reusing the `LiteDiContainer/diEcosystem/ecosystem-graph` SVG is pragmatic, but a
  reused ecosystem graph reads as generic across the suite -- every package has this
  story. Adapt it to THIS pipeline's real nodes/edges. Nice-to-have, defer if scope
  tightens.

===============================================================================
## Two guardrails that apply to EVERY visual
===============================================================================
  G1 -- GENERATE FROM THE REAL SCHEMA, never hand-draw. Derive every byte grid from
    the reader's actual `schema` offsets + `TYPE_BYTES` + `stride` at runtime (render
    the SVG from that). The credibility of a layout demo is that the picture is the
    ACTUAL layout the reader reads; a hand-drawn SVG with a mislabeled offset is worse
    than no diagram. This also makes the endianness toggle a REAL read.
  G2 -- BUILD FOR TRUTH + COMPREHENSION FIRST, shareability follows. The LinkedIn/X
    framing motivates; it must not steer. No red padding on a layout that has none;
    no vecN claim `laneOf` can't back; no "zero-GC" banner over a printing loop.

===============================================================================
## Decisions for you (recommendations inline)
===============================================================================
  D1 -- Format: static diagrams in SVG (README-embeddable, diffable, carousel-ready)
    + keep canvas for live/animated scenes (the oscilloscope)?  RECOMMEND: YES, both.
  D2 -- WebGL demo host: a Node-friendly "assert eligibility + print the exact args"
    demo (NO new dependency) as the committed artifact, with the LIVE upload added to
    the browser demo/index.html?  RECOMMEND: YES (no headless-gl devDep; keep it
    dependency-free and deterministic in Node).
  D3 -- Scope of THIS session: all of T1-T3 + V1-V2 in one cohesive pass (V3 deferred),
    or split (T1-T2 first, then T3+V1 as a second session)?  RECOMMEND: one session,
    T1 -> T2+V2 -> T3+V1, V3 deferred. It is a lot but cohesive; say "split" if you
    want it in two.
  D4 -- Ecosystem flow (V3): include now, or defer to a later branding pass?
    RECOMMEND: defer -- it is the lowest-value, most generic piece.

===============================================================================
## Non-goals / boundaries
===============================================================================
  - No `Reader.js` change, no version bump, no shipped-tarball change (demos are
    repo-only). This is a `demo/` commit on top of 1.1.0.
  - No new runtime dependency (a Node GL context would need one -- D2 avoids it).
  - No animated scene that allocates per frame or forces reflow (demo-audit law); the
    oscilloscope is the reference for how to stay at 0 alloc/frame.
  - Not a marketing deliverable: the demos must be correct and clear first; the
    shareable assets are a by-product of that, not the target.
