/**
 * S11 -- type-level record inference gate (compiled by `tsc --noEmit`, never run).
 *
 * This file is the TEETH for the generic Reader.d.ts surface: it asserts the
 * inference is PRESENT and correct AND that the legacy (plain `Field[]`) path is
 * unchanged. It has teeth two ways -- an `@ts-expect-error` that FAILS the build
 * if the expected compile error stops happening (tsc flags an unused directive),
 * and exact `Equal<>` checks that fail if a mapped type drifts. It ships nothing:
 * test-only, excluded from `files[]`. ASCII-only.
 */
import LiteBinaryReader, {
  T_F32,
  T_U32,
  T_U64,
} from "../../Reader.js";
import type { TypeOf, NameOf, RowTuple, Field } from "../../Reader.js";

// A type-equality check with teeth (identity holds only for exact-equal types).
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
declare function expectTrue<_T extends true>(): void;

declare const buf: ArrayBuffer;

// ---- TypeOf: code -> read type ---------------------------------------------
expectTrue<Equal<TypeOf<0>, number>>();
expectTrue<Equal<TypeOf<7>, number>>();
expectTrue<Equal<TypeOf<8>, bigint>>();
expectTrue<Equal<TypeOf<9>, bigint>>();

// ---- inference from a `const` schema ---------------------------------------
const schema = [
  { name: "px", type: T_F32, offset: 0 },
  { name: "id", type: T_U64, offset: 8 },
] as const;

const r = new LiteBinaryReader(buf, { schema });

// NameOf: the field-name union is inferred; field() is name-safe.
expectTrue<Equal<NameOf<typeof schema>, "px" | "id">>();
r.field("px");
r.field("id");
// @ts-expect-error -- a name not in the schema is a COMPILE error (teeth: if the
// generic surface regressed to `string | number`, this directive goes unused and
// tsc fails the build).
r.field("nope");

// RowTuple: the readRow sink/return is a schema-derived tuple (F32 -> number,
// U64 -> bigint), NOT the bare `number | bigint` union.
expectTrue<Equal<RowTuple<typeof schema>, [number, bigint]>>();
const sink: RowTuple<typeof schema> = [0, 0n];
const rowOut = r.readRow(0, sink);
expectTrue<Equal<typeof rowOut, [number, bigint]>>();

// ---- legacy path: a plain `Field[]` schema keeps the pre-S11 behavior -------
const loose: Field[] = [{ name: "a", type: T_U32, offset: 0 }];
const rl = new LiteBinaryReader(buf, { schema: loose });

// field() still accepts string|number (no narrowing) -- backward-compatible.
rl.field("a");
rl.field(0);
rl.field("anything-compiles");

// readRow's permissive overload returns the caller's own sink type, unchanged.
const fa = new Float64Array(1);
const faOut = rl.readRow(0, fa);
expectTrue<Equal<typeof faOut, typeof fa>>();

const arr: (number | bigint)[] = [];
const arrOut = rl.readRow(0, arr);
expectTrue<Equal<typeof arrOut, (number | bigint)[]>>();
