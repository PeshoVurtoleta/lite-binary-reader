/**
 * @zakkster/lite-binary-reader -- Zero-dependency, zero-GC reader for RAW,
 * foreign, or sibling-baked binary buffers.
 *
 * The gap it fills (D1). Two sibling packages produce binary:
 *   - lite-bake       -> an in-memory { buffer, stride, count, schema },
 *                        8-lane type system, NATIVE endianness, no self-
 *                        describing bytes.
 *   - lite-bake-stream-> a self-describing LBK1 container (its own magic),
 *                        F64 + U32(string-index) lanes only.
 * NEITHER reads arbitrary/foreign bytes against a caller-supplied layout: a
 * wire protocol, a mmap'd C struct, WASM linear memory, an SoA column dump,
 * or a record with fields at ODD (unaligned) byte offsets. That is this
 * module's one job. It reads through a `DataView` -- so a field may sit at
 * ANY byte offset (a typed-array lane cannot; it throws on a misaligned view,
 * see Learning/TypedArrays.md) -- and endianness is EXPLICIT, so it can read a
 * buffer whose byte order differs from the host, which lite-bake refuses.
 *
 * The model (D2). A record is `stride` bytes; record `i` starts at
 * `base + i*stride`; each field has a byte `offset` within the record and a
 * `type` code. A read is one `DataView.getX(base + row*stride + off, le)` --
 * no allocation, no parsing, no object materialized. Field access is by
 * integer id (resolve a name -> id ONCE with `field(name)`, then index in the
 * hot loop), the same `get(index, field)` shape the ecosystem uses.
 *
 * Type codes (D3). Codes 0-7 are IDENTICAL to lite-bake's `Types` table, so a
 * lite-bake `schema` drops in unchanged. S9 (v1.1.0) appends two 64-bit integer
 * lanes -- T_I64=8, T_U64=9 -- read as `BigInt`. LBK1's `lane_kind` is a DIFFERENT
 * table that collides by value (only F64==1 is shared); `fromLBK1Shard` TRANSLATES
 * it, so a single ambiguous integer never crosses the boundary.
 *
 * The 64-bit exception (S9). A JS BigInt is a heap value BY SPEC, so a 64-bit read
 * ALWAYS allocates: BOTH `dv.getBigInt64()` AND `BigInt64Array[i]` mint a BigInt
 * (~533 KB/1e6 reads, measured). i64/u64 is therefore an inherently-ALLOCATING read
 * surface -- the SECOND documented exception alongside `bytes()`. The zero-GC
 * guarantee stays UNQUALIFIED on the 8 primitive-number lanes (codes 0-7) ONLY;
 * getI64/getU64, the cursor i64/u64, get/val/readRow on a 64-bit field, and a
 * 64-bit laneOf view are opt-in and explicitly outside it. Every JS reader that
 * returns 64-bit integers allocates BigInts -- a language reality, not a design miss.
 *
 * Row cursor (D4). For a sequential scan a caller may `seek(row)` ONCE and then
 * read fields without re-passing the row: `r.seek(i).f64(id)`, `r.val(id)`. This
 * makes the cursor API STATEFUL (`_cursor` moves on each `seek`); the row-passing
 * getX/get form stays STATELESS and is the recommended shape for random access.
 * Both APIs read the SAME bytes with the SAME address arithmetic. `readRow(row,
 * out)` fills a caller-owned length>=fieldCount sink (Array or TypedArray) by
 * field id -- the SoA->AoS bridge, no record object materialized.
 *
 * Variable-length (D4). A field may carry `lengthField`, the NAME of a sibling
 * field whose integer value at the same row is this field's byte run length.
 * Resolved to an id ONCE at construction; `bytes(row, id)` (2-arg) then reads
 * that length and returns the borrowed span. It reuses the existing coded
 * `bytes()` door -- R_BAD_LENGTH / R_BUFFER_TOO_SMALL -- and an unknown
 * lengthField NAME is an R_UNKNOWN_FIELD at construction: NO new type code, NO
 * new R_* code. The R_* list below stays at exactly 10.
 *
 * Laws honored (suite CLAUDE.md):
 *   - Zero allocation on the read hot path (getX / get). All validation and
 *     any allocation happen at the construction DOOR or on the throw path.
 *   - Fail closed: an incoherent schema/buffer throws a coded error at the
 *     door; null is not zero; a too-small buffer is refused, not read past.
 *   - ASCII-only source. Single main file. Zero runtime deps.
 *
 * Read codes (R_*), defined once, prefixed by role (the suite convention):
 *   R_BAD_SOURCE      source is not an ArrayBuffer or a typed-array view, or its
 *                     backing ArrayBuffer has been detached (transferred away)
 *   R_BAD_SCHEMA      schema is not a non-empty array of field descriptors
 *   R_BAD_TYPE        a field.type is not an integer in 0..9
 *   R_BAD_OFFSET      a field.offset (or byteOffset) is not a coherent non-negative
 *                     integer, or byteOffset falls past the end of the buffer
 *   R_BAD_STRIDE      stride is not a positive integer, or < the largest field end
 *   R_BAD_COUNT       count is not a non-negative integer
 *   R_BAD_LENGTH      bytes() len is not a non-negative integer
 *   R_DUPLICATE_FIELD two schema fields share a name (a silent shadow is refused)
 *   R_BUFFER_TOO_SMALL declared count*stride (+base) exceeds the buffer, or a
 *                     bytes() span reads past the buffer
 *   R_UNKNOWN_FIELD   field(name) was asked for a name not in the schema
 */

