/**
 * S7b -- README error codes are a SUBSET of the codes the reader throws.
 *
 * dts-drift pins the R_* union in Reader.d.ts vs Reader.js. It does NOT check the
 * README's error table. This gate catches a README that names a code the reader
 * no longer throws (a rename, a removal, or a typo): every R_* token the README
 * mentions must be one Reader.js actually throws. A positive control proves the
 * subset check can fail.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("../", import.meta.url);
// \b so a substring inside a larger token (e.g. the `LBR_TORTURE_BREAK` env var,
// which contains "R_TORTURE_BREAK") is NOT mistaken for an R_* error code.
const RE = /\bR_[A-Z][A-Z_]+/g;

/** The authoritative thrown set: every R_* literal in the shipped reader source. */
function thrownCodes() {
    const js = readFileSync(new URL("Reader.js", ROOT), "utf8");
    return new Set(js.match(RE) || []);
}
function readmeCodes() {
    const md = readFileSync(new URL("README.md", ROOT), "utf8");
    return new Set(md.match(RE) || []);
}

test("S7b every R_* code named in the README is one Reader.js throws", () => {
    const thrown = thrownCodes();
    const readme = readmeCodes();
    assert.ok(readme.size >= 5, "non-vacuous: the README should document several R_* codes (found " + readme.size + ")");
    const stray = [...readme].filter((c) => !thrown.has(c));
    assert.deepEqual(stray, [], "README names R_* codes the reader does NOT throw: " + stray.join(", "));
});

test("S7b the thrown union is exactly the frozen 10 (guards the subset base set)", () => {
    // If the union drifts, the subset check's base set drifts silently -- pin it.
    assert.equal(thrownCodes().size, 10, "Reader.js R_* union is no longer exactly 10");
});

test("S7b positive control: a stray README code is caught", () => {
    const thrown = thrownCodes();
    const synthetic = new Set(["R_BAD_OFFSET", "R_NONSENSE_MADE_UP"]);
    const stray = [...synthetic].filter((c) => !thrown.has(c));
    assert.deepEqual(stray, ["R_NONSENSE_MADE_UP"], "the subset check failed to flag a fake code -- the gate is decorative");
});
