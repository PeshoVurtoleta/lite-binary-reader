/**
 * T5.2 + T5.5 -- the fromLBK1Shard cooperation proof and the D3 collision control.
 *
 * RULING C: write a REAL LBK1 container with @zakkster/lite-bake-stream (mixed
 * F64 + U32 lanes), open it with bake-stream's Reader, carve each shard through
 * the raw hatch `{ bytes: r.shardPayload(s), rowStride: r.strideBytes(),
 * fields: r.schema.fields }`, and read it through OUR fromLBK1Shard.
 *   - `count` is ASSERTED === `r.shards[s].rowCount`, never assumed.
 *   - `payload_len === rowCount * rowStride` EXACTLY (shard padding is outside
 *     payload_len, so the DataView's byteLength is the tight row region).
 *   - F64 cells are bit-exact vs bake-stream's own `r.get(globalRow, name)` (via
 *     Object.is, so NaN/-0 could not slip through).
 *   - A U32 cell is a STRING-TABLE INDEX by contract; our reader returns that
 *     index number, and bake-stream RESOLVES it: assert
 *     `r.shardStringTable(s).get(index) === r.get(globalRow, name)`. String
 *     resolution stays in bake-stream -- the ownership boundary (decisions/0006).
 *
 * T5.5: the D3 no-translate CONTROL. LBK1's wire lane_kind for U32 is 3, which
 * collides with OUR T_I16 (also 3). fromLBK1Shard TRANSLATES wire 3 -> our T_U32
 * (5). The control builds a reader over the SAME shard bytes with the u32 field
 * typed as the raw wire code 3 (= T_I16, width 2) and asserts it DIVERGES from
 * the correctly-translated U32 value -- the test FAILS if they agree (teeth).
 */

// VERSION PIN: this proof was verified against @zakkster/lite-bake-stream ^1.7.1
// (the devDependency floor in package.json). The LBK1 wire lane_kind -> our type
// code map and the shard-carve contract (shardPayload / strideBytes / schema.fields,
// payload_len === rowCount*rowStride) are bake-stream's to state -- a major bump is a
// CONSCIOUS re-verify against its llms.txt, never a silent drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { serialize } from "@zakkster/lite-bake-stream";
import { Reader as StreamReader } from "@zakkster/lite-bake-stream/reader";
import LiteBinaryReader, { T_F64, T_U32, T_I16 } from "../Reader.js";

const STREAM_SCHEMA = { fields: [{ name: "val", laneKind: "f64" }, { name: "tag", laneKind: "u32" }] };

function writeContainer(records, targetShardBytes) {
    const bytes = serialize(records, {
        framing: "ndjson",
        writer: { schema: STREAM_SCHEMA, targetShardBytes: targetShardBytes },
    });
    return StreamReader.fromBuffer(bytes);
}