export const VERSION = "1.3.0";

// --- type codes -- byte-for-byte lite-bake's `Types` table (D3) --------------
export const T_F32 = 0;
export const T_F64 = 1;
export const T_I32 = 2;
export const T_I16 = 3;
export const T_I8 = 4;
export const T_U32 = 5;
export const T_U16 = 6;
export const T_U8 = 7;
// --- 64-bit integer lanes (S9, v1.1.0). i64/u64 are read as BigInt, which is a
// heap value BY SPEC: BOTH dv.getBigInt64() AND BigInt64Array[i] allocate
// (~533 KB/1e6 reads, measured). So codes 8/9 are an inherently-ALLOCATING read
// surface -- the SECOND documented exception alongside bytes(). The unqualified
// zero-GC guarantee stays on the 8 primitive lanes (codes 0-7) ONLY.
export const T_I64 = 8;
export const T_U64 = 9;
const TYPE_COUNT = 10;
/** Width in bytes per type code, indexed by the code itself. */
const TYPE_BYTES = [4, 8, 4, 2, 1, 4, 2, 1, 8, 8];
/** TypedArray constructor per type code, indexed by the code itself. Used ONLY
 *  by the cold typed-lane pass (laneOf) to build at most one host-order view per
 *  present eligible type; never touched on any read hot path. The 64-bit ctors
 *  (BigInt64Array/BigUint64Array) yield a lane whose element read allocates a
 *  BigInt -- an allocating lane, distinct from the 8 that are zero-alloc. */
const TYPE_CTOR = [Float32Array, Float64Array, Int32Array, Int16Array, Int8Array, Uint32Array, Uint16Array, Uint8Array, BigInt64Array, BigUint64Array];

/** LBK1 `lane_kind` -> our type code (D3). LBK1: 1=F64, 2=F32, 3=U32, 4=U8.
 *  NOTE: an LBK1 U32 cell is a STRING-TABLE INDEX; read raw it is that index
 *  (a number). Resolving it to the interned string is lite-bake-stream's job. */
const LANEKIND_TO_TYPE = { 1: T_F64, 2: T_F32, 3: T_U32, 4: T_U8 };

/** Host byte order, detected once. Used only to read a NATIVE-endian buffer
 *  (e.g. one produced by lite-bake) correctly via `fromBaked`. */
export const IS_LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Does this engine expose the `ArrayBuffer.prototype.detached` getter? It is
 *  Node 21+ / modern browsers only, so on the node>=18 floor this is FALSE and
 *  the guarded-DataView fallback in isDetached is the real detection path. */
const HAS_DETACHED = typeof Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "detached") === "object";

/** True iff `buffer`'s backing store has been detached (transferred away). A
 *  detached buffer reports byteLength 0 yet is still `instanceof ArrayBuffer`,
 *  so it slips past coercion and blows up later at `new DataView`. A LEGITIMATE
 *  zero-length buffer (`new ArrayBuffer(0)`) is NOT detached and must return
 *  false. Any nonzero length is trivially live; only length 0 is ambiguous, so
 *  the expensive probe stays off the common path.
 *  - Node 21+ : consult the standard `detached` getter.
 *  - node>=18 : construct a DataView and treat a throw as detached (a live
 *    zero-length buffer constructs fine; a detached one throws). */
