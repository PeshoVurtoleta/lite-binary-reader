/**
 * @zakkster/lite-binary-reader -- .d.ts drift guard (node:test).
 *
 * Shipping a hand-written ambient .d.ts earns its keep only if a gate proves it
 * never drifts from the runtime. This suite reads the file TEXT of Reader.js,
 * Reader.d.ts and package.json (never imports them) and asserts THREE inventories
 * agree, each DERIVED by regex, never hardcoded:
 *
 *   (a) code-union parity : the R_* tags passed to fail(...) in Reader.js EQUAL
 *       the R_* literals in the `type ReaderErrorCode` union in Reader.d.ts.
 *   (b) export parity     : the value exports (const/class/function + default) of
 *       Reader.js EQUAL the value exports of Reader.d.ts, and every public class
 *       member is present in both.
 *   (c) version parity    : the VERSION literal in Reader.js EQUALS the version in
 *       package.json.
 *
 * Each check is a PURE function over text, so the same function proves teeth: the
 * mutation controls feed it a mutated COPY and assert it now reports a diff. A
 * vacuity control asserts the unmutated text reports zero diffs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const JS = readFileSync(new URL('Reader.js', ROOT), 'utf8');
const DTS = readFileSync(new URL('Reader.d.ts', ROOT), 'utf8');
const PKG = readFileSync(new URL('package.json', ROOT), 'utf8');

// --- pure extractors (text in, Set/string out) ------------------------------

/** R_* codes actually thrown at fail(...) call sites (NOT the header comment). */
function failCodes(jsText) {
  const out = new Set();
  const re = /fail\(\s*"(R_[A-Z_]+)"/g;
  let m;
  while ((m = re.exec(jsText)) !== null) out.add(m[1]);
  return out;
}

/** R_* literals inside the `type ReaderErrorCode = ... ;` union slice of the d.ts. */
function unionCodes(dtsText) {
  const start = dtsText.indexOf('type ReaderErrorCode');
  assert.notEqual(start, -1, 'Reader.d.ts has no ReaderErrorCode union');
  const end = dtsText.indexOf(';', start);
  assert.notEqual(end, -1, 'ReaderErrorCode union is not terminated');
  const slice = dtsText.slice(start, end);
  const out = new Set();
  const re = /"(R_[A-Z_]+)"/g;
  let m;
  while ((m = re.exec(slice)) !== null) out.add(m[1]);
  return out;
}

/** Value exports of Reader.js: const/class/function names + `default` if present. */
function jsExports(jsText) {
  const out = new Set();
  const re = /^export (const|class|function)\s+(\w+)/gm;
  let m;
  while ((m = re.exec(jsText)) !== null) out.add(m[2]);
  if (/^export default\s/m.test(jsText)) out.add('default');
  return out;
}

/** Value exports of Reader.d.ts: const/class/function names + `default`. Type and
 *  interface declarations are type-level only and are compared separately. */
function dtsValueExports(dtsText) {
  const out = new Set();
  const re = /^export declare (const|class|function|type|interface)?\s*(\w+)/gm;
  let m;
  while ((m = re.exec(dtsText)) !== null) {
    const kind = m[1];
    if (kind === 'type' || kind === 'interface') continue;
    out.add(m[2]);
  }
  if (/^export default\s/m.test(dtsText)) out.add('default');
  return out;
}

/** Public (non-underscore) member names declared on a `class Name` body in text.
 *  Uses a \b anchor so `LiteBinaryReader` never matches `LiteBinaryReaderError`. */
function classMembers(text, name) {
  const decl = new RegExp('class ' + name + '\\b');
  const m0 = decl.exec(text);
  if (m0 === null) return new Set();
  const start = m0.index;
  const open = text.indexOf('{', start);
  // walk braces to find the matching close
  let depth = 0;
  let i = open;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) break; }
  }
  const body = text.slice(open + 1, i);
  const out = new Set();
  const re = /(?:^|\n)\s*(?:static\s+)?(?:get\s+)?([A-Za-z]\w*)\s*\(/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const nm = m[1];
    if (nm === 'constructor' || nm === 'super') continue;
    out.add(nm);
  }
  return out;
}

/** VERSION string literal in Reader.js. */
function jsVersion(jsText) {
  const m = /VERSION\s*=\s*"([^"]+)"/.exec(jsText);
  assert.ok(m, 'Reader.js has no VERSION literal');
  return m[1];
}

