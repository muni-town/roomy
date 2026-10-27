/**
 * The link card's choice between a tile and the metadata the page served.
 *
 * The failure this defends: the tile is loaded at render time from a
 * third-party loading server and the publisher's PDS. Either being down must
 * degrade to the OpenGraph card the same embed already carries, not to an error
 * where a card belongs.
 */

import { describe, expect, it } from "vitest";

import { chooseLinkCard, hasMetadata } from "./link-card.js";

const TILE = { url: "at://did:plc:abc/ing.dasl.masl/3tile", data: { post: { text: "hi" } } };
const METADATA = { t: "A title", d: "A description" };

describe("chooseLinkCard", () => {
  it("draws the tile when the embed carries one and nothing has failed", () => {
    const card = chooseLinkCard({ ...METADATA, tile: TILE }, {
      tileAllowed: true,
      tileFailed: false,
    });
    expect(card.tile).toBe(TILE);
    expect(card.hasMetadata).toBe(true);
  });

  it("falls back to a tile-less card when the flag is off", () => {
    const card = chooseLinkCard({ ...METADATA, tile: TILE }, {
      tileAllowed: false,
      tileFailed: false,
    });
    expect(card.tile).toBeUndefined();
    expect(card.hasMetadata).toBe(true);
  });

  it("falls back to the metadata when the tile failed to load", () => {
    // The case that makes this a fallback rather than a preference: the tile
    // exists in the embed, but its manifest could not be read.
    const card = chooseLinkCard({ ...METADATA, tile: TILE }, {
      tileAllowed: true,
      tileFailed: true,
    });
    expect(card.tile).toBeUndefined();
    expect(card.hasMetadata).toBe(true);
  });

  it("has no tile to draw for an embed that carries none", () => {
    expect(
      chooseLinkCard(METADATA, { tileAllowed: true, tileFailed: false }).tile,
    ).toBeUndefined();
    expect(chooseLinkCard(null, { tileAllowed: true, tileFailed: false })).toEqual({
      tile: undefined,
      hasMetadata: false,
    });
  });
});

describe("hasMetadata", () => {
  it("counts every field the OpenGraph card can draw", () => {
    expect(hasMetadata({ t: "title" })).toBe(true);
    expect(hasMetadata({ d: "description" })).toBe(true);
    expect(hasMetadata({ p: { n: "provider" } })).toBe(true);
    expect(hasMetadata({ au: { n: "author" } })).toBe(true);
    expect(hasMetadata({ footer: { t: "footer" } })).toBe(true);
    expect(hasMetadata({ imgs: [{}] })).toBe(true);
    expect(hasMetadata({ vid: {} })).toBe(true);
    expect(hasMetadata({ thumb: {} })).toBe(true);
  });

  it("does not count a tile as metadata — a tile is the other card", () => {
    // Otherwise a tile that failed would look like a metadata card with
    // nothing in it, and the reader would get an empty box.
    expect(hasMetadata({ tile: TILE })).toBe(false);
    expect(hasMetadata({})).toBe(false);
    expect(hasMetadata({ imgs: [] })).toBe(false);
  });
});