function isDetached(buffer) {
    if (buffer.byteLength > 0) return false;
    if (HAS_DETACHED) return buffer.detached === true;
    try { new DataView(buffer); return false; } catch (e) { return true; }
}

/** Coded, greppable error -- one class, `.code` carries the R_* tag. */
export class LiteBinaryReaderError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "LiteBinaryReaderError";
        this.code = code;
    }
}
const fail = (code, msg) => { throw new LiteBinaryReaderError(code, "[lite-binary-reader] " + msg); };

export class LiteBinaryReader {
    /**
     * @param {ArrayBuffer|ArrayBufferView} source  the raw bytes.
     * @param {{
     *   schema: Array<{name:string, type:number, offset:number, lengthField?:string|number, littleEndian?:boolean}>,
     *   stride?: number,          // bytes per record; derived from schema if omitted
     *   count?: number,           // record count; derived from buffer size if omitted
     *   littleEndian?: boolean,   // reader byte order (default true); a field's own
     *                             // littleEndian (S10) overrides it for that field
     *   byteOffset?: number       // where the record region starts inside the buffer
     * }} options
     * A per-field `littleEndian` (S10) lets one reader read mixed-endian records; a
     * field without it inherits the reader flag, so any pre-S10 schema is unchanged.
     * A field whose endianness != host declines a laneOf() lane (served by getX).
     */
    constructor(source, options) {
        const opts = options || fail("R_BAD_SCHEMA", "options with a schema are required");

        // --- coerce the source to an owned buffer (the sibling rule) ----------
        // ArrayBuffer -> used as-is (zero-copy). A FULL-SPAN zero-offset typed
        // view unwraps to its buffer zero-copy. ANY other view -- a pooled/offset
        // view (nonzero byteOffset) OR a zero-offset PARTIAL view (byteLength <
        // buffer.byteLength, e.g. `new Uint8Array(buf,0,8)`/`arr.subarray(0,8)`)
        // -- is COPIED to its own window so the reader can never derive or accept
        // a count over bytes the view does not own (BR-07). The resolved buffer is
        // therefore always exactly the bytes the caller owns. Matches lite-bake's
        // Reader.fromBytes / Views.js coercion exactly.
        let buffer;
        if (source instanceof ArrayBuffer) {
            buffer = source;
        } else if (ArrayBuffer.isView(source)) {
            // BR-09: a DataView's byteOffset/byteLength getters THROW a raw
            // TypeError when the backing buffer is detached (TypedArray getters
            // return 0 instead). So probe the UNDERLYING buffer -- a plain
            // ArrayBuffer whose length/detached getters never throw -- for
            // detachment BEFORE reading any of the view's own getters. This
            // catches a detached DataView AND a detached TypedArray at the same
            // coded door, ahead of any throwing getter or `new DataView`.
            if (isDetached(source.buffer)) fail("R_BAD_SOURCE", "source view is over a detached ArrayBuffer");
            if (source.byteOffset === 0 && source.byteLength === source.buffer.byteLength) {
                buffer = source.buffer;              // full-span: zero-copy unwrap
            } else {
                const win = new Uint8Array(source.byteLength);       // partial OR offset: copy to own window
                win.set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
                buffer = win.buffer;
            }
        } else {
            fail("R_BAD_SOURCE", "source must be an ArrayBuffer or a typed-array view");
        }

        // BR-08: a detached (transferred) buffer is still `instanceof ArrayBuffer`
        // and a view over one resolves to `buffer = source.buffer` above -- both
        // reach here with a dead backing store that would throw a raw TypeError at
        // `new DataView`. Refuse with a coded R_BAD_SOURCE first (a legitimately
        // zero-length buffer is NOT detached and passes).
        if (isDetached(buffer)) fail("R_BAD_SOURCE", "source ArrayBuffer is detached");

        // --- validate + compact the schema into SoA tables (cold path) --------
        const fields = opts.schema;
        if (!Array.isArray(fields) || fields.length === 0) {
            fail("R_BAD_SCHEMA", "schema must be a non-empty array of {name,type,offset}");
        }
        const n = fields.length;
        const off = new Int32Array(n);   // byte offset of each field within a record
        const type = new Uint8Array(n);  // type code (0..9) of each field
        const leOf = new Uint8Array(n);  // S10: per-field endianness (1=LE, 0=BE)
        const name = new Map();          // name -> field id (setup-time resolution only)
        let maxEnd = 0;                  // largest (offset + width) -> the minimum stride
        // S10: the reader-level endianness (host-order default), computed here so a
        // field WITHOUT its own `littleEndian` inherits it. Same BR-03 discipline as
        // byteOffset: an explicit `=== undefined` check, never `|| / ??`, so a
        // legitimate `false` (a big-endian field) is never swallowed as "omitted".
        const readerLE = opts.littleEndian === undefined ? true : !!opts.littleEndian;
        for (let i = 0; i < n; i++) {
            const f = fields[i];
            if (!f || typeof f !== "object") fail("R_BAD_SCHEMA", "field " + i + " is not an object");
            const t = f.type;
            if (!(Number.isInteger(t) && t >= 0 && t < TYPE_COUNT)) fail("R_BAD_TYPE", "field '" + f.name + "' has type " + t + " (expected an integer 0..9)");
            const o = f.offset;
            if (!Number.isInteger(o) || o < 0) fail("R_BAD_OFFSET", "field '" + f.name + "' has a bad offset " + o);
            if (name.has(f.name)) fail("R_DUPLICATE_FIELD", "duplicate field name '" + f.name + "'");
            // S10: optional per-field endianness. Boolean-or-absent only (reuse
            // R_BAD_SCHEMA, no new code); absent inherits the reader flag.
            const fe = f.littleEndian;
            if (fe !== undefined && typeof fe !== "boolean") fail("R_BAD_SCHEMA", "field '" + f.name + "' littleEndian must be a boolean, got " + fe);
            off[i] = o;
            type[i] = t;
            leOf[i] = (fe === undefined ? readerLE : fe) ? 1 : 0;
            name.set(f.name, i);
            const end = o + TYPE_BYTES[t];
            if (end > maxEnd) maxEnd = end;
        }

        // --- variable-length wiring (D4, cold): resolve each field's optional --
        // `lengthField` sibling NAME to its id ONCE, so the 2-arg bytes() reads
        // the run length with no name lookup on the (cold) call. -1 = "no
        // lengthField" (the common case). The name map is complete above, so a
        // forward or backward sibling reference both resolve. An unknown name is
        // R_UNKNOWN_FIELD and a self-reference is R_BAD_SCHEMA -- NO new R_* code.
        const lenOf = new Int32Array(n).fill(-1);
        for (let i = 0; i < n; i++) {
            const lf = fields[i].lengthField;
            if (lf === undefined) continue;
            const lid = name.get(lf);
            if (lid === undefined) fail("R_UNKNOWN_FIELD", "field '" + fields[i].name + "' lengthField '" + String(lf) + "' is not a field name");
            if (lid === i) fail("R_BAD_SCHEMA", "field '" + fields[i].name + "' lengthField refers to itself");
            lenOf[i] = lid;
        }

        // --- stride: given, or the tightly-packed minimum ---------------------
        let stride = opts.stride;
        if (stride === undefined) {
            stride = maxEnd;
        } else if (!Number.isInteger(stride) || stride <= 0) {
            fail("R_BAD_STRIDE", "stride must be a positive integer, got " + stride);
        } else if (stride < maxEnd) {
            fail("R_BAD_STRIDE", "stride " + stride + " is smaller than the largest field end " + maxEnd);
        }

        // --- base + count: the records must physically fit --------------------
        // BR-03: an explicit `=== undefined` check, NOT `|| 0`, so NaN/false and
        // other falsy-but-not-omitted offsets reach the Number.isInteger guard.
        const base = opts.byteOffset === undefined ? 0 : opts.byteOffset;
        if (!Number.isInteger(base) || base < 0) fail("R_BAD_OFFSET", "byteOffset must be a non-negative integer, got " + base);
        // BR-01: reject a base past the end of the RESOLVED buffer (post-D7-copy)
        // BEFORE deriving count, so a derived count can never go negative.
        if (base > buffer.byteLength) fail("R_BAD_OFFSET", "byteOffset " + base + " exceeds buffer length " + buffer.byteLength);
        const avail = buffer.byteLength - base;
        let count = opts.count;
        if (count === undefined) {
            count = stride > 0 ? Math.floor(avail / stride) : 0;
        } else if (!Number.isInteger(count) || count < 0) {
            fail("R_BAD_COUNT", "count must be a non-negative integer, got " + count);
        }
        // BR-01 belt-and-braces: the derived count can no longer be negative.
        if (count < 0) fail("R_BAD_COUNT", "derived count is negative: " + count);
        if (count * stride > avail) {
            fail("R_BUFFER_TOO_SMALL", "need " + (count * stride) + " bytes from offset " + base + ", have " + avail);
        }

        // --- freeze the shape: every field set here, in fixed order, so all ---
        // --- readers share ONE hidden class (Learning/V8.md PART 2) -----------
        this._dv = new DataView(buffer);
        this._buffer = buffer;
        this._off = off;
        this._type = type;
        this._leOf = leOf;   // S10: per-field endianness table (read on the hot path)
        this._name = name;
        this._fieldCount = n;
        this._stride = stride;
        this._count = count;
        this._base = base;
        this._le = readerLE;  // reader-level default (introspection; the per-field
                              // fallback already folded into _leOf at the door)
        this._cursor = 0;    // D4 row cursor: moved only by seek(); a Smi by contract
        this._lenOf = lenOf; // per-field lengthField id, or -1 (variable-length wiring)

        // --- typed-lane fast path (T3, COLD): a per-field lane descriptor for --
        // every lane-ELIGIBLE field, precomputed once here so laneOf(id) is a
        // pure lookup (zero work, zero alloc on the call -- all allocation at the
        // door). A field is eligible iff THAT FIELD reads HOST byte order AND both
        // the field's first byte and the stride are naturally aligned to the type
        // width: `_leOf[i] === IS_LITTLE_ENDIAN && (_base + off) % width === 0 &&
        // _stride % width === 0` -- so EVERY row's cell (not just row 0) stays
        // aligned for a raw typed-array read. S10: the host-endian test is PER FIELD,
        // so a big-endian field in an otherwise host-endian reader declines to null
        // while its host-endian siblings still get a lane. At most ONE view per
        // PRESENT eligible type is built over `buffer` and shared by all its fields.
        // Each descriptor is Object.freeze'd ONCE here, never per call. An
        // ineligible field (wrong endianness, unaligned field, unaligned stride)
        // gets `null` and is served by getX exactly as before: eligibility is an
        // OPTIMIZATION probe, never a gate on reads. NO new R_* code -- declining
        // is a normal answer, not an error.
        const lanes = new Array(n).fill(null);
        {
            const views = [null, null, null, null, null, null, null, null, null, null];
            for (let i = 0; i < n; i++) {
                if (leOf[i] !== (IS_LITTLE_ENDIAN ? 1 : 0)) continue; // S10: per-field host-endian gate
                const t = this._type[i];
                const width = TYPE_BYTES[t];
                const first = this._base + this._off[i];
                if (first % width !== 0 || this._stride % width !== 0) continue;
                let view = views[t];
                if (view === null) {
                    // Construct over the buffer from byte 0 with an EXPLICIT floored
                    // element count: `new TYPE_CTOR(buffer)` alone throws unless the
                    // WHOLE byteLength divides the element width, but a field can be
                    // cell-aligned on a buffer whose tail is a partial element. The
                    // door guarantees base+count*stride <= byteLength, and off+width
                    // <= stride, so every eligible cell's last byte is < the floored
                    // length -- no row is ever out of view.
                    view = new TYPE_CTOR[t](buffer, 0, Math.floor(buffer.byteLength / width));
                    views[t] = view;
                }
                lanes[i] = Object.freeze({
                    view: view,
                    elemStride: this._stride / width,
                    elemOffset: first / width,
                });
            }
        }
        this._lanes = lanes; // per-field frozen Lane { view, elemStride, elemOffset } or null
    }

