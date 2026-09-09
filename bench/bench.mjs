// @zakkster/lite-binary-reader -- reproducible benchmark across the four value
// axes the module exists to serve:
//
//   1. FAST         -- ns/row vs a hand-written plain-DataView loop (the honest
//                      floor everyone builds on) and vs comparable read peers.
//   2. ZERO-GC      -- transient + retained bytes per decode pass. The reader's
//                      read surfaces allocate nothing; the object-materializing
//                      peers allocate one record object per row by design. This
//                      is the axis a plain parser cannot match.
//   3. TINY         -- shipped bytes + runtime dependency count, side by side.
//   4. SAVES TRAFFIC-- fixed-stride binary vs JSON on the wire for N records,
//                      and the decode cost of each. HONEST framing: the bakers
//                      PRODUCE the bytes; this reader is what makes CONSUMING
//                      them zero-copy / zero-GC.
//
// Run: node --expose-gc bench/bench.mjs
// Replay a fixture: BENCH_SEED=<n> node --expose-gc bench/bench.mjs
//
// FAIRNESS DISCIPLINE (the honest part):
//  - The plain-DataView loop is always apples-to-apples: same bytes, same reads.
//  - The cross-library slice uses a TIGHTLY-PACKED, little-endian, aligned record
//    -- the ONE layout every contender supports natively. The reader's unaligned
//    offsets, big-endian source, and laneOf typed-array path are things the peers
//    cannot do at all; they are demonstrated in demo/ and NOT smuggled into the
//    fair speed comparison. Every contender is verified to decode the identical
//    values (an exact checksum vs a DataView oracle) BEFORE its timings count --
//    a number measured against wrong or unequal work is not a comparison.
//  - The peers (binary-parser, typed-struct, restructure) parse into JS objects.
//    That allocation is INHERENT to their model, not a defect; the transient/op
//    column reports the cost of that model on a read-only primitive workload, and
//    the text says so. Peers that decode a DIFFERENT thing (write-only encoders,
//    framework-coupled readers) are excluded, as is any that will not install.
//  - Timings are ADVISORY (wall-clock is noisy); the zero-GC bytes/op columns are
//    the load-bearing, deterministic headline.

import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import {
  LiteBinaryReader,
  T_F32, T_I32, T_U16, T_U8,
  IS_LITTLE_ENDIAN,
} from "../Reader.js";

// --- --expose-gc guard (the byte columns are meaningless without it) --------
if (typeof globalThis.gc !== "function") {
  console.error("This benchmark needs --expose-gc for the memory columns.");
  console.error("  node --expose-gc bench/bench.mjs");
  process.exit(1);
}
function gc() { globalThis.gc(); }
function mem() { return process.memoryUsage().heapUsed; }

// --- seeded fixture (reproducible) ------------------------------------------
const SEED = (Number(process.env.BENCH_SEED) || 0x9e3779b1) >>> 0 || 1;
function makePRNG(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

// --- formatting -------------------------------------------------------------
function fmtOps(n) { return Math.round(n).toLocaleString("en-US").padStart(12); }
function fmtNs(n) { return (n).toFixed(2).padStart(8) + " ns"; }
function fmtBytes(n) {
  if (!isFinite(n)) return "--";
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(2) + " MB";
  if (a >= 1e3) return (n / 1e3).toFixed(2) + " KB";
  return n.toFixed(0) + " B";
}
function pad(s, w) { return String(s).padEnd(w); }

// --- measure: PASSES decode passes over N rows, gc-bracketed ----------------
// fn() runs ONE pass over all N rows and returns a checksum (forces the reads,
// defeats dead-code elimination). All scratch is allocated OUTSIDE fn.
const WARMUP_RATIO = 0.1;
function measure(label, passes, rowsPerPass, fn) {
  const warm = Math.max(1, Math.floor(passes * WARMUP_RATIO));
  let acc = 0;
  for (let i = 0; i < warm; i++) acc += fn();
  const checksum = fn(); // one clean representative pass (deterministic reads)
  acc += checksum;
  gc();
  const memStart = mem();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < passes; i++) acc += fn();
  const t1 = process.hrtime.bigint();
  const transient = mem() - memStart;
  gc();
  const retained = mem() - memStart;
  const ms = Number(t1 - t0) / 1e6;
  const passesPerSec = (passes * 1000) / ms;
  const nsPerRow = (ms * 1e6) / (passes * rowsPerPass);
  return {
    label, passes, rowsPerPass, ms, passesPerSec, nsPerRow,
    transientPerPass: transient / passes,
    retainedPerPass: retained / passes,
    transientPerRow: transient / (passes * rowsPerPass),
    checksum, _acc: acc,
  };
}

