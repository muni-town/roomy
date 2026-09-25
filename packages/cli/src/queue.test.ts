import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { FileLock, QueueStore, bootHeal, DONE_CAP } from "./queue.js";

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), "roomy-queue-"));
const mentionPayload = (id: string) => ({
  kind: "mention" as const,
  evt: {
    kind: "mention" as const,
    spaceId: "space:test",
    roomId: "room:test",
    message: {
      id,
      roomId: "room:test",
      authorDid: "did:plc:user",
      authorName: "User",
      content: `hello ${id}`,
      timestamp: new Date().toISOString(),
    },
  },
});
const cronPayload = (text: string) => ({
  kind: "cron" as const,
  cron: { spaceId: "space:test", roomId: "room:test", text },
});

describe("QueueStore", () => {
  test("enqueue appends FIFO and persists across instances", () => {
    const file = path.join(tmpdir(), "queue.json");
    const q1 = new QueueStore(file);
    const a = q1.enqueue("mention", mentionPayload("a"));
    const b = q1.enqueue("mention", mentionPayload("b"));
    expect(q1.status().enqueued.map((j) => j.id)).toEqual([a.id, b.id]);
    expect(q1.status().jobSeq).toBe(2);

    // A fresh instance reading the same file sees the jobs.
    const q2 = new QueueStore(file);
    expect(q2.status().enqueued.map((j) => j.id)).toEqual([a.id, b.id]);
  });

  test("claim moves the head to active; finish marks done", () => {
    const q = new QueueStore(path.join(tmpdir(), "queue.json"));
    const a = q.enqueue("mention", mentionPayload("a"));
    const b = q.enqueue("mention", mentionPayload("b"));

    // Only the head may be claimed.
    expect(q.claim(b.id)).toBeNull();
    const active = q.claim(a.id);
    expect(active?.status).toBe("active");
    expect(q.status().enqueued.map((j) => j.id)).toEqual([b.id]);
    expect(q.status().active?.id).toBe(a.id);

    q.finish(a.id, "done");
    expect(q.status().active).toBeNull();
    expect(q.status().done.map((j) => j.id)).toEqual([a.id]);
  });

  test("enqueueIfIdle refuses when the queue is busy", () => {
    const q = new QueueStore(path.join(tmpdir(), "queue.json"));
    expect(q.enqueueIfIdle("cron", cronPayload("x"))).not.toBeNull();
    // Busy (queued) → refused.
    expect(q.enqueueIfIdle("cron", cronPayload("y"))).toBeNull();
  });

  test("enqueueIfIdle accepts when only done jobs remain (idle)", () => {
    const q = new QueueStore(path.join(tmpdir(), "queue.json"));
    const a = q.enqueue("cron", cronPayload("x"));
    q.claim(a.id);
    q.finish(a.id, "done");
    expect(q.status().enqueued).toHaveLength(0);
    expect(q.status().active).toBeNull();
    expect(q.enqueueIfIdle("cron", cronPayload("y"))).not.toBeNull();
  });

  test("requeueStaleActive restores the active job to the head", () => {
    const q = new QueueStore(path.join(tmpdir(), "queue.json"));
    const a = q.enqueue("mention", mentionPayload("a"));
    q.claim(a.id);
    q.requeueStaleActive(true);
    expect(q.status().active).toBeNull();
    expect(q.status().enqueued[0]?.id).toBe(a.id);
    expect(q.status().enqueued[0]?.status).toBe("queued");
  });

  test("requeueStaleActive leaves a live active job alone", () => {
    const q = new QueueStore(path.join(tmpdir(), "queue.json"));
    const a = q.enqueue("mention", mentionPayload("a"));
    q.claim(a.id);
    q.requeueStaleActive(false);
    expect(q.status().active?.id).toBe(a.id);
  });

  test("done list is capped at DONE_CAP", () => {
    const q = new QueueStore(path.join(tmpdir(), "queue.json"));
    for (let i = 0; i < DONE_CAP + 10; i++) {
      const job = q.enqueue("cron", cronPayload(`job-${i}`));
      q.claim(job.id);
      q.finish(job.id, "done");
    }
    expect(q.status().done).toHaveLength(DONE_CAP);
  });

  test("corrupt queue file falls back to empty", () => {
    const file = path.join(tmpdir(), "queue.json");
    fs.writeFileSync(file, "{not json");
    const q = new QueueStore(file);
    expect(q.status().enqueued).toHaveLength(0);
    expect(q.enqueue("cron", cronPayload("x"))).not.toBeNull();
  });
});

