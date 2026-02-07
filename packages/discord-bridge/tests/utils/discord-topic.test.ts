/**
 * Tests for Discord channel topic utilities.
 * These functions manage the Roomy sync marker in Discord channel topics
 * for idempotent Roomy → Discord channel sync.
 */

import { describe, it, expect } from "vitest";
import {
  extractRoomyRoomId,
  addRoomySyncMarker,
  isRoomySyncedChannel,
  removeRoomySyncMarker,
} from "../../src/utils/discord-topic";

const VALID_ULID = "01HZ5KJVM7X6YM8QPE7YV4Q0ZY";
const ANOTHER_ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("extractRoomyRoomId", () => {
  it("should extract ULID from topic with only sync marker", () => {
    const topic = `[Synced from Roomy: ${VALID_ULID}]`;
    expect(extractRoomyRoomId(topic)).toEqual(VALID_ULID);
  });

  it("should extract ULID from topic with marker and existing content", () => {
    const topic = `General discussion [Synced from Roomy: ${VALID_ULID}]`;
    expect(extractRoomyRoomId(topic)).toEqual(VALID_ULID);
  });

  it("should extract ULID from topic with marker at start", () => {
    const topic = `[Synced from Roomy: ${VALID_ULID}] - Engineering team`;
    expect(extractRoomyRoomId(topic)).toEqual(VALID_ULID);
  });

  it("should return null for null topic", () => {
    expect(extractRoomyRoomId(null)).toBeNull();
  });

  it("should return null for undefined topic", () => {
    expect(extractRoomyRoomId(undefined)).toBeNull();
  });

  it("should return null for empty string", () => {
    expect(extractRoomyRoomId("")).toBeNull();
  });

  it("should return null for topic without sync marker", () => {
    expect(extractRoomyRoomId("General discussion")).toBeNull();
  });

  it("should return null for malformed sync marker (invalid ULID)", () => {
    // Too short
    expect(extractRoomyRoomId("[Synced from Roomy: ABC123]")).toBeNull();
    // Has invalid chars (I, L, O, U not allowed in Crockford base32)
    expect(extractRoomyRoomId("[Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0OI]")).toBeNull();
  });

  it("should return null for partially matching pattern", () => {
    expect(extractRoomyRoomId("[Synced from Roomy:")).toBeNull();
    expect(extractRoomyRoomId("Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]")).toBeNull();
  });

  it("should extract first ULID if multiple markers exist", () => {
    const topic = `[Synced from Roomy: ${VALID_ULID}] [Synced from Roomy: ${ANOTHER_ULID}]`;
    expect(extractRoomyRoomId(topic)).toEqual(VALID_ULID);
  });
});

describe("addRoomySyncMarker", () => {
  it("should return just the marker when topic is null", () => {
    const result = addRoomySyncMarker(null, VALID_ULID);
    expect(result).toEqual(`[Synced from Roomy: ${VALID_ULID}]`);
  });

  it("should return just the marker when topic is empty string", () => {
    const result = addRoomySyncMarker("", VALID_ULID);
    expect(result).toEqual(`[Synced from Roomy: ${VALID_ULID}]`);
  });

  it("should append marker to existing topic", () => {
    const result = addRoomySyncMarker("General discussion", VALID_ULID);
    expect(result).toEqual(`General discussion [Synced from Roomy: ${VALID_ULID}]`);
  });

  it("should replace existing marker with new ULID", () => {
    const topic = `[Synced from Roomy: ${ANOTHER_ULID}]`;
    const result = addRoomySyncMarker(topic, VALID_ULID);
    expect(result).toEqual(`[Synced from Roomy: ${VALID_ULID}]`);
  });

  it("should replace marker in topic with existing content", () => {
    const topic = `General [Synced from Roomy: ${ANOTHER_ULID}] - Engineering`;
    const result = addRoomySyncMarker(topic, VALID_ULID);
    expect(result).toEqual(`General [Synced from Roomy: ${VALID_ULID}] - Engineering`);
  });

  it("should handle multiple markers by replacing first occurrence", () => {
    const topic = `[Synced from Roomy: ${ANOTHER_ULID}] [Synced from Roomy: ${VALID_ULID}]`;
    const result = addRoomySyncMarker(topic, "01HZ5KJVM7X6YM8QPE7YV4Q0AA");
    expect(result).toContain("[Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0AA]");
  });

  it("should preserve topic content exactly", () => {
    const result = addRoomySyncMarker("Engineering team channel", VALID_ULID);
    expect(result).toEqual("Engineering team channel [Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]");
  });

  it("should handle topics with special characters", () => {
    const result = addRoomySyncMarker("Channel with emojis 🎉 🔥", VALID_ULID);
    expect(result).toEqual("Channel with emojis 🎉 🔥 [Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]");
  });

  it("should handle topics with newlines", () => {
    const result = addRoomySyncMarker("Line 1\nLine 2", VALID_ULID);
    expect(result).toEqual("Line 1\nLine 2 [Synced from Roomy: 01HZ5KJVM7X6YM8QPE7YV4Q0ZY]");
  });
});

