/**
 * T5.4 -- the D10 no-import-edge assertion (node:test).
 *
 * A cooperation constructor reads a sibling's OUTPUT; it never IMPORTS the
 * sibling. The siblings are devDependencies of the TEST only -- a stray
 * `import ... from "@zakkster/..."` in Reader.js (or Reader.d.ts) would be a
 * suite-law violation and a hidden runtime-dep edge. This encodes that as a
 * gate: read the shipped source TEXT and assert ZERO sibling import specifiers,
 * with a positive control proving the regex can actually match.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
const JS = readFileSync(new URL("Reader.js", ROOT), "utf8");
const DTS = readFileSync(new URL("Reader.d.ts", ROOT), "utf8");

// Matches an ESM import/re-export whose specifier is a @zakkster scope package.
const EDGE = /from\s+["']@zakkster/g;

test("T5.4 Reader.js imports no @zakkster sibling", () => {
    const hits = JS.match(EDGE) || [];
    assert.equal(hits.length, 0, "Reader.js has a sibling import edge: " + hits.join(", "));
});

test("T5.4 Reader.d.ts imports no @zakkster sibling", () => {
    const hits = DTS.match(EDGE) || [];
    assert.equal(hits.length, 0, "Reader.d.ts has a sibling import edge: " + hits.join(", "));
});

test("T5.4 positive control: the edge regex can match", () => {
    const synthetic = 'import { bake } from "@zakkster/lite-bake";\n';
    const hits = synthetic.match(/from\s+["']@zakkster/g) || [];
    assert.equal(hits.length, 1, "the regex failed to match a real sibling import -- the gate is decorative");
});
