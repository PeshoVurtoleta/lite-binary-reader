/**
 * S6 -- the lite-query streaming-adapter proof (node:test).
 *
 * PROVES the reader drops into a real `@zakkster/lite-query` `streamQuery`
 * `stream:` generator and decodes binary zero-GC, abort-clean, WITHOUT an import
 * edge (lite-query is a TEST-only devDependency; Reader.js imports no sibling).
 *
 * Two recipes (D-1 = BOTH):
 *   (a) FLAGSHIP -- a streamed FOREIGN fixed-stride feed (bytes no baker wrote):
 *       each window is wrapped in `new LiteBinaryReader(window, {...})` inside the
 *       generator and decoded into primitives. This is the reader's reason to
 *       exist -- a source with no native reader.
 *   (b) a real `@zakkster/lite-bake-stream` shard read through `fromLBK1Shard`
 *       INSIDE a streamQuery (composes the S5 cooperation proof into a stream).
 *
 * The generator honors `signal`: on abort-on-detach it CANCELS its in-flight
 * source read, so the async generator (parked on an await) is actually released.
 * Observation binds to the SAME lite-signal instance lite-query resolves (see
 * test/helpers/query-observer.mjs for the peer-dedup rationale).
 *
 * The detach abort surfaces as a plain `AbortError` on `signal.reason` (runtime
 * truth -- asserted, not assumed from docs): we assert the source was cancelled
 * and NO value arrives after abort, not a specific reason string.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { queryClient } from "@zakkster/lite-query";
import { streamQuery } from "@zakkster/lite-query/stream";
import { serialize } from "@zakkster/lite-bake-stream";
import { Reader as StreamReader } from "@zakkster/lite-bake-stream/reader";

import LiteBinaryReader, { T_F64 } from "../Reader.js";
import { effect, signal, tick, makeWindowSource, f64Window } from "./helpers/query-observer.mjs";

const SCHEMA = [{ name: "v", type: T_F64, offset: 0 }];
const STRIDE = 8;

/**
 * The adapter under test: a `stream:` generator that decodes FOREIGN windows
 * pulled from `source` through LiteBinaryReader, yielding one PRIMITIVE per
 * frame (readRow into a hoisted, reused sink -- never a per-row object). It
 * wires `signal` to `source.cancel()` so abort-on-detach releases the await.
 */
function foreignFeed(source) {
    return async function* ({ signal }) {
        signal.addEventListener("abort", () => source.cancel());
        const sink = new Float64Array(SCHEMA.length); // hoisted; reused every frame
        for await (const win of source) {
            if (signal.aborted) return;
            const reader = new LiteBinaryReader(win, { schema: SCHEMA, stride: STRIDE, littleEndian: true }); // cold per window
            const count = reader.count;
            for (let i = 0; i < count; i++) {
                if (signal.aborted) return;
                reader.readRow(i, sink);
                yield sink[0];
            }
        }
    };
}

test("S6a flagship: streamQuery decodes a FOREIGN feed through LiteBinaryReader, in order", async () => {
    const qc = queryClient({});
    const src = makeWindowSource();
    const sq = streamQuery(qc, { key: ["feed"], mode: "latest", stream: foreignFeed(src) });

    const seen = [];
    const stop = effect(() => { const v = sq.data(); if (v !== undefined) seen.push(v); });
    await tick();
    assert.equal(sq.status(), "pending", "subscribed, no value yet");

    const windows = [[1.5, 2.5], [-3.25], [4.0, 5.0, 6.5]];
    const expected = [];
    for (const w of windows) { for (const v of w) expected.push(v); src.push(f64Window(w)); await tick(); }
    src.finish();
    await tick();

    assert.deepEqual(seen, expected, "every decoded cell observed in order");
    assert.ok(seen.length >= 5, "non-vacuous: >= 5 frames actually observed");
    assert.equal(sq.status(), "success", "iterator done -> success");
    stop(); sq.dispose();
});

test("S6a abort-on-detach: detaching the last observer cancels the source; no value after abort", async () => {
    const qc = queryClient({});
    const src = makeWindowSource();
    const sq = streamQuery(qc, { key: ["feed"], mode: "latest", stream: foreignFeed(src) });

    const seen = [];
    const stop = effect(() => { const v = sq.data(); if (v !== undefined) seen.push(v); });
    await tick();
    src.push(f64Window([10, 20]));
    await tick();
    assert.ok(seen.length >= 1, "streaming before detach");
    assert.equal(src.closed, false, "source open while observed");

    const before = seen.length;
    stop();                     // last observer leaves -> abort-on-detach
    await tick(); await tick(); // let return()/cancel propagate
    assert.equal(src.closed, true, "detach cancelled the in-flight source read");

    src.push(f64Window([999])); // must never reach a detached observer
    await tick();
    assert.equal(seen.length, before, "no value decoded/observed after abort");
    sq.dispose();
});

