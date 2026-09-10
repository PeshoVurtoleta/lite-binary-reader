/**
 * @zakkster/lite-binary-reader -- ambient type surface.
 *
 * Hand-written to mirror EXACTLY the runtime exports of Reader.js. It carries no
 * version literal; the three-place version sync (package.json / Reader.js VERSION
 * / llms.txt) is enforced elsewhere, and test/dts-drift.test.js keeps this file's
 * error-code union and export set in lock-step with Reader.js. ASCII-only.
 *
 * @license MIT
 */

export declare const VERSION: string;

export declare const T_F32: 0;
export declare const T_F64: 1;
export declare const T_I32: 2;
export declare const T_I16: 3;
export declare const T_I8: 4;
export declare const T_U32: 5;
export declare const T_U16: 6;
export declare const T_U8: 7;
export declare const T_I64: 8;
export declare const T_U64: 9;

export declare const IS_LITTLE_ENDIAN: boolean;

export declare type TypeCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;

export declare interface Field {
  name: string | number;
  type: TypeCode;
  offset: number;
  lengthField?: string | number;
  /**
   * S10: this field's byte order. Absent inherits the reader's `littleEndian`
   * (so any pre-S10 schema is unchanged). A field whose endianness differs from
   * the host declines a `laneOf()` lane (served by the DataView getX path).
   */
  littleEndian?: boolean;
}

/**
 * S11: type-level record inference (types only -- the runtime is byte-identical).
 * A `const`-typed schema (`[...] as const`) lets the reader infer per-field names
 * and read types; a plain `Field[]` schema keeps the pre-S11 `number | bigint`
 * unions, so every existing call site compiles unchanged (backward-compatible).
 *
 *   TypeOf<C>   -- a type code -> its read type: primitive codes 0..7 -> number,
 *                  the 64-bit codes 8|9 -> bigint (mirrors the runtime lanes).
 *   NameOf<S>   -- the union of the schema's field names; a name outside it is a
 *                  COMPILE error at `field(name)` (the runtime still throws
 *                  R_UNKNOWN_FIELD -- the type just catches the typo earlier).
 *   RowTuple<S> -- the `readRow` sink/return as a tuple keyed by field order,
 *                  each slot typed number|bigint per that field's code.
 *   RowSink     -- the permissive caller-owned sink (Array or TypedArray) the
 *                  legacy `readRow` overload accepts.
 */
export declare type TypeOf<C extends TypeCode> = C extends 8 | 9 ? bigint : number;
export declare type NameOf<S extends readonly Field[]> = S[number]["name"];
export declare type RowSink = { length: number;[index: number]: number | bigint };
export declare type RowTuple<S extends readonly Field[]> = {
  -readonly [K in keyof S]: S[K]["type"] extends 8 | 9 ? bigint : number;
};

export declare interface Options<S extends readonly Field[] = readonly Field[]> {
  schema: S;
  stride?: number;
  count?: number;
  littleEndian?: boolean;
  byteOffset?: number;
}

export declare interface Baked {
  buffer: ArrayBuffer;
  stride: number;
  count: number;
  schema: Field[];
}

export declare interface Shard {
  bytes: ArrayBuffer;
  rowStride: number;
  fields: { name: string | number; laneKind: number; offsetInRow: number }[];
}

export declare interface Lane {
  view:
    | Float32Array
    | Float64Array
    | Int32Array
    | Int16Array
    | Int8Array
    | Uint32Array
    | Uint16Array
    | Uint8Array
    | BigInt64Array
    | BigUint64Array;
  elemStride: number;
  elemOffset: number;
}

export declare type ReaderErrorCode =
  | "R_BAD_SCHEMA"
  | "R_BAD_TYPE"
  | "R_BAD_OFFSET"
  | "R_BAD_COUNT"
  | "R_BAD_STRIDE"
  | "R_BAD_SOURCE"
  | "R_DUPLICATE_FIELD"
  | "R_UNKNOWN_FIELD"
  | "R_BAD_LENGTH"
  | "R_BUFFER_TOO_SMALL";

export declare class LiteBinaryReaderError extends Error {
  readonly code: ReaderErrorCode;
}

export declare class LiteBinaryReader<S extends readonly Field[] = readonly Field[]> {
  constructor(source: ArrayBuffer | ArrayBufferView, options: Options<S>);
  get count(): number;
  get stride(): number;
  get fieldCount(): number;
  get littleEndian(): boolean;
  get buffer(): ArrayBuffer;
  field(name: NameOf<S>): number;
  typeOf(fieldId: number): number;
  offsetOf(fieldId: number): number;
  laneOf(fieldId: number): Lane | null;
  getF64(row: number, fieldId: number): number;
  getF32(row: number, fieldId: number): number;
  getI32(row: number, fieldId: number): number;
  getU32(row: number, fieldId: number): number;
  getI16(row: number, fieldId: number): number;
  getU16(row: number, fieldId: number): number;
  getI8(row: number, fieldId: number): number;
  getU8(row: number, fieldId: number): number;
  getI64(row: number, fieldId: number): bigint;
  getU64(row: number, fieldId: number): bigint;
  get(row: number, fieldId: number): number | bigint;
  seek(row: number): this;
  f64(fieldId: number): number;
  f32(fieldId: number): number;
  i32(fieldId: number): number;
  u32(fieldId: number): number;
  i16(fieldId: number): number;
  u16(fieldId: number): number;
  i8(fieldId: number): number;
  u8(fieldId: number): number;
  i64(fieldId: number): bigint;
  u64(fieldId: number): bigint;
  val(fieldId: number): number | bigint;
  readRow(row: number, out: RowTuple<S>): RowTuple<S>;
  readRow<T extends RowSink>(row: number, out: T): T;
  bytes(row: number, fieldId: number): Uint8Array;
  bytes(row: number, fieldId: number, len: number): Uint8Array;
  static fromBaked(baked: Baked, options?: Options): LiteBinaryReader;
  static fromLBK1Shard(shard: Shard, options?: Options): LiteBinaryReader;
}

export default LiteBinaryReader;
