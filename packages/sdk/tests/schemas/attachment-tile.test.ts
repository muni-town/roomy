/**
 * A Web Tile attachment: the write schema and the rows it materialises.
 *
 * The `Attachment` union is closed — an unknown `$type` is a parse error, not
 * a passthrough — so these tests are what says a tile is part of the message
 * record format. They also pin the two halves of the row the read path relies
 * on: the entity key carries the message suffix, and `tile_uri` stays bare.
 */

import { describe, expect, it } from "vitest";
import { type } from "arktype";
import { CreateMessage, EditMessage } from "../../src/schema/events/message";
import {
  Attachments,
  MAX_TILE_DATA_BYTES,
} from "../../src/schema/extensions/message";

const STREAM = "did:web:space.test";
const USER = "did:plc:author";
const ROOM = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const MESSAGE = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const TILE = "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/ing.dasl.masl/3kabc";

/** The attachments extension, as a create carries it. */
function attachmentsExtension(attachments: unknown[]) {
  return {
    "space.roomy.extension.attachments.v0": {
      $type: "space.roomy.extension.attachments.v0" as const,
      attachments,
    },
  };
}

describe("space.roomy.attachment.tile.v0 schema", () => {
  it("parses a tile attachment inside an attachments extension", () => {
    const parsed = Attachments({
      $type: "space.roomy.extension.attachments.v0",
      attachments: [{ $type: "space.roomy.attachment.tile.v0", uri: TILE, data: { count: 3 } }],
    });
    if (parsed instanceof type.errors) throw new Error(parsed.summary);

    expect(parsed.attachments[0]).toMatchObject({
      $type: "space.roomy.attachment.tile.v0",
      uri: TILE,
      data: { count: 3 },
    });
  });

  it("parses a tile attachment with no payload", () => {
    const parsed = Attachments({
      $type: "space.roomy.extension.attachments.v0",
      attachments: [{ $type: "space.roomy.attachment.tile.v0", uri: TILE }],
    });
    expect(parsed instanceof type.errors).toBe(false);
  });

  it("rejects an unknown attachment $type", () => {
    const parsed = Attachments({
      $type: "space.roomy.extension.attachments.v0",
      attachments: [{ $type: "space.roomy.attachment.tile.v1", uri: TILE }],
    });
    expect(parsed instanceof type.errors).toBe(true);
  });

  it("rejects a tile attachment with no uri", () => {
    const parsed = Attachments({
      $type: "space.roomy.extension.attachments.v0",
      attachments: [{ $type: "space.roomy.attachment.tile.v0" }],
    });
    expect(parsed instanceof type.errors).toBe(true);
  });

  it("rejects an address that is not a tile record", () => {
    for (const uri of [
      // The wrong collection.
      "at://did:plc:ewvi7nxzyoun6zhxrhs64oiz/space.roomy.tile/3kabc",
      // The right collection, but not a record address: a query or a fragment.
      `${TILE}?message=01ARZ3NDEKTSV4RRFFQ69G5FAW`,
      `${TILE}#frag`,
      // A repository the loader cannot resolve: it has no `did:web` arm.
      "at://did:web:tiles.example/ing.dasl.masl/3kabc",
      // Not an address at all.
      "https://example.com/tile",
    ]) {
      const parsed = Attachments({
        $type: "space.roomy.extension.attachments.v0",
        attachments: [{ $type: "space.roomy.attachment.tile.v0", uri }],
      });
      expect([uri, parsed instanceof type.errors]).toEqual([uri, true]);
    }
  });

  it("accepts a payload at the 8 KiB bound and rejects one byte past it", () => {
    // `JSON.stringify` wraps a string in two quotes, so this is the exact
    // number of bytes the record would carry.
    const atBound = "x".repeat(MAX_TILE_DATA_BYTES - 2);
    const overBound = "x".repeat(MAX_TILE_DATA_BYTES - 1);

    const accepted = Attachments({
      $type: "space.roomy.extension.attachments.v0",
      attachments: [
        { $type: "space.roomy.attachment.tile.v0", uri: TILE, data: atBound },
      ],
    });
    expect(accepted instanceof type.errors).toBe(false);

    const refused = Attachments({
      $type: "space.roomy.extension.attachments.v0",
      attachments: [
        { $type: "space.roomy.attachment.tile.v0", uri: TILE, data: overBound },
      ],
    });
    expect(refused instanceof type.errors).toBe(true);
  });

  it("counts the payload's serialised bytes, not its character count", () => {
    // 4096 three-byte characters serialise to 12288 bytes.
    const parsed = Attachments({
      $type: "space.roomy.extension.attachments.v0",
      attachments: [
        { $type: "space.roomy.attachment.tile.v0", uri: TILE, data: "…".repeat(4096) },
      ],
    });
    expect(parsed instanceof type.errors).toBe(true);
  });
});

