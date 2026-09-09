/**
 * T5.1 -- the fromBaked cooperation proof (node:test).
 *
 * RULING A: bake REAL records with @zakkster/lite-bake, open lite-bake's OWN
 * Reader as the oracle, open ours via fromBaked, and assert EVERY cell agrees.
 * Offsets and stride are READ from lite-bake's reported layout
 * (`baked.schema[k].offset`, `ora.offsetBytes(name)`), NEVER computed here --
 * lite-bake sorts fields descending-size and pads the stride, so the layout is
 * its to state. The oracle cell is `ora.get(i, name)`, cross-checked once per
 * field against a raw typed-array lane read. Compared cells are tallied so the
 * proof is provably non-vacuous, with >= 1 cell per lane.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bake, Reader as BakeReader } from "@zakkster/lite-bake";
import LiteBinaryReader, {
    T_F32, T_F64, T_I32, T_I16, T_I8, T_U32, T_U16, T_U8,
} from "../Reader.js";
import { makeFixtures } from "./mock/fixtures.js";

// A raw typed-array lane read from lite-bake's OWN eight views -- the second,
// independent oracle beside ora.get(). Uses lite-bake's own stride/offset
// helpers so the address arithmetic is never restated on our side.
function rawLane(ora, type, name, i) {
    switch (type) {
        case T_F32: return ora.f32[i * ora.strideF32 + ora.offsetF32(name)];
        case T_F64: return ora.f64[i * ora.strideF64 + ora.offsetF64(name)];
        case T_I32: return ora.i32[i * ora.strideU32 + ora.offsetI32(name)];
        case T_I16: return ora.i16[i * ora.strideU16 + ora.offsetI16(name)];
        case T_I8: return ora.i8[i * ora.stride + ora.offsetI8(name)];
        case T_U32: return ora.u32[i * ora.strideU32 + ora.offsetU32(name)];
        case T_U16: return ora.u16[i * ora.strideU16 + ora.offsetU16(name)];
        default: return ora.u8[i * ora.stride + ora.offsetU8(name)]; // T_U8
    }
}

test("T5.1 fromBaked reads real lite-bake output cell-for-cell", () => {
    const fixtures = makeFixtures();
    let compared = 0;
    const perLane = new Map();

    for (const [fxName, { records, overrides }] of Object.entries(fixtures)) {
        const baked = bake(records, { schema: overrides });
        const ora = new BakeReader(baked);
        const lbr = LiteBinaryReader.fromBaked(baked);

        // Shape agrees with lite-bake's OWN reported layout (never recomputed).
        assert.equal(lbr.count, baked.count, fxName + ": count");
        assert.equal(lbr.stride, baked.stride, fxName + ": stride");
        assert.equal(lbr.count, ora.count, fxName + ": count vs oracle");

        for (let k = 0; k < baked.schema.length; k++) {
            const name = baked.schema[k].name;
            const off = baked.schema[k].offset;
            const type = baked.schema[k].type;
            const id = lbr.field(name);

            // Offsets/stride/type are lite-bake's to state -- assert, never assume.
            assert.equal(lbr.offsetOf(id), off, fxName + "." + name + ": offset vs baked.schema");
            assert.equal(ora.offsetBytes(name), off, fxName + "." + name + ": offset vs oracle");
            assert.equal(lbr.typeOf(id), type, fxName + "." + name + ": shared type code");

            for (let i = 0; i < baked.count; i++) {
                const expected = ora.get(i, name);
                const actual = lbr.get(i, id);
                assert.ok(Object.is(expected, actual),
                    fxName + "." + name + "[" + i + "] fromBaked " + actual + " != oracle " + expected);
                // Second, independent oracle: a raw typed-array lane read.
                assert.ok(Object.is(rawLane(ora, type, name, i), actual),
                    fxName + "." + name + "[" + i + "] fromBaked " + actual + " != raw lane");
                compared++;
                perLane.set(type, (perLane.get(type) || 0) + 1);
            }
        }
    }

    // Non-vacuity: at least one cell compared, and every one of the 8 lanes
    // exercised at least once (a test that compares nothing passes vacuously).
    assert.ok(compared > 0, "no cells compared");
    for (const t of [T_F32, T_F64, T_I32, T_I16, T_I8, T_U32, T_U16, T_U8]) {
        assert.ok((perLane.get(t) || 0) >= 1, "lane " + t + " never compared");
    }
});
