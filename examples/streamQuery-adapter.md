# Example -- feed a `lite-query` streamQuery with zero-GC binary reads

This example is repo-only (not in the npm tarball). It is the runnable shape behind
Cookbook recipes R6 and R7, and every line is backed by `test/coop-query.test.js`.

`@zakkster/lite-query` is a **test-only devDependency** here -- the reader imports no
sibling. lite-query provides `streamQuery(qc, { key, stream, mode })`; you provide the
`stream:` generator that does the binary decoding. That is the entire seam: lite-query
owns the cache/observation/abort lifecycle, this reader owns bytes-to-numbers.

## The adapter

```js
import { queryClient } from '@zakkster/lite-query';
import { streamQuery } from '@zakkster/lite-query/stream';
import { LiteBinaryReader, T_F64 } from '@zakkster/lite-binary-reader';

const SCHEMA = [{ name: 'v', type: T_F64, offset: 0 }];
const STRIDE = 8;

// `source` is any cancellable async iterable of raw byte windows -- an HTTP Range
// reader, a socket, a file stream. It must expose `cancel()` (or a `return()` on its
// async iterator) so the stream generator can stop it on abort.
function foreignFeed(source) {
  return async function* ({ signal }) {
    // THE ONE CONTRACT: an async generator suspended on `await source.next()` cannot
    // be released by streamQuery's iterator.return() until that await settles. On
    // abort-on-detach, wire the signal to cancel the in-flight read yourself.
    signal.addEventListener('abort', () => source.cancel());

    const sink = new Float64Array(SCHEMA.length);   // hoisted; reused every frame
    for await (const win of source) {
      if (signal.aborted) return;
      const reader = new LiteBinaryReader(win, { schema: SCHEMA, stride: STRIDE, littleEndian: true }); // cold per window
      for (let i = 0; i < reader.count; i++) {
        if (signal.aborted) return;
        reader.readRow(i, sink);   // zero-alloc into the reused sink
        yield sink[0];             // one primitive per frame
      }
    }
  };
}

const qc = queryClient({});
const feed = streamQuery(qc, { key: ['feed'], mode: 'latest', stream: foreignFeed(source) });
// observe with your reactive layer's effect: effect(() => render(feed.data()))
// detaching the last observer aborts -> the generator cancels `source` -> clean stop.
```

## Why it is zero-GC

- The reader's per-frame work is `readRow` into a **reused** sink: 0 B/op, gated by the
  torture t6 retained-alloc gate.
- `new LiteBinaryReader(...)` is built **once per window** (cold), amortized across the
  window's rows -- not on the per-value frame path.
- `streamQuery` `latest` mode writes the entry's existing `data` signal once per frame,
  with no allocation (lite-query's own contract). `buffer` mode allocates a snapshot
  array per value -- that is lite-query's accumulation cost, not the reader's.
- Yield a **primitive** (or a reused out-param). A fresh `{ ... }` record per row would
  allocate on the hot path.

## Ownership (copy what you keep)

A decoded **number** is a value -- it survives the window being overwritten by the next
frame. A `bytes(row, id)` span is a **borrowed view** into the window; if you retain it
past the frame, copy it, because a pooled/streamed window is overwritten in place. (A
reader built over a partial or nonzero-offset window copies to an owned buffer at
construction -- BR-07 -- so the reader itself never reads past its window.)

## The `fromLBK1Shard` variant

If the windows are real `@zakkster/lite-bake-stream` shard payloads, read them through
`LiteBinaryReader.fromLBK1Shard({ bytes: container.shardPayload(s), rowStride, fields })`
instead of a raw schema -- see Cookbook R7. An LBK1 U32 lane is a string-table index;
string resolution stays in bake-stream.
