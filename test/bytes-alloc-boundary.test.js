/**
 * S7b -- bytes() is a COLD-PATH allocator (negative gate).
 *
 * The zero-alloc torture gates (t6) deliberately EXCLUDE bytes(): it returns a
 * Uint8Array VIEW wrapper, and minting a wrapper is an allocation. This gate pins
 * that fact from the other side, so nobody can quietly "optimize" bytes() into a
 * cached/reused view -- which would let it slip into the hot path under a false
 * zero-GC banner. The observable property that makes bytes() allocating is that
 * every call yields a FRESH object; if that ever stops being true (a pooled or
 * cached wrapper), this gate fires and forces an explicit decision.
 *
 * A semantic check (distinct object identity per call) is used rather than a heap
 * measurement: the view wrappers are transient (GC'd each iteration), so the
 * retained-alloc profiler channel cannot see them -- identity is deterministic and
 * non-flaky where a byte-count gate would be noisy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LiteBinaryReader } from "../Reader.js";

function makeReader() {
    // 4 rows x 8 bytes: one U32 field at offset 0 (ids run 0..).
    const buf = new ArrayBuffer(32);
    const dv = new DataView(buf);
    for (let i = 0; i < 4; i++) dv.setUint32(i * 8, 0xdeadbeef ^ i, true);
    return new LiteBinaryReader(buf, { schema: [{ name: "raw", type: 5, offset: 0 }], stride: 8 });
}

test("S7b bytes() returns a Uint8Array view (not a number)", () => {
    const r = makeReader();
    const span = r.bytes(0, 0, 4);
    assert.ok(span instanceof Uint8Array, "bytes() must return a Uint8Array view");
    assert.equal(span.length, 4);
});

test("S7b bytes() mints a FRESH object every call (cold-path allocator, not zero-GC)", () => {
    const r = makeReader();
    const id = r.field("raw");
    const N = 256;
    const seen = new Set();
    for (let i = 0; i < N; i++) seen.add(r.bytes(i & 3, id, 4));
    // Every call is a distinct object -> N allocations. If bytes() ever pooled or
    // cached its wrapper, seen.size would drop below N and this gate would fire.
    assert.equal(seen.size, N, "bytes() reused a wrapper across calls -- it is no longer a pure cold-path allocation; re-evaluate the zero-GC boundary before shipping");
});

test("S7b the numeric getters, by contrast, return primitives (the zero-alloc path)", () => {
    const r = makeReader();
    const id = r.field("raw");
    const a = r.getU32(0, id);
    const b = r.getU32(0, id);
    assert.equal(typeof a, "number", "getU32 returns a primitive number");
    assert.equal(a, b, "a primitive read has value identity -- no allocation, unlike bytes()");
});
