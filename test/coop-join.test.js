/**
 * Recipe-5 backing -- the flagship multi-instance cooperation pattern (node:test).
 *
 * A query-builder result is two tables: a PARENT (orders) and its CHILDREN (line
 * items) keyed back to the parent. Each table is baked SEPARATELY by lite-bake
 * (different schemas), opened through its OWN LiteBinaryReader via fromBaked, and
 * joined parent -> children BY KEY in CALLER code. The join is deliberately NOT a
 * shipped API: N readers over N schemas, unioned by a caller-owned key map, is a
 * recipe -- join semantics are the caller's, not the reader's. This test is what
 * Cookbook.md recipe 5 cites.
 *
 * Each reader stays zero-alloc in its own loop (resolve field() once, index by
 * id). The parent->children index is a cold, caller-side Map built once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { bake, Reader as BakeReader, Types } from "@zakkster/lite-bake";
import LiteBinaryReader from "../Reader.js";

test("recipe 5: two separately-baked tables joined parent->children by key", () => {
    // Parent table: one row per order.
    const parents = [
        { orderId: 10, totalCents: 500 },
        { orderId: 20, totalCents: 1200 },
        { orderId: 30, totalCents: 75 },
    ];
    // Child table: one row per line item, keyed to a parent by parentId.
    const children = [
        { parentId: 10, sku: 1001, qty: 2 },
        { parentId: 10, sku: 1002, qty: 1 },
        { parentId: 20, sku: 2001, qty: 5 },
        { parentId: 30, sku: 3001, qty: 3 },
        { parentId: 30, sku: 3002, qty: 4 },
        { parentId: 30, sku: 3003, qty: 1 },
    ];

    // Bake each table on its OWN schema, then open one reader per table.
    const bakedP = bake(parents, { schema: { orderId: Types.U32, totalCents: Types.U32 } });
    const bakedC = bake(children, { schema: { parentId: Types.U32, sku: Types.U32, qty: Types.U16 } });
    const pr = LiteBinaryReader.fromBaked(bakedP);
    const cr = LiteBinaryReader.fromBaked(bakedC);
    // lite-bake's own readers are the oracle for cell-exactness.
    const oraP = new BakeReader(bakedP);
    const oraC = new BakeReader(bakedC);

    assert.equal(pr.count, 3, "parent count");
    assert.equal(cr.count, 6, "child count");

    // Resolve field ids ONCE outside every loop (the zero-alloc discipline).
    const P_ORDER = pr.field("orderId");
    const P_TOTAL = pr.field("totalCents");
    const C_PARENT = cr.field("parentId");
    const C_SKU = cr.field("sku");
    const C_QTY = cr.field("qty");

    // Caller-side join: index child rows by their parent key, once.
    const byParent = new Map();
    for (let c = 0; c < cr.count; c++) {
        const key = cr.get(c, C_PARENT);
        let bucket = byParent.get(key);
        if (!bucket) { bucket = []; byParent.set(key, bucket); }
        bucket.push(c);
    }

    // Walk parents, gather each one's children, assert the joined shape and that
    // every cell -- on BOTH sides of the join -- reads cell-exact vs lite-bake.
    const expectedCounts = { 10: 2, 20: 1, 30: 3 };
    let joinedRows = 0;
    for (let p = 0; p < pr.count; p++) {
        const orderId = pr.get(p, P_ORDER);
        assert.equal(orderId, oraP.get(p, "orderId"), "parent orderId cell-exact");
        assert.equal(pr.get(p, P_TOTAL), oraP.get(p, "totalCents"), "parent total cell-exact");

        const kids = byParent.get(orderId) || [];
        assert.equal(kids.length, expectedCounts[orderId], "order " + orderId + " child count");

        for (const c of kids) {
            // The child's foreign key really points back at this parent.
            assert.equal(cr.get(c, C_PARENT), orderId, "child parentId matches join key");
            // Child payload cells read cell-exact through OUR reader vs the oracle.
            assert.equal(cr.get(c, C_SKU), oraC.get(c, "sku"), "child sku cell-exact");
            assert.equal(cr.get(c, C_QTY), oraC.get(c, "qty"), "child qty cell-exact");
            joinedRows++;
        }
    }

    // Non-vacuity: every child row was reached through the join (no orphans in
    // this fixture), so the join covered the whole child table.
    assert.equal(joinedRows, cr.count, "every child joined to a parent");
});
