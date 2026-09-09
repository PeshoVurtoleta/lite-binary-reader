/**
 * @zakkster/lite-binary-reader -- cooperation-proof mock fixtures (test-scoped).
 *
 * Named, flat record sets fed through the REAL lite-bake path (coop-bake.test.js)
 * and, for the F64/U32 subset, the REAL lite-bake-stream path. This module holds
 * DATA ONLY: it makes no assertions -- every check lives in the coop-*.test.js
 * suites that consume it. Each set is a `{ records, overrides }` pair, where
 * `overrides` is the `schema` argument to `bake(records, { schema })` (a
 * field-name -> `Types.X` map that pins the lane so coverage is exact, since
 * lite-bake otherwise infers the SMALLEST lane that fits).
 *
 * Boundary note (nestedFlattened). lite-bake is FLAT/fixed-stride and strict
 * since 1.1.0 -- it refuses nested objects, absent keys, extra keys, and
 * non-numbers. A "nested" source is therefore flattened to dotted keys by the
 * `flatten` helper HERE, before bake() ever sees it: the proof is that
 * fromBaked reads whatever FLAT layout the baker emitted, NOT that the reader
 * understands nesting (it does not -- flattening is the baker-input author's job).
 *
 * NaN / +/-Infinity / -0 ride ONLY on Types.F64 lanes. -0 is integer-valued and
 * would infer U8 (losing its sign bit) through an int lane, so it must be pinned
 * to a float lane explicitly (RULING D).
 */

import { Types } from '@zakkster/lite-bake';

/**
 * Flatten a nested object/array to a single-level record with dotted keys, e.g.
 * `{ pos: { x: 1, y: 2 }, tags: [7, 9] }` -> `{ 'pos.x': 1, 'pos.y': 2,
 * 'tags.0': 7, 'tags.1': 9 }`. Cold test helper: allocation here is free.
 */
export function flatten(obj, prefix, out) {
    out = out || {};
    prefix = prefix || "";
    for (const key of Object.keys(obj)) {
        const v = obj[key];
        const path = prefix ? prefix + "." + key : key;
        if (v !== null && typeof v === "object") {
            flatten(v, path, out);
        } else {
            out[path] = v;
        }
    }
    return out;
}

/** flatSingleLane: one field, one lane. The baseline single-column proof. */
function flatSingleLane() {
    return {
        records: [{ hp: 100 }, { hp: 250 }, { hp: 65535 }, { hp: 0 }],
        overrides: { hp: Types.U16 },
    };
}

/**
 * flatAllEightLanes: every one of the 8 lanes exercised at once, each field
 * pinned by an explicit Types override to an in-range EXACT value. Int lanes get
 * exact integers inside their inclusive range; float lanes get finite values
 * (the F32 ones are fround-exact, though the read path would round identically
 * on both sides regardless).
 */
function flatAllEightLanes() {
    return {
        records: [
            { f32: 1.5, f64: 1.1, i32: -2000000000, i16: -30000, i8: -100, u32: 4000000000, u16: 60000, u8: 200 },
            { f32: -3.75, f64: -2.2, i32: 123456, i16: 12345, i8: 42, u32: 123456, u16: 12345, u8: 42 },
            { f32: 2.25, f64: 3.3, i32: -1, i16: -1, i8: -1, u32: 7, u16: 3, u8: 7 },
        ],
        overrides: {
            f32: Types.F32, f64: Types.F64, i32: Types.I32, i16: Types.I16,
            i8: Types.I8, u32: Types.U32, u16: Types.U16, u8: Types.U8,
        },
    };
}

/**
 * nestedFlattened: a NESTED source (`source`) flattened to dotted-key flat
 * records BEFORE bake sees it. `records` is the flat form; `source` is kept for
 * the test to document the boundary. All fields pinned to lanes.
 */
function nestedFlattened() {
    const source = [
        { pos: { x: 3, y: 4 }, stats: { hp: 100, mp: 20 }, tags: [7, 9] },
        { pos: { x: -5, y: 12 }, stats: { hp: 250, mp: 40 }, tags: [1, 2] },
    ];
    const records = source.map((r) => flatten(r));
    return {
        source: source,
        records: records,
        overrides: {
            "pos.x": Types.I16, "pos.y": Types.I16,
            "stats.hp": Types.U16, "stats.mp": Types.U8,
            "tags.0": Types.U8, "tags.1": Types.U8,
        },
    };
}

/**
 * nonFinite: NaN / +Infinity / -Infinity / -0 on Types.F64 lanes ONLY. The proof
 * is that these bit patterns survive fromBaked cell-exact (asserted with
 * Object.is, since NaN === NaN is false and -0 === 0 is true).
 */
function nonFinite() {
    return {
        records: [
            { a: NaN, b: Infinity, c: -Infinity, d: -0 },
            { a: 1.5, b: NaN, c: 0, d: -Infinity },
            { a: -0, b: -2.5, c: Infinity, d: NaN },
        ],
        overrides: { a: Types.F64, b: Types.F64, c: Types.F64, d: Types.F64 },
    };
}

/**
 * realSample: a small NON-synthetic sample -- three rows of a sensor/telemetry
 * dump -- baked with pinned lanes and read back cell-exact.
 */
function realSample() {
    return {
        records: [
            { deviceId: 4012, celsius: 21.5, humidity: 43, battery: 98 },
            { deviceId: 4013, celsius: -7.25, humidity: 88, battery: 61 },
            { deviceId: 4014, celsius: 36.0, humidity: 12, battery: 100 },
        ],
        overrides: { deviceId: Types.U32, celsius: Types.F32, humidity: Types.U8, battery: Types.U8 },
    };
}

/** Every named fixture, ready for the bake cooperation path. */
export function makeFixtures() {
    return {
        flatSingleLane: flatSingleLane(),
        flatAllEightLanes: flatAllEightLanes(),
        nestedFlattened: nestedFlattened(),
        nonFinite: nonFinite(),
        realSample: realSample(),
    };
}
