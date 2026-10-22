/**
 * Worker stand-in for `asyncDatabase.test.ts`.
 *
 * Runs in a Bun.Worker thread (the `.fixture.ts` suffix keeps `bun test` from
 * collecting it). It answers every request with `slowMs` over the slow-request
 * threshold and echoes the request it received, so the test can drive the
 * `[db-slow]` log branch — which the real worker only reaches for genuinely
 * slow SQL — and can show that the bookkeeping change did not alter what
 * crosses the thread boundary.
 */

import type { WorkerRequest } from "./types.ts";

self.onmessage = (event: MessageEvent) => {
  const req = event.data as WorkerRequest;
  // Stands in for the worker's own `selfMs` measurement: always slow, so every
  // reply reaches `WorkerLink`'s slow-request branch.
  self.postMessage({ id: req.id, result: { received: req }, slowMs: 5000 });
};