    // --- introspection (cold) -------------------------------------------------
    get count() { return this._count; }
    get stride() { return this._stride; }
    get fieldCount() { return this._fieldCount; }
    get littleEndian() { return this._le; }
    get buffer() { return this._buffer; }

    /** Resolve a field NAME to its integer id. Do this ONCE, outside the loop;
     *  index by the id inside it. Throws R_UNKNOWN_FIELD for an unknown name. */
    field(name) {
        const id = this._name.get(name);
        if (id === undefined) fail("R_UNKNOWN_FIELD", "no field named '" + String(name) + "'");
        return id;
    }

    /** Type code of a field id. */
    typeOf(fieldId) { return this._type[fieldId]; }
    /** Byte offset (within a record) of a field id. */
    offsetOf(fieldId) { return this._off[fieldId]; }

    /**
     * The native typed-lane fast path (T3). For a lane-ELIGIBLE field returns its
     * precomputed frozen `{ view, elemStride, elemOffset }` (a `Lane`); for an
     * ineligible field -- wrong endianness, or an unaligned field/stride -- OR an
     * out-of-range id returns `null`. Resolve ONCE outside the loop like field(),
     * then run the tightest loop yourself:
     *   `const L = r.laneOf(id);`
     *   `if (L) { const {view,elemStride,elemOffset}=L;`
     *   `         for (row=0;row<n;row++) sum += view[row*elemStride+elemOffset]; }`
     *   `else   { for (row=0;row<n;row++) sum += r.getF32(row, id); }  // fall back`
     * The call allocates NOTHING -- the descriptor was built cold at construction;
     * this is a bounds-safe array lookup returning a reference (or null).
     */
    laneOf(fieldId) { return this._lanes[fieldId] || null; }