describe("FileLock", () => {
  test("only one holder at a time; release frees it", () => {
    const file = path.join(tmpdir(), "queue.json.lock");
    const l1 = new FileLock(file);
    const l2 = new FileLock(file);
    expect(l1.tryAcquire("holder-a", 111)).toBeTrue();
    expect(l2.tryAcquire("holder-b", 222)).toBeFalse();
    expect(l1.info()?.holder).toBe("holder-a");
    l1.release("holder-a");
    expect(l2.tryAcquire("holder-b", 222)).toBeTrue();
  });

  test("stale lock is taken over after the TTL", () => {
    const file = path.join(tmpdir(), "queue.json.lock");
    const l1 = new FileLock(file, 50);
    const l2 = new FileLock(file, 50);
    l1.tryAcquire("holder-a", 111);
    expect(l2.tryAcquire("holder-b", 222)).toBeFalse();
    // Heartbeat stops → stale after TTL.
    expect(l1.info()?.stale).toBeFalse();
    // Simulate the holder dying: wait out the TTL.
    const start = Date.now();
    while (Date.now() - start < 80) {
      // busy-wait for the tiny TTL
    }
    expect(l1.info()?.stale).toBeTrue();
    expect(l2.tryAcquire("holder-b", 222)).toBeTrue();
  });

  test("release only works for the current holder", () => {
    const file = path.join(tmpdir(), "queue.json.lock");
    const l1 = new FileLock(file);
    l1.tryAcquire("holder-a", 111);
    l1.release("someone-else");
    expect(l1.info()?.holder).toBe("holder-a");
  });
});

describe("bootHeal", () => {
  test("releases the lock when it boots idle (no squat)", () => {
    // A responder that boots idle must release the lock it took in startup
    // acquire(): the pump (the only other release site) never runs while the
    // queue is empty, and the lock heartbeat keeps a held lock fresh forever,
    // so every lock-freshness reader (self-check.sh queue_busy, `cli queue
    // status`, the cron only-if-idle contract) would see "job in flight" on a
    // permanently idle host and never start work.
    const dir = tmpdir();
    const q = new QueueStore(path.join(dir, "queue.json"));
    const lock = new FileLock(path.join(dir, "queue.json.lock"));

    expect(bootHeal(q, lock, "host:1", 1)).toBeNull();
    expect(lock.info()).toBeNull();
  });

  test("requeues a job orphaned in active by a dead holder", () => {
    // Why this heal exists: a crashed responder leaves `active` set, and with
    // nothing `enqueued` the drain timer never triggers the pump, so the
    // orphan would otherwise never be retried.
    const dir = tmpdir();
    const file = path.join(dir, "queue.json");
    const q = new QueueStore(file);
    const job = q.enqueue("mention", mentionPayload("orphan"));
    q.claim(job.id);
    expect(q.status().active?.id).toBe(job.id);

    const lock = new FileLock(path.join(dir, "queue.json.lock"));
    bootHeal(q, lock, "host:1", 1);

    expect(q.status().active).toBeNull();
    expect(q.status().enqueued.map((j) => j.id)).toEqual([job.id]);
    expect(lock.info()).toBeNull();
  });

  test("leaves a live foreign holder alone and reports it", () => {
    const dir = tmpdir();
    const q = new QueueStore(path.join(dir, "queue.json"));
    const lockFile = path.join(dir, "queue.json.lock");
    const other = new FileLock(lockFile);
    other.tryAcquire("other-host:9", 9);
    const job = q.enqueue("mention", mentionPayload("held"));
    q.claim(job.id);

    const info = bootHeal(q, new FileLock(lockFile), "host:1", 1);

    expect(info?.holder).toBe("other-host:9");
    // Untouched: the live holder keeps the lock and its job stays active.
    expect(other.info()?.holder).toBe("other-host:9");
    expect(q.status().active?.id).toBe(job.id);
  });
});