function row(r) {
  console.log(
    " ", pad(r.label, 34),
    fmtOps(r.passesPerSec), " passes/s ",
    fmtNs(r.nsPerRow), "/row ",
    fmtBytes(r.transientPerRow).padStart(10), "/row transient",
  );
}

// ============================================================================
// FIXTURE FAIR -- tightly-packed, little-endian, the cross-library common ground
//   record: f32 @0, i32 @4, u16 @8, u8 @10   -> stride 11 (no padding)
// ============================================================================
const N = 20_000;
const F_STRIDE = 11;
const fairBuf = new ArrayBuffer(N * F_STRIDE);
const fairDV = new DataView(fairBuf);
{
  const rnd = makePRNG(SEED);
  for (let i = 0; i < N; i++) {
    const b = i * F_STRIDE;
    fairDV.setFloat32(b + 0, (rnd() * 2000 - 1000), true);
    fairDV.setInt32(b + 4, (rnd() * 4e9 - 2e9) | 0, true);
    fairDV.setUint16(b + 8, (rnd() * 65536) & 0xffff, true);
    fairDV.setUint8(b + 10, (rnd() * 256) & 0xff);
  }
}
const fairBytes = Buffer.from(fairBuf); // a Buffer VIEW over the same bytes, for the peers

// Oracle checksum: sum of the integer fields + truncated f32, in row order.
// Integer-exact (no float-equality hazard) yet forces all four field reads.
function oracleChecksum() {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const b = i * F_STRIDE;
    const a = fairDV.getFloat32(b + 0, true);
    const bb = fairDV.getInt32(b + 4, true);
    const c = fairDV.getUint16(b + 8, true);
    const d = fairDV.getUint8(b + 10);
    sum += (a | 0) + bb + c + d;
  }
  return sum;
}
const ORACLE = oracleChecksum();

// ============================================================================
// GROUP 1 -- our read surfaces vs the plain-DataView baseline (always fair)
// ============================================================================
const reader = new LiteBinaryReader(fairBuf, {
  schema: [
    { name: "a", type: T_F32, offset: 0 },
    { name: "b", type: T_I32, offset: 4 },
    { name: "c", type: T_U16, offset: 8 },
    { name: "d", type: T_U8, offset: 10 },
  ],
  stride: F_STRIDE, littleEndian: true,
});
const IA = reader.field("a"), IB = reader.field("b"), IC = reader.field("c"), ID = reader.field("d");
const sink = new Float64Array(4); // reused readRow sink

function baselineDataView() {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const b = i * F_STRIDE;
    sum += (fairDV.getFloat32(b + 0, true) | 0) + fairDV.getInt32(b + 4, true) +
           fairDV.getUint16(b + 8, true) + fairDV.getUint8(b + 10);
  }
  return sum;
}
function oursGetX() {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    sum += (reader.getF32(i, IA) | 0) + reader.getI32(i, IB) + reader.getU16(i, IC) + reader.getU8(i, ID);
  }
  return sum;
}
function oursCursor() {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    reader.seek(i);
    sum += (reader.f32(IA) | 0) + reader.i32(IB) + reader.u16(IC) + reader.u8(ID);
  }
  return sum;
}
function oursReadRow() {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    reader.readRow(i, sink);
    sum += (sink[0] | 0) + sink[1] + sink[2] + sink[3];
  }
  return sum;
}
function oursGet() {
  let sum = 0;
  for (let i = 0; i < N; i++) {
    sum += (reader.get(i, IA) | 0) + reader.get(i, IB) + reader.get(i, IC) + reader.get(i, ID);
  }
  return sum;
}

