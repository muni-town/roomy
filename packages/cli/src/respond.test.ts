import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { respond } from "./respond.js";
import { QueueStore } from "./queue.js";
import type { CronJobPayload } from "./queue.js";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "roomy-respond-"));

const cronPayload = (text: string): CronJobPayload => ({
  spaceId: "space:test",
  roomId: "room:test",
  text,
});

/** Poll `fn` until truthy, throwing (test fail) after `timeoutMs`. */
async function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** A fake XRPC agent that only needs to accept `procedure` calls (cron posts). */
const fakeXrpc = {
  query: async () => {
    throw new Error("query not expected");
  },
  procedure: async () => ({ messageId: "msg:test" }),
} as never;

describe("respond reclaims a stranded active job", () => {
  test(
    "an active job behind a dead holder's stale lock is reclaimed without any stdin event",
    { timeout: 20_000 },
    async () => {
      // Real wall-clock timers are required here: the pump is driven by the
      // drain timer's tick, so the test must let the timer tick on the platform
      // clock for real and verify the pump reclaims a job stranded in `active`
      // (nothing `enqueued`) without an external stdin event. Fake timers
      // cannot drive the async pump's genuine file I/O under the lock, so
      // deterministic time control is not a substitute.
      const dir = tmpdir();
      const queueFile = path.join(dir, "queue.json");
      const lockFile = `${queueFile}.lock`;

      // Short interval + short TTL keep the real-timer test fast while still
      // exercising a genuine 25ms drain tick (not a single inline pump).
      const drainIntervalMs = 25;
      const lockTtlMs = 25;

      const originalStdin = process.stdin;
      try {
        // Idle stdin: no mention/reply event is ever emitted in this test. The
        // reclaim must come purely from the drain timer, not an external event.
        const stdin = new Readable({ read() {} });
        (process.stdin as unknown) = stdin;

        const respondDone = respond(fakeXrpc, { did: "did:plc:agent" }, {
          queueFile,
          lockFile,
          lockTtlMs,
          drainIntervalMs,
          continuity: false,
          // Never route traces anywhere or talk to a transport for mentions.
          traceThreads: false,
          streamThinking: false,
          thinking: false,
        });

        // Let the responder boot idle: drain timer running, no jobs, lock free.
        await new Promise((r) => setTimeout(r, 100));

        // Now a dead holder strands a job in `active`: its process crashed mid
        // job while its lock was still within TTL: the boot heal only requeues
        // when the lock is already stale, so it does nothing at startup here.
        const queue = new QueueStore(queueFile);
        const job = queue.enqueue("cron", cronPayload("orphaned"));
        queue.claim(job.id);
        expect(queue.status().active?.id).toBe(job.id);

        // The dead holder's lock, with a heartbeat long past the TTL.
        const deadHeartbeat = Date.now() - 5_000;
        fs.writeFileSync(
          lockFile,
          JSON.stringify({
            holder: "dead-host:999",
            pid: 999,
            acquiredAt: deadHeartbeat,
            heartbeatAt: deadHeartbeat,
          }),
        );

        // No stdin event is ever sent. The drain timer must notice the stranded
        // active job and reclaim it (requeue + run) on its own.
        await waitFor(() => {
          const s = queue.status();
          return s.active === null && s.done.some((j) => j.id === job.id);
        }, 3_000);

        const state = queue.status();
        expect(state.done.find((j) => j.id === job.id)?.status).toBe("done");
        expect(state.active).toBeNull();

        // End the idle stdin so the responder exits cleanly.
        stdin.push(null);
        await respondDone;
      } finally {
        (process.stdin as unknown) = originalStdin;
      }
    },
  );
});