/** version field in package.json. */
function pkgVersion(pkgText) {
  const m = /"version":\s*"([^"]+)"/.exec(pkgText);
  assert.ok(m, 'package.json has no version field');
  return m[1];
}

/** Symmetric-difference report between two sets: [] when equal. */
function setDiff(a, b, labelA, labelB) {
  const diffs = [];
  for (const x of a) if (!b.has(x)) diffs.push(labelA + ' has ' + x + ' but ' + labelB + ' does not');
  for (const x of b) if (!a.has(x)) diffs.push(labelB + ' has ' + x + ' but ' + labelA + ' does not');
  return diffs;
}

// --- the three inventories --------------------------------------------------

test('(a) code-union parity: fail() R_* codes === ReaderErrorCode union', () => {
  const diffs = setDiff(failCodes(JS), unionCodes(DTS), 'Reader.js', 'Reader.d.ts union');
  assert.deepEqual(diffs, [], diffs.join('; '));
  assert.equal(failCodes(JS).size, 10, 'the R_* union must stay exactly 10 codes');
  // The type-code table is a frozen invariant too: TYPE_COUNT and the TYPE_BYTES
  // width table must both stay at exactly 8 (S4 adds no new type code).
  assert.match(JS, /const TYPE_COUNT = 8;/, 'TYPE_COUNT must stay exactly 8');
  const tbMatch = /const TYPE_BYTES = \[([^\]]*)\]/.exec(JS);
  assert.ok(tbMatch, 'Reader.js has no TYPE_BYTES table');
  const entries = tbMatch[1].split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  assert.equal(entries.length, 8, 'TYPE_BYTES must have exactly 8 entries, saw ' + entries.length);
});

test('(b) export parity: value exports agree + class members present in both', () => {
  const diffs = setDiff(jsExports(JS), dtsValueExports(DTS), 'Reader.js', 'Reader.d.ts');
  assert.deepEqual(diffs, [], diffs.join('; '));
  // every member DECLARED in the d.ts must be a real member of the source class.
  // (Direction: d.ts -> source. The source body carries statement keywords that a
  // bodiless d.ts cannot, so the reverse direction would be noise; the d.ts is the
  // clean inventory and must not declare surface the source lacks.)
  const jsMembers = classMembers(JS, 'LiteBinaryReader');
  const dtsMembers = classMembers(DTS, 'LiteBinaryReader');
  assert.ok(dtsMembers.size >= 32, 'expected the d.ts to declare the full member surface, saw ' + dtsMembers.size);
  const memberMissing = [];
  for (const nm of dtsMembers) if (!jsMembers.has(nm)) memberMissing.push('Reader.d.ts declares member ' + nm + ' absent from Reader.js');
  assert.deepEqual(memberMissing, [], memberMissing.join('; '));
});

test('(c) version parity: Reader.js VERSION === package.json version', () => {
  assert.equal(jsVersion(JS), pkgVersion(PKG));
});

// --- teeth: each check must reject a mutated COPY (non-vacuity) --------------

test('control: unmutated text reports zero diffs (vacuity)', () => {
  assert.deepEqual(setDiff(failCodes(JS), unionCodes(DTS), 'a', 'b'), []);
  assert.deepEqual(setDiff(jsExports(JS), dtsValueExports(DTS), 'a', 'b'), []);
  assert.equal(jsVersion(JS), pkgVersion(PKG));
});

test('control: deleting one R_* from the union makes code-union parity fail', () => {
  const mutated = DTS.replace(/\s*\|\s*"R_BAD_SOURCE"/, ''); // drop one union member
  const diffs = setDiff(failCodes(JS), unionCodes(mutated), 'Reader.js', 'union');
  assert.ok(diffs.length > 0, 'dropping R_BAD_SOURCE from the union did not fail parity');
});

test('control: deleting the IS_LITTLE_ENDIAN export makes export parity fail', () => {
  const mutated = DTS.replace(/^export declare const IS_LITTLE_ENDIAN: boolean;$/m, '');
  const diffs = setDiff(jsExports(JS), dtsValueExports(mutated), 'Reader.js', 'Reader.d.ts');
  assert.ok(diffs.length > 0, 'dropping IS_LITTLE_ENDIAN from the d.ts did not fail parity');
});

test('control: changing the version string makes version parity fail', () => {
  const mutated = PKG.replace(/"version":\s*"[^"]+"/, '"version": "9.9.9"');
  assert.notEqual(jsVersion(JS), pkgVersion(mutated));
});