// ============================================================================
// FIXTURE LANE -- host-endian, aligned single-f32 column for the laneOf path
//   stride 4, N rows, littleEndian === host  -> laneOf is eligible
// ============================================================================
const laneBuf = new ArrayBuffer(N * 4);
const laneDV = new DataView(laneBuf);
{
  const rnd = makePRNG(SEED ^ 0x55555555);
  for (let i = 0; i < N; i++) laneDV.setFloat32(i * 4, rnd() * 2000 - 1000, IS_LITTLE_ENDIAN);
}
const laneReader = new LiteBinaryReader(laneBuf, {
  schema: [{ name: "v", type: T_F32, offset: 0 }],
  stride: 4, littleEndian: IS_LITTLE_ENDIAN,
});
const LV = laneReader.field("v");
const lane = laneReader.laneOf(LV);
assert.ok(lane !== null, "lane fixture must be laneOf-eligible on a host-endian reader");
function laneBaselineDV() { // the honest floor for the lane path
  let sum = 0;
  for (let i = 0; i < N; i++) sum += laneDV.getFloat32(i * 4, IS_LITTLE_ENDIAN);
  return sum;
}
function laneRead() {
  const view = lane.view, es = lane.elemStride, eo = lane.elemOffset;
  let sum = 0;
  for (let i = 0; i < N; i++) sum += view[i * es + eo];
  return sum;
}
function laneGetX() { // getF32 over the same column, for the laneOf-vs-getX delta
  let sum = 0;
  for (let i = 0; i < N; i++) sum += laneReader.getF32(i, LV);
  return sum;
}
const LANE_ORACLE = laneBaselineDV();

// ============================================================================
// GROUP 2 -- cross-library fair slice (object-materializing peers)
//   Each decodes the FAIR fixture into records and reads the same four fields.
// ============================================================================
const peers = [];
async function tryPeer(name, build) {
  try {
    const fn = await build();
    // correctness gate BEFORE timing: must equal the oracle
    const got = fn();
    if (got !== ORACLE) { peers.push({ name, skip: `checksum ${got} != oracle ${ORACLE}` }); return; }
    peers.push({ name, fn });
  } catch (e) {
    peers.push({ name, skip: e.message });
  }
}

await tryPeer("binary-parser", async () => {
  const { Parser } = await import("binary-parser");
  const rec = new Parser().floatle("a").int32le("b").uint16le("c").uint8("d");
  const arr = new Parser().array("rows", { type: rec, length: N });
  return () => {
    const out = arr.parse(fairBytes);
    const rows = out.rows;
    let sum = 0;
    for (let i = 0; i < N; i++) { const r = rows[i]; sum += (r.a | 0) + r.b + r.c + r.d; }
    return sum;
  };
});

await tryPeer("typed-struct", async () => {
  const mod = await import("typed-struct");
  const Struct = mod.Struct;
  const S = new Struct("Rec").Float32LE("a").Int32LE("b").UInt16LE("c").UInt8("d").compile();
  return () => {
    let sum = 0;
    for (let i = 0; i < N; i++) {
      const inst = new S(fairBytes.subarray(i * F_STRIDE, i * F_STRIDE + F_STRIDE));
      sum += (inst.a | 0) + inst.b + inst.c + inst.d;
    }
    return sum;
  };
});

await tryPeer("restructure", async () => {
  const r = await import("restructure");
  const S = new r.Struct({ a: r.floatle, b: r.int32le, c: r.uint16le, d: r.uint8 });
  const Arr = new r.Array(S, N); // idiomatic BULK decode (fairer than per-record fromBuffer)
  const u8 = new Uint8Array(fairBuf);
  return () => {
    const rows = Arr.fromBuffer(u8);
    let sum = 0;
    for (let i = 0; i < N; i++) { const dec = rows[i]; sum += (dec.a | 0) + dec.b + dec.c + dec.d; }
    return sum;
  };
});

// ============================================================================
// GROUP 3 -- the V8 split-class experiment (decision gate, decisions/0008)
//   Does passing a LITERAL endianness to DataView.getX beat passing the
//   dynamic per-reader `_le` variable on the fallback (non-lane) path? If a
//   real, repeatable win -> a split LE/BE getter class is worth building before
//   the 1.0.0 freeze. If within noise (the modern-V8 expectation) -> close it.
// ============================================================================
const splitDV = laneDV; // aligned f32 column, host-endian
let DYN_LE = IS_LITTLE_ENDIAN; // a live variable, exactly like reader._le
function getterDynamic() {
  let sum = 0;
  for (let i = 0; i < N; i++) sum += splitDV.getFloat32(i * 4, DYN_LE);
  return sum;
}
function getterLiteralLE() {
  let sum = 0;
  for (let i = 0; i < N; i++) sum += splitDV.getFloat32(i * 4, true);
  return sum;
}

