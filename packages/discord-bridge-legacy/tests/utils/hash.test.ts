/**
 * Tests for hash utility functions.
 * These functions are pure and deterministic, making them easy to test.
 */

import { describe, it, expect } from "vitest";
import {
  fingerprint,
  computeProfileHash,
  computeSidebarHash,
  computeEditHash,
} from "../../src/utils/hash";

describe("fingerprint", () => {
  it("should produce consistent hashes for identical input", () => {
    const result1 = fingerprint("test-input");
    const result2 = fingerprint("test-input");
    expect(result1).toEqual(result2);
    expect(result1).toHaveLength(32);
  });

  it("should produce different hashes for different input", () => {
    expect(fingerprint("input-a")).not.toEqual(fingerprint("input-b"));
  });

  it("should be deterministic", () => {
    const knownHash = fingerprint("hello-world");
    expect(knownHash).toEqual("afa27b44d43b02a9fea41d13cedc2e40");
  });

  it("should handle empty strings", () => {
    expect(fingerprint("")).toHaveLength(32);
  });

  it("should handle special characters", () => {
    expect(fingerprint("hello 🌍")).toHaveLength(32);
    expect(fingerprint("\n\t\r")).toHaveLength(32);
  });
});

describe("computeProfileHash", () => {
  it("should compute consistent hashes for same profile", () => {
    const hash1 = computeProfileHash("user123", "Display Name", "abc123");
    const hash2 = computeProfileHash("user123", "Display Name", "abc123");
    expect(hash1).toEqual(hash2);
  });

  it("should treat null globalName and avatar as empty strings", () => {
    const hash1 = computeProfileHash("user123", null, null);
    const hash2 = computeProfileHash("user123", "", "");
    expect(hash1).toEqual(hash2);
  });

  it("should detect changes in username", () => {
    const hash1 = computeProfileHash("user123", "Display Name", "abc123");
    const hash2 = computeProfileHash("user456", "Display Name", "abc123");
    expect(hash1).not.toEqual(hash2);
  });

  it("should detect changes in globalName", () => {
    const hash1 = computeProfileHash("user123", "Display Name", "abc123");
    const hash2 = computeProfileHash("user123", "Different Name", "abc123");
    expect(hash1).not.toEqual(hash2);
  });

  it("should detect changes in avatar", () => {
    const hash1 = computeProfileHash("user123", "Display Name", "abc123");
    const hash2 = computeProfileHash("user123", "Display Name", "xyz789");
    expect(hash1).not.toEqual(hash2);
  });
});

describe("computeSidebarHash", () => {
  it("should compute consistent hashes for same sidebar", () => {
    const categories = [
      { name: "General", children: ["ulid1", "ulid2"] as any },
      { name: "Projects", children: ["ulid3"] as any },
    ];
    const hash1 = computeSidebarHash(categories);
    const hash2 = computeSidebarHash(categories);
    expect(hash1).toEqual(hash2);
  });

  it("should be order-independent (categories sorted by name)", () => {
    const categories1 = [
      { name: "Projects", children: ["ulid1"] as any },
      { name: "General", children: ["ulid2"] as any },
    ];
    const categories2 = [
      { name: "General", children: ["ulid2"] as any },
      { name: "Projects", children: ["ulid1"] as any },
    ];
    expect(computeSidebarHash(categories1)).toEqual(computeSidebarHash(categories2));
  });

  it("should be order-independent (children sorted by value)", () => {
    const categories1 = [
      { name: "General", children: ["ulid2", "ulid1"] as any },
    ];
    const categories2 = [
      { name: "General", children: ["ulid1", "ulid2"] as any },
    ];
    expect(computeSidebarHash(categories1)).toEqual(computeSidebarHash(categories2));
  });

  it("should detect changes in category names", () => {
    const categories1 = [
      { name: "General", children: ["ulid1"] as any },
    ];
    const categories2 = [
      { name: "Modified", children: ["ulid1"] as any },
    ];
    expect(computeSidebarHash(categories1)).not.toEqual(computeSidebarHash(categories2));
  });

  it("should detect changes in children", () => {
    const categories1 = [
      { name: "General", children: ["ulid1", "ulid2"] as any },
    ];
    const categories2 = [
      { name: "General", children: ["ulid1", "ulid3"] as any },
    ];
    expect(computeSidebarHash(categories1)).not.toEqual(computeSidebarHash(categories2));
  });

  it("should handle empty categories array", () => {
    expect(computeSidebarHash([])).toHaveLength(32);
  });
});

describe("computeEditHash", () => {
  it("should compute consistent hashes for same message", () => {
    const content = "Hello, world!";
    const attachments = [
      { url: "https://example.com/img1.png" },
      { url: "https://example.com/img2.png" },
    ];
    const hash1 = computeEditHash(content, attachments);
    const hash2 = computeEditHash(content, attachments);
    expect(hash1).toEqual(hash2);
  });

  it("should detect content changes", () => {
    const hash1 = computeEditHash("Hello", []);
    const hash2 = computeEditHash("Goodbye", []);
    expect(hash1).not.toEqual(hash2);
  });

  it("should be order-independent for attachments", () => {
    const attachments1 = [
      { url: "https://example.com/img2.png" },
      { url: "https://example.com/img1.png" },
    ];
    const attachments2 = [
      { url: "https://example.com/img1.png" },
      { url: "https://example.com/img2.png" },
    ];
    expect(computeEditHash("test", attachments1)).toEqual(computeEditHash("test", attachments2));
  });

  it("should detect attachment changes", () => {
    const hash1 = computeEditHash("test", [{ url: "https://example.com/img1.png" }]);
    const hash2 = computeEditHash("test", [{ url: "https://example.com/img2.png" }]);
    expect(hash1).not.toEqual(hash2);
  });

  it("should handle empty attachments", () => {
    expect(computeEditHash("test", [])).toHaveLength(32);
  });
});
