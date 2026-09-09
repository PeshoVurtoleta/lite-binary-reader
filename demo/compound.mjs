// @zakkster/lite-binary-reader -- compound (ecosystem) demo.
//
//   node demo/compound.mjs
//
// The real query-builder scenario, end to end:
//   1. @zakkster/lite-bake       bakes a PARENT table and a CHILDREN table to flat
//                                binary (two separate schemas).
//   2. lite-binary-reader        opens ONE reader per table via fromBaked and JOINS
//                                parent -> children by key in caller code (zero-GC).
//   3. @zakkster/lite-query      streams the child rows reactively through a
//                                streamQuery whose stream: generator decodes them
//                                with the reader -- abort-clean, 0 B/op per frame.
//
// lite-bake + lite-query are TEST/DEMO devDependencies (file:) -- the reader itself
// imports no sibling. Repo-only demo; not shipped in the npm tarball. Deterministic:
// no timers, no network.

import { bake, Types } from "@zakkster/lite-bake";
import { queryClient } from "@zakkster/lite-query";
import { streamQuery } from "@zakkster/lite-query/stream";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { LiteBinaryReader } from "../Reader.js";

const line = (s) => process.stdout.write(s + "\n");

// ---------------------------------------------------------------------------
// 1. lite-bake: bake a parent (orders) and children (line items) separately.
// ---------------------------------------------------------------------------
line("== 1. lite-bake: two tables baked to flat binary ==");

const orders = [
    { orderId: 10, totalCents: 4599 },
    { orderId: 20, totalCents: 1200 },
    { orderId: 30, totalCents: 8850 },
];
const lineItems = [
    { parentId: 10, sku: 1001, qty: 2 },
    { parentId: 10, sku: 1002, qty: 1 },
    { parentId: 20, sku: 2001, qty: 5 },
    { parentId: 30, sku: 3001, qty: 1 },
    { parentId: 30, sku: 3002, qty: 3 },
    { parentId: 30, sku: 3003, qty: 1 },
];

const bakedOrders = bake(orders, { schema: { orderId: Types.U32, totalCents: Types.U32 } });
const bakedItems = bake(lineItems, { schema: { parentId: Types.U32, sku: Types.U32, qty: Types.U16 } });
line(`  orders  -> ${bakedOrders.count} rows, stride ${bakedOrders.stride}B`);
line(`  items   -> ${bakedItems.count} rows, stride ${bakedItems.stride}B (lite-bake sorted+padded the layout)`);

// ---------------------------------------------------------------------------
// 2. lite-binary-reader: one reader per table, join by key in caller code.
// ---------------------------------------------------------------------------
line("");
line("== 2. lite-binary-reader: fromBaked + caller-side join ==");

const pr = LiteBinaryReader.fromBaked(bakedOrders);
const cr = LiteBinaryReader.fromBaked(bakedItems);

const P_ORDER = pr.field("orderId");
const P_TOTAL = pr.field("totalCents");
const C_PARENT = cr.field("parentId");
const C_SKU = cr.field("sku");
const C_QTY = cr.field("qty");

// Index children by parent key ONCE (a cold, caller-side map). The reads are zero-GC.
const byParent = new Map();
for (let c = 0; c < cr.count; c++) {
    const key = cr.get(c, C_PARENT);
    let bucket = byParent.get(key);
    if (!bucket) { bucket = []; byParent.set(key, bucket); }
    bucket.push(c);
}

for (let p = 0; p < pr.count; p++) {
    const orderId = pr.get(p, P_ORDER);
    const total = pr.get(p, P_TOTAL);
    const items = (byParent.get(orderId) || []).map((c) => `sku ${cr.get(c, C_SKU)} x${cr.get(c, C_QTY)}`);
    line(`  order ${orderId} ($${(total / 100).toFixed(2)}): ${items.join(", ")}`);
}

// ---------------------------------------------------------------------------
// 3. lite-query: stream the child rows reactively through the reader.
// ---------------------------------------------------------------------------
line("");
line("== 3. lite-query: a streamQuery decoding rows through the reader ==");

// Observe with the SAME lite-signal instance lite-query resolves (a real deduped
// consumer has one copy; this file: dev layout has two, so bind to lite-query's).
const requireFromQuery = createRequire(await import.meta.resolve("@zakkster/lite-query"));
const { effect } = await import(pathToFileURL(requireFromQuery.resolve("@zakkster/lite-signal")).href);
const tick = () => new Promise((r) => setTimeout(r, 0));

const qc = queryClient({});
const feed = streamQuery(qc, {
    key: ["line-items"],
    mode: "latest",
    stream: async function* ({ signal }) {
        // Yield one primitive per frame (sku), decoded from the reader -- zero-alloc.
        for (let c = 0; c < cr.count; c++) {
            if (signal.aborted) return;
            yield cr.get(c, C_SKU);
        }
    },
});

const streamed = [];
const stop = effect(() => { const v = feed.data(); if (v !== undefined) streamed.push(v); });
for (let i = 0; i < 20 && feed.status() !== "success"; i++) await tick();
stop();
feed.dispose();

line(`  streamed skus: ${streamed.join(", ")}`);
line(`  (bake -> read -> reactive stream, end to end; the reader never imports a sibling)`);