describe("isRoomySyncedChannel", () => {
  it("should return true for topic with sync marker", () => {
    const topic = `[Synced from Roomy: ${VALID_ULID}]`;
    expect(isRoomySyncedChannel(topic)).toBe(true);
  });

  it("should return true for topic with marker and content", () => {
    const topic = `General discussion [Synced from Roomy: ${VALID_ULID}]`;
    expect(isRoomySyncedChannel(topic)).toBe(true);
  });

  it("should return false for null topic", () => {
    expect(isRoomySyncedChannel(null)).toBe(false);
  });

  it("should return false for undefined topic", () => {
    expect(isRoomySyncedChannel(undefined)).toBe(false);
  });

  it("should return false for empty topic", () => {
    expect(isRoomySyncedChannel("")).toBe(false);
  });

  it("should return false for topic without marker", () => {
    expect(isRoomySyncedChannel("General discussion")).toBe(false);
  });

  it("should return false for malformed marker", () => {
    expect(isRoomySyncedChannel("[Synced from Roomy: NOT-A-ULID]")).toBe(false);
  });

  it("should return true even with extra content", () => {
    const topic = `Welcome! [Synced from Roomy: ${VALID_ULID}] Please be nice.`;
    expect(isRoomySyncedChannel(topic)).toBe(true);
  });
});

describe("removeRoomySyncMarker", () => {
  it("should remove marker from topic with only marker", () => {
    const topic = `[Synced from Roomy: ${VALID_ULID}]`;
    const result = removeRoomySyncMarker(topic);
    expect(result).toEqual("");
  });

  it("should remove marker from topic with content", () => {
    const topic = `General [Synced from Roomy: ${VALID_ULID}]`;
    const result = removeRoomySyncMarker(topic);
    expect(result).toEqual("General");
  });

  it("should remove marker from topic with content after", () => {
    const topic = `[Synced from Roomy: ${VALID_ULID}] discussion`;
    const result = removeRoomySyncMarker(topic);
    expect(result).toEqual(" discussion");
  });

  it("should return null for null input", () => {
    expect(removeRoomySyncMarker(null)).toBeNull();
  });

  it("should return original topic if no marker present", () => {
    const topic = "General discussion channel";
    const result = removeRoomySyncMarker(topic);
    expect(result).toEqual("General discussion channel");
  });

  it("should handle spaces before marker", () => {
    // The function includes an optional space before the marker in the regex
    const topic = `General [Synced from Roomy: ${VALID_ULID}]`;
    const result = removeRoomySyncMarker(topic);
    expect(result).toEqual("General");
  });

  it("should remove multiple markers if present", () => {
    const topic = `[Synced from Roomy: ${VALID_ULID}] [Synced from Roomy: ${ANOTHER_ULID}]`;
    const result = removeRoomySyncMarker(topic);
    expect(result).toEqual("");
  });

  it("should return empty string for empty input", () => {
    expect(removeRoomySyncMarker("")).toBeNull();
  });
});

describe("Integration: Round-trip operations", () => {
  it("should be able to add and extract the same ULID", () => {
    const originalTopic = "General discussion";
    const withMarker = addRoomySyncMarker(originalTopic, VALID_ULID);
    expect(extractRoomyRoomId(withMarker)).toEqual(VALID_ULID);
  });

  it("should be able to add, detect, and remove marker", () => {
    const originalTopic = "Engineering";
    const withMarker = addRoomySyncMarker(originalTopic, VALID_ULID);
    expect(isRoomySyncedChannel(withMarker)).toBe(true);

    const withoutMarker = removeRoomySyncMarker(withMarker);
    expect(isRoomySyncedChannel(withoutMarker)).toBe(false);
  });

  it("should preserve original content when removing marker", () => {
    const originalTopic = "Welcome to the channel!";
    const withMarker = addRoomySyncMarker(originalTopic, VALID_ULID);
    const withoutMarker = removeRoomySyncMarker(withMarker);
    expect(withoutMarker).toEqual("Welcome to the channel!");
  });
});
