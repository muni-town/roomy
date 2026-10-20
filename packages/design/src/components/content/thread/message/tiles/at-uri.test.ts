/**
 * Tests for tile-address recognition.
 *
 * The module is pure — no DOM, no build env — so no browser stub is needed.
 */

import { describe, it, expect } from "vitest";

import { parseTileAddress } from "./at-uri.js";

/** Two tiles published on AT, used because they are the addresses that exist. */
const MINESWEEPER = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3mcjwwoqjqs2v";
const HELLO = "at://did:plc:izttpdp3l6vss5crelt5kcux/ing.dasl.masl/3meggnybzqs2n";

describe("parseTileAddress — published tiles", () => {
  it("reads the repo and record key out of a tile address", () => {
    expect(parseTileAddress(MINESWEEPER)).toEqual({
      did: "did:plc:izttpdp3l6vss5crelt5kcux",
      rkey: "3mcjwwoqjqs2v",
    });
  });

  it("accepts a second address from the same repo", () => {
    expect(parseTileAddress(HELLO)).toEqual({
      did: "did:plc:izttpdp3l6vss5crelt5kcux",
      rkey: "3meggnybzqs2n",
    });
  });
});

describe("parseTileAddress — not a tile address", () => {
  it("anything that is not an at:// URI", () => {
    for (const value of [
      "",
      HELLO.slice("at://".length),
      "https://example.com/tile",
      "http://did:plc:abc/ing.dasl.masl/3abc",
      "at:/did:plc:abc/ing.dasl.masl/3abc",
      "at:did:plc:abc/ing.dasl.masl/3abc",
    ]) {
      expect(parseTileAddress(value), value).toBe(null);
    }
  });

  it("a repository the loader cannot resolve to a PDS", () => {
    expect(
      parseTileAddress("at://did:web:example.com/ing.dasl.masl/3abc"),
    ).toBe(null);
    // A did:plc body is base32 lowercase; a handle is not a DID at all.
    expect(parseTileAddress("at://did:plc:ABCDEF/ing.dasl.masl/3abc")).toBe(null);
    expect(parseTileAddress("at://alice.bsky.social/ing.dasl.masl/3abc")).toBe(null);
  });

  it("a record in some other collection", () => {
    expect(
      parseTileAddress("at://did:plc:abc/app.bsky.feed.post/3abc"),
    ).toBe(null);
    expect(parseTileAddress("at://did:plc:abc/ing.dasl.masl.app/3abc")).toBe(null);
  });

  it("a path that is not exactly repo, collection and key", () => {
    for (const value of [
      "at://did:plc:abc",
      "at://did:plc:abc/",
      "at://did:plc:abc/ing.dasl.masl",
      "at://did:plc:abc/ing.dasl.masl/",
      "at://did:plc:abc/ing.dasl.masl/3abc/",
      "at://did:plc:abc/ing.dasl.masl/3abc/extra",
    ]) {
      expect(parseTileAddress(value), value).toBe(null);
    }
  });

  it("a query or fragment, which is not part of a record address", () => {
    expect(parseTileAddress(`${HELLO}?foo=1`)).toBe(null);
    expect(parseTileAddress(`${HELLO}#top`)).toBe(null);
  });

  it("a record key outside the allowed character set", () => {
    for (const value of [
      "at://did:plc:abc/ing.dasl.masl/3abc%20x",
      "at://did:plc:abc/ing.dasl.masl/a b",
      "at://did:plc:abc/ing.dasl.masl/3abc$",
    ]) {
      expect(parseTileAddress(value), value).toBe(null);
    }
  });
});