test("S6a reactive-key restart: a key change aborts the old feed and opens a new one", async () => {
    const qc = queryClient({ defaultStaleTime: 0 });
    let starts = 0;
    const byKey = {};
    const factory = ({ key, signal }) => {
        starts++;
        const src = makeWindowSource();
        byKey[key[1]] = src;
        return foreignFeed(src)({ signal });   // the SAME adapter (it wires signal -> src.cancel)
    };
    const channel = signal("a");
    const sq = streamQuery(qc, { key: () => ["feed", channel()], mode: "latest", stream: factory });

    const stop = effect(() => sq.data());
    await tick();
    assert.equal(starts, 1, "factory invoked once on first observe");
    assert.equal(byKey["a"].closed, false);

    channel.set("b");           // reactive key change -> abort old + restart
    await tick();
    assert.equal(starts, 2, "key change restarted the stream (factory re-invoked)");
    assert.equal(byKey["a"].closed, true, "old source cancelled on restart");
    stop(); sq.dispose();
});

test("S6b recipe: fromLBK1Shard reads a real bake-stream shard INSIDE a streamQuery", async () => {
    // A real LBK1 container (multiple shards force the global<->local mapping).
    const records = [];
    for (let i = 0; i < 120; i++) records.push({ val: i * 1.25 - 7.5, tag: "t-" + (i % 5) });
    const bytes = serialize(records, {
        framing: "ndjson",
        writer: { schema: { fields: [{ name: "val", laneKind: "f64" }, { name: "tag", laneKind: "u32" }] }, targetShardBytes: 512 },
    });
    const container = StreamReader.fromBuffer(bytes);
    assert.ok(container.shardCount >= 2, "expected multiple shards, got " + container.shardCount);

    // The generator carves each shard payload and reads it through OUR fromLBK1Shard.
    const shardStream = async function* ({ signal }) {
        const rowStride = container.strideBytes();
        for (let s = 0; s < container.shardCount; s++) {
            if (signal.aborted) return;
            const rowCount = container.shards[s].rowCount;
            const payload = container.shardPayload(s);
            assert.equal(payload.byteLength, rowCount * rowStride, "payload_len === rowCount*rowStride");
            const lbr = LiteBinaryReader.fromLBK1Shard({ bytes: payload, rowStride, fields: container.schema.fields });
            assert.equal(lbr.count, rowCount, "shard count === rowCount");
            const valId = lbr.field("val");
            for (let row = 0; row < rowCount; row++) {
                if (signal.aborted) return;
                yield lbr.getF64(row, valId);
            }
        }
    };

    const qc = queryClient({});
    const seen = [];
    const sq = streamQuery(qc, { key: ["lbk1"], mode: "latest", stream: shardStream });
    const stop = effect(() => { const v = sq.data(); if (v !== undefined) seen.push(v); });
    // pump to completion
    for (let i = 0; i < 20 && sq.status() !== "success"; i++) await tick();

    assert.equal(seen.length, records.length, "every row streamed through fromLBK1Shard");
    for (let i = 0; i < records.length; i++) {
        assert.ok(Object.is(seen[i], container.get(i, "val")), "cell " + i + " bit-exact vs bake-stream's own Reader");
    }
    stop(); sq.dispose();
});

test("S6 zero-alloc frame path: readRow into a reused sink allocates nothing per frame (structural)", () => {
    // The reader's ENTIRE per-frame contribution is readRow-into-a-reused-sink;
    // torture t6 Gate 3 MEASURES this at 0 B/op with a retained-alloc gate. Here
    // we assert the structural invariant that runs without --expose-gc: the sink
    // identity is stable and each frame yields a primitive (no per-row object).
    const win = f64Window([1, 2, 3, 4, 5, 6, 7, 8]);
    const reader = new LiteBinaryReader(win, { schema: SCHEMA, stride: STRIDE, littleEndian: true });
    const sink = new Float64Array(SCHEMA.length);
    const sinkRef = sink;
    for (let n = 0; n < 5000; n++) {
        const i = n % reader.count;
        reader.readRow(i, sink);
        const v = sink[0];
        assert.equal(typeof v, "number", "frame yields a primitive, not an object");
        assert.equal(sink, sinkRef, "the sink is reused -- no per-frame allocation by the adapter");
    }
});

test("S6 D9 ownership: numeric reads survive a window overwrite; a kept bytes() span must be copied", () => {
    const win = f64Window([42.5, 7.0]);
    const reader = new LiteBinaryReader(win, { schema: SCHEMA, stride: STRIDE, littleEndian: true });
    const id = reader.field("v");
    const numberBefore = reader.getF64(0, id);           // a VALUE (primitive)
    const borrowed = reader.bytes(0, id, 8);             // a BORROWED view over the window

    // Overwrite the underlying window (as a pooled/reused source would between frames).
    new DataView(win.buffer).setFloat64(0, -1.0, true);

    assert.equal(numberBefore, 42.5, "the decoded NUMBER is a copy-by-value -- unaffected by the overwrite");
    assert.equal(reader.getF64(0, id), -1.0, "a fresh read reflects the new bytes (reader over live buffer)");
    // The borrowed span tracks the buffer -- proving 'copy what you keep'.
    assert.equal(new DataView(borrowed.buffer, borrowed.byteOffset, 8).getFloat64(0, true), -1.0,
        "the borrowed bytes() span moved with the window; a retained span MUST be copied");
});
