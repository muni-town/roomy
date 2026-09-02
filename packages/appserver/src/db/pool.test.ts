import { describe, expect, test } from "bun:test";
import { openDb } from "./db.ts";
import { hashSpace } from "./pool.ts";

describe("hashSpace", () => {
  test("is deterministic across calls", () => {
    const did = "did:plc:drzgt2m6lmcel62gfbzjeap3";
    expect(hashSpace(did)).toBe(hashSpace(did));
  });

  test("distributes a realistic set of DIDs across a pool", () => {
    const n = 4;
    const counts = new Array(n).fill(0);
    for (let i = 0; i < 200; i++) {
      const did = `did:plc:test${i.toString().padStart(4, "0")}`;
      counts[hashSpace(did) % n]!++;
    }
    // Within ±40% of uniform (200/4 = 50) — a loose bound that catches
    // pathological clustering without being flaky.
    for (const c of counts) {
      expect(c).toBeGreaterThan(30);
      expect(c).toBeLessThan(70);
    }
  });
});

describe("DatabasePool routing", () => {
  test("per-space writes land in the owning worker and read back", async () => {
    // Isolated pool (size 1) so this test never touches the process-wide
    // singleton that other test files share.
    const db = openDb({ path: ":memory:", isolated: true });
    const spaceA = "did:plc:pool-a";
    const spaceB = "did:plc:pool-b";

    await db.forSpace(spaceA).run(
      "insert into entities (id, stream_id) values (?, ?)",
      "entity-a",
      spaceA,
    );
    await db.forSpace(spaceB).run(
      "insert into entities (id, stream_id) values (?, ?)",
      "entity-b",
      spaceB,
    );

    const a = await db.forSpace(spaceA)
      .query("select id from entities where id = ?")
      .get<{ id: string }>("entity-a");
    const b = await db.forSpace(spaceB)
      .query("select id from entities where id = ?")
      .get<{ id: string }>("entity-b");
    expect(a?.id).toBe("entity-a");
    expect(b?.id).toBe("entity-b");

    // The global DB is shared across spaces (global worker).
    await db.global().run(
      "insert into edges (head, tail, label) values (?, ?, ?)",
      "user",
      spaceA,
      "joinedSpace",
    );
    const row = await db.global()
      .query("select tail from edges where head = ? and label = 'joinedSpace'")
      .get<{ tail: string }>("user");
    expect(row?.tail).toBe(spaceA);

    await db.close();
  });

  test("router dispatches to global and read-state workers", async () => {
    const db = openDb({ path: ":memory:", isolated: true });
    // The read-state DB is a real file shared across isolated pools, so use a
    // unique key to avoid UNIQUE collisions with other test runs.
    const room = `room-${Math.random().toString(36).slice(2, 8)}`;

    await db.global().run(
      "insert into edges (head, tail, label) values (?, ?, ?)",
      "u",
      "s",
      "joinedSpace",
    );
    await db.readState().run(
      "insert into read_positions (user_did, room_id, space_did, seen_up_to, unread_count) values (?, ?, ?, ?, ?)",
      "u",
      room,
      "s",
      "0",
      0,
    );

    const e = await db.global()
      .query("select tail from edges where head = ? and label = 'joinedSpace'")
      .get<{ tail: string }>("u");
    expect(e?.tail).toBe("s");

    const rp = await db.readState()
      .query("select unread_count from read_positions where user_did = ? and room_id = ?")
      .get<{ unread_count: number }>("u", room);
    expect(rp?.unread_count).toBe(0);

    await db.close();
  });
});