    // --- the read hot path (zero-alloc) ---------------------------------------
    // Contract (like lite-bake's lanes): `row` in [0,count), `fieldId` a valid
    // id. Unchecked for speed -- validation lives at the door, not per read.
    // One method per type keeps each call site monomorphic and branch-free
    // (Learning/V8.md): reader.getF32(i, x) never pays a type switch.

    // S10: each multi-byte getter reads the field's OWN endianness from `_leOf`
    // (one L1 typed-array index; default schemas fold to the reader flag at the
    // door). getI8/getU8 are single-byte -- endianness cannot apply.
    getF64(row, fieldId) { return this._dv.getFloat64(this._base + row * this._stride + this._off[fieldId], this._leOf[fieldId]); }
    getF32(row, fieldId) { return this._dv.getFloat32(this._base + row * this._stride + this._off[fieldId], this._leOf[fieldId]); }
    getI32(row, fieldId) { return this._dv.getInt32(this._base + row * this._stride + this._off[fieldId], this._leOf[fieldId]); }
    getU32(row, fieldId) { return this._dv.getUint32(this._base + row * this._stride + this._off[fieldId], this._leOf[fieldId]); }
    getI16(row, fieldId) { return this._dv.getInt16(this._base + row * this._stride + this._off[fieldId], this._leOf[fieldId]); }
    getU16(row, fieldId) { return this._dv.getUint16(this._base + row * this._stride + this._off[fieldId], this._leOf[fieldId]); }
    getI8(row, fieldId) { return this._dv.getInt8(this._base + row * this._stride + this._off[fieldId]); }
    getU8(row, fieldId) { return this._dv.getUint8(this._base + row * this._stride + this._off[fieldId]); }