describe("message events carrying a tile", () => {
  it("parses a createMessage event", () => {
    const parsed = CreateMessage.schema({
      $type: "space.roomy.message.createMessage.v0",
      room: ROOM,
      body: { mimeType: "text/markdown", data: { $bytes: "aGVsbG8=" } },
      extensions: attachmentsExtension([
        { $type: "space.roomy.attachment.tile.v0", uri: TILE, data: { rows: [1, 2] } },
      ]),
    });
    if (parsed instanceof type.errors) throw new Error(parsed.summary);

    expect(
      parsed.extensions["space.roomy.extension.attachments.v0"]?.attachments[0],
    ).toMatchObject({ $type: "space.roomy.attachment.tile.v0", uri: TILE });
  });

  it("parses an editMessage event", () => {
    const parsed = EditMessage.schema({
      $type: "space.roomy.message.editMessage.v0",
      room: ROOM,
      messageId: MESSAGE,
      body: { mimeType: "text/markdown", data: { $bytes: "aGVsbG8=" } },
      extensions: attachmentsExtension([
        { $type: "space.roomy.attachment.tile.v0", uri: TILE },
      ]),
    });
    expect(parsed instanceof type.errors).toBe(false);
  });
});

describe("materialising a tile attachment", () => {
  it("writes a comp_embed_tile row on create, with the bare URI and JSON payload", () => {
    const statements = CreateMessage.materialize({
      streamId: STREAM,
      user: USER,
      event: {
        $type: "space.roomy.message.createMessage.v0",
        id: MESSAGE,
        room: ROOM,
        body: { mimeType: "text/markdown", data: { buf: new Uint8Array() } },
        extensions: attachmentsExtension([
          {
            $type: "space.roomy.attachment.tile.v0",
            uri: TILE,
            data: { title: "hi", n: 2 },
          },
        ]),
      },
    });

    const insert = statements.find((s) =>
      s.sql.includes("insert or replace into comp_embed_tile"),
    );
    expect(insert).toBeDefined();
    // The entity key carries the message suffix; `tile_uri` does not, because
    // the read path hands it straight to the client's address parser.
    expect(insert!.params).toEqual([
      `${TILE}?message=${MESSAGE}`,
      TILE,
      JSON.stringify({ title: "hi", n: 2 }),
    ]);

    const entity = statements.find(
      (s) => s.sql.includes("insert into entities") && s.params?.[0] === `${TILE}?message=${MESSAGE}`,
    );
    expect(entity).toBeDefined();
    // The entity is scoped to the message, like every other embed row's.
    expect(entity!.params?.[2]).toBe(MESSAGE);
  });

  it("stores a null payload when the attachment carried none", () => {
    const statements = CreateMessage.materialize({
      streamId: STREAM,
      user: USER,
      event: {
        $type: "space.roomy.message.createMessage.v0",
        id: MESSAGE,
        room: ROOM,
        body: { mimeType: "text/markdown", data: { buf: new Uint8Array() } },
        extensions: attachmentsExtension([
          { $type: "space.roomy.attachment.tile.v0", uri: TILE },
        ]),
      },
    });

    const insert = statements.find((s) =>
      s.sql.includes("insert or replace into comp_embed_tile"),
    );
    expect(insert!.params).toEqual([`${TILE}?message=${MESSAGE}`, TILE, null]);
  });

  it("replaces a tile row on edit", () => {
    const statements = EditMessage.materialize({
      streamId: STREAM,
      user: USER,
      event: {
        $type: "space.roomy.message.editMessage.v0",
        id: "01ARZ3NDEKTSV4RRFFQ69G5FAX",
        room: ROOM,
        messageId: MESSAGE,
        body: { mimeType: "text/markdown", data: { buf: new Uint8Array() } },
        extensions: attachmentsExtension([
          { $type: "space.roomy.attachment.tile.v0", uri: TILE, data: [1] },
        ]),
      },
    });

    // The wholesale-replace branch clears the old rows first — a tile left out
    // of that list would survive an edit that replaced it with anything else.
    expect(
      statements.some((s) => s.sql.includes("delete from comp_embed_tile")),
    ).toBe(true);

    const insert = statements.find((s) =>
      s.sql.includes("insert or replace into comp_embed_tile"),
    );
    expect(insert!.params).toEqual([
      `${TILE}?message=${MESSAGE}`,
      TILE,
      JSON.stringify([1]),
    ]);
  });
});
