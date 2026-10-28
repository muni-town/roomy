/**
 * Tests for the retention rules behind a tile's mounted frame.
 *
 * The failure this defends: a virtualiser destroys a tile's component whenever
 * its row leaves the window, so the frame has to outlive it — but every frame
 * kept is memory. A pool that never drops one leaks for the length of a
 * session; one that drops the wrong one either reloads a tile that is still on
 * screen or hands a live frame to a second placeholder. These tests pin which
 * host is reused, which is dropped, and when.
 */

import { describe, expect, it } from "vitest";

import { tileRenderKey } from "./message-tiles.js";
import { TilePool } from "./tile-pool.js";

const HELLO = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3meggnybzqs2n";
const MINESWEEPER = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3mcjwwoqjqs2v";

/** A pool over numbered hosts, with a clock the test moves by hand. */
function buildPool(limit: number, idleLimitMs = 60_000) {
  let clock = 0;
  const created: string[] = [];
  const disposed: string[] = [];
  const pool = new TilePool<{ id: number }>({
    limit,
    idleLimitMs,
    now: () => clock,
    dispose: (host) => disposed.push(`id-${host.id}`),
  });
  const acquire = (key: string) =>
    pool.acquire(key, (k) => {
      created.push(k);
      return { id: created.length };
    });
  return {
    pool,
    acquire,
    created,
    disposed,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe("TilePool", () => {
  it("hands a detached host back to the next placeholder with the same key", () => {
    const { pool, acquire, created, disposed } = buildPool(4);

    const first = acquire(HELLO);
    pool.release(first);
    const second = acquire(HELLO);

    expect(second.host).toBe(first.host);
    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(disposed).toEqual([]);
  });

  it("treats a different payload as a different tile", () => {
    const { pool, acquire, created } = buildPool(4);

    pool.release(acquire(tileRenderKey(HELLO, { count: 1 })));
    const other = acquire(tileRenderKey(HELLO, { count: 2 }));

    expect(created).toHaveLength(2);
    expect(other.host.id).toBe(2);
  });

  it("does not reuse a host another placeholder is still drawing", () => {
    const { acquire, created } = buildPool(4);

    acquire(HELLO);
    const second = acquire(HELLO);

    expect(created).toHaveLength(2);
    expect(second.host.id).toBe(2);
  });

  it("drops the least recently seen idle host when the cap is reached", () => {
    const { pool, acquire, advance, disposed } = buildPool(2);

    pool.release(acquire(HELLO));
    advance(10);
    pool.release(acquire(MINESWEEPER));
    advance(10);
    pool.touch(pool.slots[1]!);
    acquire("at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/third");

    expect(disposed).toEqual(["id-1"]);
    expect(pool.size).toBe(2);
  });

  it("builds a fresh host for a key whose host was evicted", () => {
    const { pool, acquire, created, disposed } = buildPool(1);

    pool.release(acquire(HELLO));
    pool.release(acquire(MINESWEEPER));
    pool.release(acquire(HELLO));

    expect(disposed).toEqual(["id-1", "id-2"]);
    expect(created).toHaveLength(3);
    expect(created[2]).toBe(HELLO);
  });

  it("drops an idle host once its retention runs out", () => {
    const { pool, acquire, advance, disposed } = buildPool(4, 1000);

    pool.release(acquire(HELLO));
    advance(999);
    pool.sweep();
    expect(disposed).toEqual([]);

    advance(2);
    pool.sweep();
    expect(disposed).toEqual(["id-1"]);
    expect(pool.size).toBe(0);
  });

  it("keeps a host on screen past the idle limit and the cap", () => {
    const { pool, acquire, advance, disposed } = buildPool(1, 1000);

    acquire(HELLO);
    advance(5000);
    pool.sweep();
    expect(disposed).toEqual([]);

    // Every retained host is being drawn, so a new key may not evict one.
    acquire(MINESWEEPER);
    expect(pool.size).toBe(2);
    expect(disposed).toEqual([]);
  });
});