test("T5.2 fromLBK1Shard reads real lite-bake-stream shards cell-for-cell", () => {
    const records = [];
    for (let i = 0; i < 300; i++) {
        records.push({ val: i * -1.5 + 0.25, tag: "tag-" + (i % 11) });
    }
    // A small shard budget forces MANY shards -> the global<->local row mapping
    // and the per-shard string table are both exercised.
    const r = writeContainer(records, 512);
    assert.ok(r.shardCount >= 2, "expected multiple shards, got " + r.shardCount);

    const rowStride = r.strideBytes();
    let comparedF64 = 0;
    let comparedU32 = 0;
    let globalRow = 0;

    for (let s = 0; s < r.shardCount; s++) {
        const rowCount = r.shards[s].rowCount;
        const payload = r.shardPayload(s);
        // payload_len is the tight row region: rowCount * rowStride exactly.
        assert.equal(payload.byteLength, rowCount * rowStride, "shard " + s + ": payload_len");

        const lbr = LiteBinaryReader.fromLBK1Shard({ bytes: payload, rowStride: rowStride, fields: r.schema.fields });
        assert.equal(lbr.count, rowCount, "shard " + s + ": count === rowCount");

        const valId = lbr.field("val");
        const tagId = lbr.field("tag");
        // The D3 translation happened: wire 1 -> T_F64, wire 3 -> T_U32.
        assert.equal(lbr.typeOf(valId), T_F64, "val lane not translated to T_F64");
        assert.equal(lbr.typeOf(tagId), T_U32, "tag lane not translated to T_U32");

        const strings = r.shardStringTable(s);
        for (let row = 0; row < rowCount; row++, globalRow++) {
            // F64: bit-exact vs bake-stream's own reader.
            assert.ok(Object.is(lbr.getF64(row, valId), r.get(globalRow, "val")),
                "shard " + s + " row " + row + ": F64 diverged");
            comparedF64++;

            // U32: our reader returns the raw string-table INDEX; bake-stream
            // owns resolution. Resolving the index must reproduce r.get()'s string.
            const index = lbr.getU32(row, tagId);
            assert.equal(strings.get(index), r.get(globalRow, "tag"),
                "shard " + s + " row " + row + ": U32 index does not resolve to the string");
            comparedU32++;
        }
    }

    assert.equal(globalRow, r.totalRows, "did not visit every row");
    assert.ok(comparedF64 > 0 && comparedU32 > 0, "vacuous: no cells compared");
});

test("T5.5 the D3 no-translate control diverges (the wire-3/I16 collision has teeth)", () => {
    // Force a per-shard string index >= 32768 in a SINGLE shard, so reading the
    // U32 lane as I16 (width 2, signed) MUST diverge from getUint32 on at least
    // one cell (a small positive index would read identically -- no teeth).
    const N = 33000;
    const records = new Array(N);
    for (let i = 0; i < N; i++) records[i] = { val: i + 0.5, tag: "s" + i };
    const r = writeContainer(records, 64 << 20);

    const rowStride = r.strideBytes();
    // The correctly-translated reader: wire 3 -> T_U32.
    const wireFields = r.schema.fields;
    // The BUG under test: trust the wire lane_kind AS our type code (no translate).
    // wire F64=1 -> T_F64 (coincidentally shared), wire U32=3 -> T_I16 (the collision).
    const rawFields = wireFields.map((f) => ({ name: f.name, type: f.laneKind, offset: f.offsetInRow }));
    assert.equal(rawFields[1].type, T_I16, "the u32 wire code must alias T_I16 for this control to bite");

    let diverged = 0;
    let translatedOk = 0;
    let globalRow = 0;
    for (let s = 0; s < r.shardCount; s++) {
        const rowCount = r.shards[s].rowCount;
        const payload = r.shardPayload(s);
        const good = LiteBinaryReader.fromLBK1Shard({ bytes: payload, rowStride: rowStride, fields: wireFields });
        const bad = new LiteBinaryReader(payload, { schema: rawFields, stride: rowStride, littleEndian: true });
        const tagId = good.field("tag");
        assert.equal(good.typeOf(tagId), T_U32, "translated reader must read T_U32");
        assert.equal(bad.typeOf(tagId), T_I16, "no-translate reader must read T_I16");

        const strings = r.shardStringTable(s);
        for (let row = 0; row < rowCount; row++, globalRow++) {
            const correct = good.getU32(row, tagId);
            // The translated read stays correct (positive control, non-vacuity).
            if (strings.get(correct) === r.get(globalRow, "tag")) translatedOk++;
            // The no-translate read misinterprets wide U32 indices as I16.
            if (bad.getI16(row, tagId) !== correct) diverged++;
        }
    }

    assert.ok(translatedOk > 0, "vacuous: the translated reader never read a resolvable index");
    assert.ok(diverged > 0,
        "the no-translate (wire-3-as-I16) read never diverged from the correct U32 -- the D3 collision was not exercised");
});