    // 64-bit lanes (S9). These return a BigInt and therefore ALLOCATE (a BigInt is
    // a heap value by spec) -- they are NOT on the zero-GC read path, by design.
    getI64(row, fieldId) { return this._dv.getBigInt64(this._base + row * this._stride + this._off[fieldId], this._leOf[fieldId]); }
    getU64(row, fieldId) { return this._dv.getBigUint64(this._base + row * this._stride + this._off[fieldId], this._leOf[fieldId]); }

    /** Generic read: dispatches on the field's stored type code. One branch per
     *  read -- use the typed getX above in a tight monomorphic loop; use this
     *  when the type is data-driven (mixed schema walk, debug, tooling). */
    get(row, fieldId) {
        const pos = this._base + row * this._stride + this._off[fieldId];
        const dv = this._dv, le = this._leOf[fieldId];   // S10: this field's endianness
        switch (this._type[fieldId]) {
            case T_F64: return dv.getFloat64(pos, le);
            case T_F32: return dv.getFloat32(pos, le);
            case T_I32: return dv.getInt32(pos, le);
            case T_U32: return dv.getUint32(pos, le);
            case T_I16: return dv.getInt16(pos, le);
            case T_U16: return dv.getUint16(pos, le);
            case T_I8:  return dv.getInt8(pos);
            case T_I64: return dv.getBigInt64(pos, le);  // allocates a BigInt (S9)
            case T_U64: return dv.getBigUint64(pos, le); // allocates a BigInt (S9)
            default:    return dv.getUint8(pos); // T_U8
        }
    }

    /**
     * A zero-copy Uint8Array VIEW over `len` raw bytes at a field position --
     * the escape hatch for a blob / variable-length / foreign field. The view
     * aliases the buffer: it is BORROWED, valid until the buffer changes.
     * "Copy what you keep" (the ecosystem contract). Allocates one small view
     * wrapper (not zero-GC) -- do not call it on the frame hot path.
     */
    bytes(row, fieldId, len) {
        if (len === undefined) len = this._lenAt(row, fieldId);
        // BR-05: a COLD coded door on the D9 escape hatch (NOT the numeric hot
        // path). A raw Uint8Array RangeError carries no .code; refuse first.
        if (!Number.isInteger(len) || len < 0) fail("R_BAD_LENGTH", "bytes() len must be a non-negative integer, got " + len);
        const pos = this._base + row * this._stride + this._off[fieldId];
        if (pos + len > this._buffer.byteLength) fail("R_BUFFER_TOO_SMALL", "bytes() span ends at " + (pos + len) + ", past buffer length " + this._buffer.byteLength);
        return new Uint8Array(this._buffer, pos, len);
    }