// ============================================================================
// AXIS 3 -- TINY (shipped size + runtime dep count)
// ============================================================================
function dirSize(dir) {
  // Sum every file under dir (the honest on-disk install footprint).
  let total = 0;
  try {
    for (const rel of readdirSync(dir, { recursive: true })) {
      try {
        const st = statSync(new URL(dir.href + "/" + rel));
        if (st.isFile()) total += st.size;
      } catch { /* skip */ }
    }
  } catch { /* dir missing */ }
  return total;
}
function tinyTable() {
  const readerSrc = readFileSync(new URL("../Reader.js", import.meta.url));
  const ourGz = gzipSync(readerSrc).length;
  const rows = [[
    "@zakkster/lite-binary-reader",
    (readerSrc.length / 1024).toFixed(1) + " KB",   // shipped code (1 file)
    (ourGz / 1024).toFixed(1) + " KB",              // gz
    "0",                                            // runtime deps
  ]];
  for (const name of ["binary-parser", "typed-struct", "restructure"]) {
    try {
      // Read package.json by its node_modules path -- some peers hide it behind `exports`.
      const pkgPath = new URL(`../node_modules/${name}/package.json`, import.meta.url);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      const deps = pkg.dependencies ? Object.keys(pkg.dependencies).length : 0;
      const footprint = dirSize(new URL(`../node_modules/${name}`, import.meta.url));
      rows.push([
        name + "@" + pkg.version,
        (footprint / 1024).toFixed(0) + " KB",       // whole installed package
        "(install)",
        String(deps),
      ]);
    } catch (e) {
      rows.push([name, "(" + e.message + ")", "--", "--"]);
    }
  }
  return rows;
}

// ============================================================================
// AXIS 4 -- SAVES TRAFFIC (fixed-stride binary vs JSON, + decode cost)
// ============================================================================
function trafficReport() {
  // Build the equivalent JSON payload for the FAIR fixture's N records.
  const objs = new Array(N);
  for (let i = 0; i < N; i++) {
    const b = i * F_STRIDE;
    objs[i] = {
      a: fairDV.getFloat32(b + 0, true),
      b: fairDV.getInt32(b + 4, true),
      c: fairDV.getUint16(b + 8, true),
      d: fairDV.getUint8(b + 10),
    };
  }
  const json = JSON.stringify(objs);
  const jsonBytes = Buffer.byteLength(json);
  const binBytes = N * F_STRIDE;

  // decode cost: JSON.parse + read fields vs the reader's getX pass.
  const jsonDecode = measure("JSON.parse + read", 100, N, () => {
    const arr = JSON.parse(json);
    let sum = 0;
    for (let i = 0; i < N; i++) { const r = arr[i]; sum += (r.a | 0) + r.b + r.c + r.d; }
    return sum;
  });
  const binDecode = measure("binary getX + read", 100, N, oursGetX);

  return { jsonBytes, binBytes, jsonDecode, binDecode };
}

// ============================================================================
// RUN
// ============================================================================
console.log("");
console.log("@zakkster/lite-binary-reader -- benchmark");
console.log("node " + process.version + " | seed 0x" + SEED.toString(16) + " | " + N.toLocaleString() + " records/pass | host " + (IS_LITTLE_ENDIAN ? "LE" : "BE"));
console.log("=".repeat(96));

console.log("\n[1] READ SURFACES vs plain-DataView baseline (tight LE pack, all fair)");
const PASSES1 = 400;
const g1 = [
  measure("DataView baseline (the floor)", PASSES1, N, baselineDataView),
  measure("reader.getX (random access)", PASSES1, N, oursGetX),
  measure("reader.seek + cursor", PASSES1, N, oursCursor),
  measure("reader.readRow (reused sink)", PASSES1, N, oursReadRow),
  measure("reader.get (data-driven)", PASSES1, N, oursGet),
];
for (const r of g1) { assert.equal(r.checksum, ORACLE, `${r.label} checksum`); row(r); }

console.log("\n[2] laneOf typed-array hot path (aligned host-endian f32 column)");
const g1b = [
  measure("DataView baseline (f32 col)", PASSES1, N, laneBaselineDV),
  measure("reader.getF32 (same col)", PASSES1, N, laneGetX),
  measure("reader.laneOf view read", PASSES1, N, laneRead),
];
for (const r of g1b) { assert.equal(r.checksum, LANE_ORACLE, `${r.label} lane checksum`); row(r); }

