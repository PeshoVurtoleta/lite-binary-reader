/**
 * S6 -- peer-surface guard (node:test).
 *
 * The cooperation tests are only meaningful if the lite-query surface they
 * consume actually EXISTS at runtime. Rather than trust another package's
 * llms.txt, assert the symbols this session depends on -- so a peer rename or a
 * missing install fails CLOSED here with a clear message, instead of surfacing
 * as a confusing failure deep inside a streamQuery test. Nothing here is written
 * from memory; every claim is checked against the installed package.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { queryClient } from "@zakkster/lite-query";
import { streamQuery } from "@zakkster/lite-query/stream";
import { effect, signal } from "./helpers/query-observer.mjs";

test("S6 peer-surface: lite-query exposes queryClient + streamQuery", () => {
    assert.equal(typeof queryClient, "function", "queryClient must be a function");
    assert.equal(typeof streamQuery, "function", "streamQuery must be a function");
});

test("S6 peer-surface: the bound lite-signal instance exposes effect + signal", () => {
    // These come from the SAME instance lite-query resolves (peer-dedup helper).
    assert.equal(typeof effect, "function", "effect must be a function");
    assert.equal(typeof signal, "function", "signal must be a function");
});

test("S6 peer-surface: a streamQuery handle exposes the documented shape", () => {
    const qc = queryClient({});
    const sq = streamQuery(qc, {
        key: ["surface"],
        mode: "latest",
        stream: () => ({ next: () => new Promise(() => {}), return: () => Promise.resolve({ done: true }) }),
    });
    for (const m of ["data", "error", "status", "loading", "done", "count", "droppedCount", "restart", "dispose"]) {
        assert.equal(typeof sq[m], "function", "streamQuery handle must expose " + m + "()");
    }
    assert.equal(sq.status(), "idle", "unobserved stream is idle (lazy)");
    sq.dispose();
});