    // --- the row cursor (D4, zero-alloc) --------------------------------------
    // Ergonomic sequential scans: `seek(row)` once, then read fields without
    // re-passing the row. UNCHECKED to match the getX trust model -- the row is a
    // caller contract (keep it a Smi), validation lives at the door not per seek.
    // The cursor reads INLINE the exact getF64..getU8 / get address arithmetic
    // with `_cursor` substituted for `row`, so each stays monomorphic and
    // frame-flat -- never a delegation through getX (a second frame per read).

    /** Point the cursor at `row` (unchecked, chainable). `r.seek(i).f64(id)`. */
    seek(row) { this._cursor = row; return this; }

    f64(id) { return this._dv.getFloat64(this._base + this._cursor * this._stride + this._off[id], this._leOf[id]); }
    f32(id) { return this._dv.getFloat32(this._base + this._cursor * this._stride + this._off[id], this._leOf[id]); }
    i32(id) { return this._dv.getInt32(this._base + this._cursor * this._stride + this._off[id], this._leOf[id]); }
    u32(id) { return this._dv.getUint32(this._base + this._cursor * this._stride + this._off[id], this._leOf[id]); }
    i16(id) { return this._dv.getInt16(this._base + this._cursor * this._stride + this._off[id], this._leOf[id]); }
    u16(id) { return this._dv.getUint16(this._base + this._cursor * this._stride + this._off[id], this._leOf[id]); }
    i8(id) { return this._dv.getInt8(this._base + this._cursor * this._stride + this._off[id]); }
    u8(id) { return this._dv.getUint8(this._base + this._cursor * this._stride + this._off[id]); }
    // 64-bit cursor reads (S9). Return a BigInt -> allocate, NOT on the zero-GC path.
    i64(id) { return this._dv.getBigInt64(this._base + this._cursor * this._stride + this._off[id], this._leOf[id]); }
    u64(id) { return this._dv.getBigUint64(this._base + this._cursor * this._stride + this._off[id], this._leOf[id]); }

    /** Generic cursor read: the `get` switch over `_cursor`. */
    val(id) {
        const pos = this._base + this._cursor * this._stride + this._off[id];
        const dv = this._dv, le = this._leOf[id];   // S10: this field's endianness
        switch (this._type[id]) {
            case T_F64: return dv.getFloat64(pos, le);
            case T_F32: return dv.getFloat32(pos, le);
            case T_I32: return dv.getInt32(pos, le);
            case T_U32: return dv.getUint32(pos, le);
            case T_I16: return dv.getInt16(pos, le);
            case T_U16: return dv.getUint16(pos, le);
            case T_I8:  return dv.getInt8(pos);
            case T_I64: return dv.getBigInt64(pos, le);  // allocates a BigInt (S9)
            case T_U64: return dv.getBigUint64(pos, le); // allocates a BigInt (S9)
            default:    return dv.getUint8(pos); // T_U8
        }
    }

    /**
     * Fill a caller-owned sink with every field of `row`, indexed by field id --
     * the SoA->AoS bridge with NO record object allocated (the caller owns `out`).
     * `out` is an Array or any TypedArray, indexed `out[i] = <field i at row>` for
     * i in [0,fieldCount). Cold door: refuse a sink that cannot hold one row -- an
     * Array too short would auto-GROW (an allocation), a TypedArray too short
     * would silently drop cells. Reuses R_BAD_LENGTH (no new code). Returns `out`.
     * S9 note: a mixed 64-bit row yields `number | bigint` cells, so a `Float64Array`
     * (or any numeric TypedArray) sink THROWS when a 64-bit cell is written -- use an
     * `Array` sink (or a `BigInt64Array` sink for an all-64-bit row).
     */
    readRow(row, out) {
        if (out == null || typeof out.length !== "number" || out.length < this._fieldCount) {
            fail("R_BAD_LENGTH", "readRow out must be indexable with a length >= fieldCount " + this._fieldCount);
        }
        const pos = this._base + row * this._stride, dv = this._dv, leOf = this._leOf, n = this._fieldCount;
        for (let i = 0; i < n; i++) {
            const p = pos + this._off[i], le = leOf[i];   // S10: this field's endianness
            switch (this._type[i]) {
                case T_F64: out[i] = dv.getFloat64(p, le); break;
                case T_F32: out[i] = dv.getFloat32(p, le); break;
                case T_I32: out[i] = dv.getInt32(p, le); break;
                case T_U32: out[i] = dv.getUint32(p, le); break;
                case T_I16: out[i] = dv.getInt16(p, le); break;
                case T_U16: out[i] = dv.getUint16(p, le); break;
                case T_I8:  out[i] = dv.getInt8(p); break;
                case T_I64: out[i] = dv.getBigInt64(p, le); break;  // allocates a BigInt (S9)
                case T_U64: out[i] = dv.getBigUint64(p, le); break; // allocates a BigInt (S9)
                default:    out[i] = dv.getUint8(p); // T_U8
            }
        }
        return out;
    }