console.log("\n[3] vs comparable read peers (same tight LE record, decode N + read 4 fields)");
console.log("    peers parse into JS objects by design; the transient/op column is the cost of that model.");
const PASSES2 = 120;
const oursFair = measure("reader.getX (0-alloc)", PASSES2, N, oursGetX);
row(oursFair);
const peerResults = [];
for (const p of peers) {
  if (p.skip) { console.log("  " + pad(p.name, 34) + " SKIPPED: " + p.skip); continue; }
  const r = measure(p.name, PASSES2, N, p.fn);
  peerResults.push(r);
  row(r);
}

console.log("\n[4] SPLIT-CLASS EXPERIMENT -- dynamic _le vs literal endianness (decision gate)");
const PASSES3 = 600;
const dyn = measure("getFloat32(pos, _le)  dynamic", PASSES3, N, getterDynamic);
const lit = measure("getFloat32(pos, true) literal", PASSES3, N, getterLiteralLE);
assert.equal(dyn.checksum, LANE_ORACLE, "dynamic getter checksum");
assert.equal(lit.checksum, LANE_ORACLE, "literal getter checksum");
row(dyn); row(lit);
const splitDelta = (lit.passesPerSec / dyn.passesPerSec - 1) * 100;
console.log("    literal is " + splitDelta.toFixed(1) + "% " + (splitDelta > 0 ? "faster" : "slower") + " than dynamic _le on this run.");

console.log("\n[TINY] footprint + runtime dependencies");
console.log("  ours = one shipped file (+ gz); peers = whole installed package on disk");
console.log("  " + pad("package", 34) + pad("size", 12) + pad("gz", 12) + "runtime deps");
for (const t of tinyTable()) console.log("  " + pad(t[0], 34) + pad(t[1], 12) + pad(t[2], 12) + t[3]);

console.log("\n[TRAFFIC] fixed-stride binary vs JSON on the wire (" + N.toLocaleString() + " records)");
const tr = trafficReport();
console.log("  binary payload:  " + fmtBytes(tr.binBytes) + "  (" + F_STRIDE + " B/record, fixed stride)");
console.log("  JSON payload:    " + fmtBytes(tr.jsonBytes) + "  (" + (tr.jsonBytes / tr.binBytes).toFixed(1) + "x larger)");
console.log("  binary gz:       " + fmtBytes(gzipSync(fairBytes).length) + "   JSON gz: " + fmtBytes(gzipSync(Buffer.from(JSON.stringify(
  (() => { const o = new Array(N); for (let i = 0; i < N; i++) { const b = i * F_STRIDE; o[i] = { a: fairDV.getFloat32(b, true), b: fairDV.getInt32(b + 4, true), c: fairDV.getUint16(b + 8, true), d: fairDV.getUint8(b + 10) }; } return o; })()
))).length));
console.log("  decode " + N.toLocaleString() + " records:");
console.log("    JSON.parse + read: " + tr.jsonDecode.nsPerRow.toFixed(1) + " ns/record, " + fmtBytes(tr.jsonDecode.transientPerRow) + "/record transient");
console.log("    binary getX + read:" + tr.binDecode.nsPerRow.toFixed(1) + " ns/record, " + fmtBytes(tr.binDecode.transientPerRow) + "/record transient");

// --- machine-readable footer (for the README updater / CI) ------------------
const summary = {
  node: process.version,
  seed: SEED,
  N,
  surfaces: Object.fromEntries(g1.concat(g1b).map((r) => [r.label, { nsPerRow: +r.nsPerRow.toFixed(3), transientPerRow: Math.round(r.transientPerRow) }])),
  peers: peerResults.map((r) => ({ name: r.label, nsPerRow: +r.nsPerRow.toFixed(3), transientPerRow: Math.round(r.transientPerRow), xFaster: +(r.nsPerRow / oursFair.nsPerRow).toFixed(2) })),
  splitClass: { dynamicPassesPerSec: Math.round(dyn.passesPerSec), literalPassesPerSec: Math.round(lit.passesPerSec), literalPctFaster: +splitDelta.toFixed(1) },
  traffic: { binBytes: tr.binBytes, jsonBytes: tr.jsonBytes, jsonXLarger: +(tr.jsonBytes / tr.binBytes).toFixed(1), jsonNsPerRecord: +tr.jsonDecode.nsPerRow.toFixed(1), binNsPerRecord: +tr.binDecode.nsPerRow.toFixed(1) },
};
console.log("\n" + "=".repeat(96));
console.log("SUMMARY_JSON " + JSON.stringify(summary));
console.log("");
