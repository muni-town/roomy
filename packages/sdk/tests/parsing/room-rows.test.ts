import { describe, it, expect } from "vitest";
import { parseRoomRows } from "../../src/connection/ConnectedSpace";
import type { SqlRows } from "@muni-town/leaf-client";
import { ProfileSynthetic } from "../../src/schema/events/synthetic";

describe("parseRoomRows", () => {
  it("should parse rows with profile column", () => {
    const rows: SqlRows = [
      {
        idx: { $type: "muni.town.sqliteValue.integer", value: 1 },
        user: { $type: "muni.town.sqliteValue.text", value: "did:plc:abc123" },
        payload: {
          $type: "muni.town.sqliteValue.blob",
          value: new Uint8Array([1, 2, 3]),
        },
        profile: {
          $type: "muni.town.sqliteValue.text",
          value: JSON.stringify({
            $type: "space.roomy.query.profile.v0",
            did: "did:plc:abc123",
            name: "Test User",
            avatar: "https://example.com/avatar.png",
            handle: "test.user",
          }),
        },
      },
    ];

    const result = parseRoomRows(rows);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].idx).toBe(1);
    expect(result.events[0].user).toBe("did:plc:abc123");
    expect(result.events[0].payload).toEqual(new Uint8Array([1, 2, 3]));

    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].did).toBe("did:plc:abc123");
    expect(result.profiles[0].name).toBe("Test User");
  });

  it("should parse rows without profile column (backwards compatibility)", () => {
    const rows: SqlRows = [
      {
        idx: { $type: "muni.town.sqliteValue.integer", value: 1 },
        user: { $type: "muni.town.sqliteValue.text", value: "did:plc:abc123" },
        payload: {
          $type: "muni.town.sqliteValue.blob",
          value: new Uint8Array([1, 2, 3]),
        },
        // No profile column - simulates older space module
      },
    ];

    const result = parseRoomRows(rows);

    expect(result.events).toHaveLength(1);
    expect(result.events[0].idx).toBe(1);
    expect(result.events[0].user).toBe("did:plc:abc123");
    expect(result.events[0].payload).toEqual(new Uint8Array([1, 2, 3]));

    // Profiles array should be empty
    expect(result.profiles).toHaveLength(0);
  });

  it("should handle mixed rows with and without profiles", () => {
    const rows: SqlRows = [
      {
        idx: { $type: "muni.town.sqliteValue.integer", value: 1 },
        user: { $type: "muni.town.sqliteValue.text", value: "did:plc:abc123" },
        payload: {
          $type: "muni.town.sqliteValue.blob",
          value: new Uint8Array([1, 2, 3]),
        },
        profile: {
          $type: "muni.town.sqliteValue.text",
          value: JSON.stringify({
            $type: "space.roomy.query.profile.v0",
            did: "did:plc:abc123",
            name: "User One",
            avatar: null,
            handle: null,
          }),
        },
      },
      {
        idx: { $type: "muni.town.sqliteValue.integer", value: 2 },
        user: { $type: "muni.town.sqliteValue.text", value: "did:plc:def456" },
        payload: {
          $type: "muni.town.sqliteValue.blob",
          value: new Uint8Array([4, 5, 6]),
        },
        // No profile column
      },
    ];

    const result = parseRoomRows(rows);

    expect(result.events).toHaveLength(2);
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0].did).toBe("did:plc:abc123");
  });

  it("should handle invalid profile JSON gracefully", () => {
    const rows: SqlRows = [
      {
        idx: { $type: "muni.town.sqliteValue.integer", value: 1 },
        user: { $type: "muni.town.sqliteValue.text", value: "did:plc:abc123" },
        payload: {
          $type: "muni.town.sqliteValue.blob",
          value: new Uint8Array([1, 2, 3]),
        },
        profile: {
          $type: "muni.town.sqliteValue.text",
          value: "invalid json{{{",
        },
      },
    ];

    // Should not throw, just log a warning
    const result = parseRoomRows(rows);

    expect(result.events).toHaveLength(1);
    expect(result.profiles).toHaveLength(0);
  });

  it("should handle null profile values", () => {
    const rows: SqlRows = [
      {
        idx: { $type: "muni.town.sqliteValue.integer", value: 1 },
        user: { $type: "muni.town.sqliteValue.text", value: "did:plc:abc123" },
        payload: {
          $type: "muni.town.sqliteValue.blob",
          value: new Uint8Array([1, 2, 3]),
        },
        profile: { $type: "muni.town.sqliteValue.null" },
      },
    ];

    const result = parseRoomRows(rows);

    expect(result.events).toHaveLength(1);
    expect(result.profiles).toHaveLength(0);
  });
});
