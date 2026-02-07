/**
 * Tests for message utility functions.
 * These functions are pure and deterministic, making them easy to test.
 */

import { describe, it, expect } from "vitest";
import { decodeMessageBody } from "../../src/utils/message";
import type { Event } from "@roomy/sdk";

describe("decodeMessageBody", () => {
  it("should decode Uint8Array data to string", () => {
    const event = {
      body: {
        data: new TextEncoder().encode("Hello, world!"),
      },
    } as Event;
    expect(decodeMessageBody(event)).toEqual("Hello, world!");
  });

  it("should decode base64-encoded data", () => {
    const event = {
      body: {
        data: { $bytes: btoa("Hello, world!") },
      },
    } as Event;
    expect(decodeMessageBody(event)).toEqual("Hello, world!");
  });

  it("should return empty string for missing data", () => {
    const event = {} as Event;
    expect(decodeMessageBody(event)).toEqual("");
  });

  it("should return empty string for null data", () => {
    const event = {
      body: {},
    } as Event;
    expect(decodeMessageBody(event)).toEqual("");
  });

  it("should handle empty Uint8Array", () => {
    const event = {
      body: {
        data: new Uint8Array(),
      },
    } as Event;
    expect(decodeMessageBody(event)).toEqual("");
  });

  it("should handle Unicode characters in Uint8Array", () => {
    const text = "Hello 🌍 世界!";
    const event = {
      body: {
        data: new TextEncoder().encode(text),
      },
    } as Event;
    expect(decodeMessageBody(event)).toEqual(text);
  });

  it("should handle Unicode characters in base64 (UTF-8 encoded)", () => {
    // The base64 in $bytes should be UTF-8 encoded
    const text = "Hello 🌍 世界!";
    const encoder = new TextEncoder();
    const uint8Array = encoder.encode(text);
    // Convert to binary string for btoa
    const binaryString = Array.from(uint8Array, byte => String.fromCharCode(byte)).join('');
    const base64 = btoa(binaryString);
    const event = {
      body: {
        data: { $bytes: base64 },
      },
    } as Event;
    expect(decodeMessageBody(event)).toEqual(text);
  });

  it("should handle newlines and special characters", () => {
    const text = "Line 1\nLine 2\tTabbed\rCarriage return";
    const event = {
      body: {
        data: new TextEncoder().encode(text),
      },
    } as Event;
    expect(decodeMessageBody(event)).toEqual(text);
  });
});
