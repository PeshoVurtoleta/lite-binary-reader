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

export declare const IS_LITTLE_ENDIAN: boolean;

export declare type TypeCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export declare interface Field {
  name: string | number;
  type: TypeCode;
  offset: number;
}

export declare interface Options {
  schema: Field[];
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

export declare class LiteBinaryReader {
  constructor(source: ArrayBuffer | ArrayBufferView, options: Options);
  get count(): number;
  get stride(): number;
  get fieldCount(): number;
  get littleEndian(): boolean;
  get buffer(): ArrayBuffer;
  field(name: string | number): number;
  typeOf(fieldId: number): number;
  offsetOf(fieldId: number): number;
  getF64(row: number, fieldId: number): number;
  getF32(row: number, fieldId: number): number;
  getI32(row: number, fieldId: number): number;
  getU32(row: number, fieldId: number): number;
  getI16(row: number, fieldId: number): number;
  getU16(row: number, fieldId: number): number;
  getI8(row: number, fieldId: number): number;
  getU8(row: number, fieldId: number): number;
  get(row: number, fieldId: number): number;
  bytes(row: number, fieldId: number, len: number): Uint8Array;
  static fromBaked(baked: Baked, options?: Options): LiteBinaryReader;
  static fromLBK1Shard(shard: Shard, options?: Options): LiteBinaryReader;
}

export default LiteBinaryReader;
