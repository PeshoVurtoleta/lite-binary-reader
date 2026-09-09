/**
 * T5.3 -- a MultiReader-style union over foreign LBK1 shards, TEST-ONLY.
 *
 * Per D-1(b) this is an EXAMPLE helper, NOT a core export: it lives here, never
 * in Reader.js, so the reader's public surface (and the dts-drift floor) does not
 * move. `ShardUnion` maps a GLOBAL row index to `(shard, localRow)` and dispatches
 * to the per-shard LiteBinaryReader read through OUR core. It mirrors
 * bake-stream's own MultiReader, and every global read is asserted cell-for-cell
 * against bake-stream's `r.get(globalRow, name)` (which does the same union
 * internally over its own shards) -- F64 direct, U32 resolved through the
 * owning shard's string table.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { serialize } from "@zakkster/lite-bake-stream";
import { Reader as StreamReader } from "@zakkster/lite-bake-stream/reader";
import LiteBinaryReader from "../Reader.js";

// A thin union over N per-shard readers sharing one schema. Test/example scope
// only -- never exported from Reader.js.
class ShardUnion {
    constructor(readers) {
        this.readers = readers;
        this.rowStarts = new Array(readers.length);
        let start = 0;
        for (let s = 0; s < readers.length; s++) {
            this.rowStarts[s] = start;
            start += readers[s].count;
        }
        this.totalRows = start;
    }

    // Map a global row -> { s, localRow }. Linear scan is fine for a test.
    locate(globalRow) {
        for (let s = this.readers.length - 1; s >= 0; s--) {
            if (globalRow >= this.rowStarts[s]) return { s: s, localRow: globalRow - this.rowStarts[s] };
        }
        return { s: -1, localRow: -1 };
    }

    get(globalRow, fieldId) {
        const loc = this.locate(globalRow);
        return this.readers[loc.s].get(loc.localRow, fieldId);
    }
}

test("T5.3 ShardUnion maps a global row to the correct shard and matches bake-stream", () => {
    const records = [];
    for (let i = 0; i < 500; i++) records.push({ val: i * 1.25 - 3, tag: "grp-" + (i % 7) });
    const bytes = serialize(records, {
        framing: "ndjson",
        writer: { schema: { fields: [{ name: "val", laneKind: "f64" }, { name: "tag", laneKind: "u32" }] }, targetShardBytes: 512 },
    });
    const r = StreamReader.fromBuffer(bytes);
    assert.ok(r.shardCount >= 2, "expected a multi-shard container, got " + r.shardCount);

    const rowStride = r.strideBytes();
    const readers = new Array(r.shardCount);
    for (let s = 0; s < r.shardCount; s++) {
        readers[s] = LiteBinaryReader.fromLBK1Shard({ bytes: r.shardPayload(s), rowStride: rowStride, fields: r.schema.fields });
    }
    const union = new ShardUnion(readers);
    assert.equal(union.totalRows, r.totalRows, "union total rows");

    // Field ids are identical across shards (shared schema); resolve once.
    const valId = readers[0].field("val");
    const tagId = readers[0].field("tag");

    let checked = 0;
    for (let g = 0; g < union.totalRows; g++) {
        const loc = union.locate(g);
        // The union lands in the same shard bake-stream would pick.
        assert.ok(loc.s >= 0 && loc.localRow >= 0 && loc.localRow < readers[loc.s].count, "row " + g + ": bad locate");

        // F64: direct union read matches bake-stream cell-for-cell.
        assert.ok(Object.is(union.get(g, valId), r.get(g, "val")), "row " + g + ": F64 union diverged");

        // U32: the union returns the raw index; resolve via the OWNING shard's
        // string table to match bake-stream's resolved string.
        const index = union.get(g, tagId);
        assert.equal(r.shardStringTable(loc.s).get(index), r.get(g, "tag"), "row " + g + ": U32 union index does not resolve");
        checked++;
    }
    assert.equal(checked, r.totalRows, "did not check every row");
});