    /** Resolve the run length for a variable-length field at `row` via its
     *  lengthField sibling. Underscore-prefixed: cold, internal to the 2-arg
     *  bytes() dispatch, and OUT of the public member inventory. */
    _lenAt(row, fieldId) {
        const lid = this._lenOf[fieldId];
        if (!(lid >= 0)) fail("R_BAD_LENGTH", "field " + fieldId + " has no lengthField; call bytes(row, id, len) with an explicit length");
        return this.get(row, lid);
    }

    // --- sibling cooperation (cold constructors) ------------------------------

    /**
     * Read a buffer produced by @zakkster/lite-bake. `baked` is its returned
     * { buffer, stride, count, schema } -- the schema drops in unchanged (D3).
     * lite-bake writes NATIVE endianness with no marker, so we read native.
     */
    static fromBaked(baked, options) {
        // BR-06: validate the argument SHAPE before any deref, so a null/malformed
        // sibling object yields a coded R_* instead of a raw TypeError.
        if (!baked || typeof baked !== "object") fail("R_BAD_SOURCE", "fromBaked requires a lite-bake { buffer, stride, count, schema } object");
        if (!Array.isArray(baked.schema) || baked.schema.length === 0) fail("R_BAD_SCHEMA", "fromBaked requires a non-empty schema array");
        const o = options || {};
        return new LiteBinaryReader(baked.buffer, {
            schema: baked.schema,
            stride: baked.stride,
            count: baked.count,
            littleEndian: IS_LITTLE_ENDIAN, // lite-bake is native-endian (Learning: its unowned portability hole)
            byteOffset: o.byteOffset
        });
    }

    /**
     * Read ONE carved LBK1 shard payload from @zakkster/lite-bake-stream. Pass
     * `{ bytes, rowStride, fields:[{name,laneKind,offsetInRow}] }` taken from
     * that reader's `schema` + `shardPayload(i)` + `strideBytes()`. We do NOT
     * re-parse the container (that is bake-stream's job); we consume its
     * primitives and TRANSLATE lane_kind -> our type code (D3). LBK1 is spec'd
     * little-endian. (A U32 lane resolves to a string-table INDEX; this reader
     * returns that index number -- string resolution stays in bake-stream.)
     */
    static fromLBK1Shard(shard, options) {
        // BR-06: validate the argument SHAPE before any deref, so a null/fieldless
        // shard yields a coded R_* instead of a raw TypeError.
        if (!shard || typeof shard !== "object") fail("R_BAD_SOURCE", "fromLBK1Shard requires a { bytes, rowStride, fields } object");
        if (!Array.isArray(shard.fields) || shard.fields.length === 0) fail("R_BAD_SCHEMA", "fromLBK1Shard requires a non-empty fields array");
        const o = options || {};
        const src = shard.fields;
        const schema = new Array(src.length);
        for (let i = 0; i < src.length; i++) {
            const f = src[i];
            const t = LANEKIND_TO_TYPE[f.laneKind];
            if (t === undefined) fail("R_BAD_TYPE", "unsupported LBK1 lane_kind " + f.laneKind);
            schema[i] = { name: f.name, type: t, offset: f.offsetInRow };
        }
        return new LiteBinaryReader(shard.bytes, {
            schema: schema,
            stride: shard.rowStride,
            littleEndian: true, // LBK1 is little-endian by spec
            byteOffset: o.byteOffset
        });
    }
}

export default LiteBinaryReader;
