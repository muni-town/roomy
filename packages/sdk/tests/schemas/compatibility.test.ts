/**
 * Compatibility test for `src/schemas/`.
 *
 * For each schema family, parses a representative example shaped like the
 * appserver's actual response (or WS frame body). The schemas are the source
 * of truth, and these fixtures exercise the nullable fields that the
 * appserver returns in practice (vs. the playground's hand-authored types,
 * which were too narrow in places — see the per-schema file comments).
 */
import { describe, expect, it } from "vitest";
import { type } from "arktype";
import { queries, procedures, frames } from "../../src/schemas/index.ts";

function assertOk<T>(result: T | type.errors): asserts result is T {
  if (result instanceof type.errors) {
    throw new Error(result.summary);
  }
}

describe("schemas/queries", () => {
  it("getSpaces parses a representative response", () => {
    const ex = {
      spaces: [
        {
          id: "01H000000000000000000000XX",
          name: "Roomy Dev",
          unreadCount: 0,
          unreadRoomCount: 0,
          isMember: true,
          isAdmin: false,
          roleIds: [],
        },
      ],
    };
    const parsed = queries.getSpaces.Response(ex);
    assertOk(parsed);
    expect(parsed.spaces[0]?.id).toBe(ex.spaces[0]!.id);
  });

  it("getSpaceMetadata parses a response with null sidebar category id and null channel name", () => {
    const ex = {
      joinPolicy: { allowPublicJoin: true, allowMemberInvites: false },
      isMember: true,
      isAdmin: false,
      unreadRoomCount: 0,
      unreadThreadCount: 0,
      sidebar: {
        categories: [
          {
            // v0 legacy categories — appserver omits id
            name: "General",
            position: 0,
            channels: [
              {
                id: "01CH0000000000000000000000",
                // info row may be missing — field omitted
                defaultAccess: "readwrite",
                canRead: true,
                canWrite: true,
                unreadCount: 0,
              },
            ],
          },
        ],
        orphans: [],
      },
    };
    const parsed = queries.getSpaceMetadata.Response(ex);
    assertOk(parsed);
    expect(parsed.sidebar.categories[0]?.channels[0]?.defaultAccess).toBe(
      "readwrite",
    );
  });

  it("getSpaceThreads parses a response with null timestamp", () => {
    const ex = {
      rooms: [
        {
          id: "01T0000000000000000000000X",
          kind: "thread",
          channel: "01CH00000000000000000000X0",
          activity: {
            latestMembers: [],
          },
        },
        {
          id: "01C0000000000000000000000X",
          kind: "channel",
          activity: {
            latestMembers: [],
          },
        },
      ],
    };
    const parsed = queries.getSpaceThreads.Response(ex);
    assertOk(parsed);
  });

  it("getRoles parses a response", () => {
    const ex = {
      roles: [
        {
          id: "01R000000000000000000000XX",
          name: "Mods",
          rooms: [{ roomId: "01CH0000000000000000000000", permission: "readwrite" }],
          memberDids: ["did:plc:abcdef"],
        },
      ],
    };
    const parsed = queries.getRoles.Response(ex);
    assertOk(parsed);
  });

  it("getMembers parses a response with externalAdmins", () => {
    const ex = {
      members: [
        {
          did: "did:plc:abcdef",
          handle: "alice.bsky.social",
          name: "Alice",
          isAdmin: true,
          isBanned: false,
          roleIds: ["01R000000000000000000000XX"],
        },
      ],
      externalAdmins: [
        {
          did: "did:plc:ghijkl",
        },
      ],
    };
    const parsed = queries.getMembers.Response(ex);
    assertOk(parsed);
  });

  it("getInvites parses a response", () => {
    const ex = {
      invites: [
        { token: "abc123", createdBy: "did:plc:abcdef", eventUlid: "01E0000000000000000000000X" },
      ],
    };
    const parsed = queries.getInvites.Response(ex);
    assertOk(parsed);
  });

  it("getRoomMetadata parses a response with recentThreads", () => {
    const ex = {
      name: "general",
      kind: "channel",
      spaceId: "01S000000000000000000000XX",
      defaultAccess: "readwrite",
      canRead: true,
      canWrite: true,
      lastRead: "2026-05-17T00:00:00.000Z",
      unreadCount: 3,
      unreadThreadCount: 0,
      recentThreads: [
        {
          id: "01T0000000000000000000000X",
          canRead: true,
          canWrite: true,
          unreadCount: 0,
        },
      ],
    };
    const parsed = queries.getRoomMetadata.Response(ex);
    assertOk(parsed);
  });

  it("getRoomThreads parses a response", () => {
    const ex = {
      threads: [
        {
          id: "01T0000000000000000000000X",
          name: "thread",
          canonicalParent: "01CH0000000000000000000000",
          activity: { latestMembers: [] },
        },
      ],
    };
    const parsed = queries.getRoomThreads.Response(ex);
    assertOk(parsed);
  });

  it("getMessages parses a response with a fully-populated message", () => {
    const ex = {
      messages: [
        {
          id: "01M000000000000000000000XX",
          content: "hi",
          authorDid: "did:plc:abcdef",
          authorName: "alice",
          timestamp: "2026-05-17T00:00:00.000Z",
          reactions: [{ emoji: "👍", count: 1, dids: ["did:plc:abcdef"] }],
          media: [{ url: "https://x/y.png", type: "image/png" }],
          linkEmbeds: [],
          tags: [],
        },
      ],
    };
    const parsed = queries.getMessages.Response(ex);
    assertOk(parsed);
    expect(parsed.messages.length).toBe(1);
  });

  it("getMessage parses a single MessageDto (top-level)", () => {
    const ex = {
      id: "01M000000000000000000000XX",
      content: "hi",
      authorDid: "did:plc:abcdef",
      authorName: "alice",
      timestamp: "2026-05-17T00:00:00.000Z",
      forwardedFrom: { messageId: "01M000000000000000000000XX", name: "other-room", roomId: "01CH0000000000000000000000" },
      reactions: [],
      media: [],
      linkEmbeds: [],
      tags: [],
    };
    const parsed = queries.getMessage.Response(ex);
    assertOk(parsed);
  });

  it("getMessage parses a forward with a nested denormalised original (recursive)", () => {
    const ex = {
      id: "01M000000000000000000000F1",
      content: "my take on this",
      authorDid: "did:plc:forwarder",
      authorName: "bob",
      timestamp: "2026-05-17T00:01:00.000Z",
      forwardedFrom: {
        messageId: "01M000000000000000000000F0",
        name: "General",
        roomId: "01CH0000000000000000000000",
        message: {
          id: "01M000000000000000000000F0",
          content: "original body",
          authorDid: "did:plc:abcdef",
          authorName: "alice",
          timestamp: "2026-05-17T00:00:00.000Z",
          reactions: [],
          media: [],
          linkEmbeds: [],
        },
      },
      reactions: [],
      media: [],
      linkEmbeds: [],
    };
    const parsed = queries.getMessage.Response(ex);
    assertOk(parsed);
    // The nested original is fully typed and readable.
    expect(parsed.forwardedFrom?.message?.content).toBe("original body");
    expect(parsed.forwardedFrom?.message?.authorDid).toBe("did:plc:abcdef");
    // A forward's original may itself be a forward (nested chain).
    const deep = {
      id: "01M000000000000000000000F2",
      content: "",
      authorDid: "did:plc:carol",
      authorName: "carol",
      timestamp: "2026-05-17T00:02:00.000Z",
      forwardedFrom: {
        messageId: "01M000000000000000000000F1",
        name: "Other",
        roomId: "01CH0000000000000000000001",
        message: ex,
      },
      reactions: [],
      media: [],
      linkEmbeds: [],
    };
    const deepParsed = queries.getMessage.Response(deep);
    assertOk(deepParsed);
    expect(deepParsed.forwardedFrom?.message?.forwardedFrom?.message?.content).toBe(
      "original body",
    );
  });
});

describe("schemas/procedures", () => {
  it("getConnectionTicket parses an output", () => {
    const parsed = procedures.getConnectionTicket.Output({ ticket: "tk_abc" });
    assertOk(parsed);
    expect(parsed.ticket).toBe("tk_abc");
  });

  it("updateSeen parses input with and without seenUpTo", () => {
    const a = procedures.updateSeen.Input({ roomId: "01CH0000000000000000000000" });
    assertOk(a);
    const b = procedures.updateSeen.Input({
      roomId: "01CH0000000000000000000000",
      seenUpTo: "01M000000000000000000000XX",
    });
    assertOk(b);
    // Void output: empty wire body.
    const out = procedures.updateSeen.Output({});
    assertOk(out);
  });
});

describe("schemas/frames", () => {
  it("messageDiff parses a body with add / update / remove ops", () => {
    const msg = {
      id: "01M000000000000000000000XX",
      content: "hi",
      authorDid: "did:plc:abcdef",
      authorName: "alice",
      timestamp: "2026-05-17T00:00:00.000Z",
      reactions: [],
      media: [],
      linkEmbeds: [],
      tags: [],
    };
    const body = {
      roomId: "01CH0000000000000000000000",
      seq: 42,
      ops: [
        { op: "add", key: msg.id, message: msg },
        { op: "update", key: msg.id, message: msg },
        { op: "remove", key: msg.id },
      ],
    };
    const parsed = frames.messageDiff.Body(body);
    assertOk(parsed);
    expect(parsed.ops.length).toBe(3);
  });

  it("invalidate parses a body for getMetadata", () => {
    const parsed = frames.invalidate.Body({
      nsid: "space.roomy.space.getMetadata",
      params: { spaceId: "01S000000000000000000000XX" },
    });
    assertOk(parsed);
  });

  it("invalidate parses a body with empty params (getSpaces)", () => {
    const parsed = frames.invalidate.Body({
      nsid: "space.roomy.space.getSpaces",
      params: {},
    });
    assertOk(parsed);
  });

  it("error frame parses", () => {
    const parsed = frames.errorFrame.Body({
      error: "TokenExpired",
      message: "Ticket expired",
    });
    assertOk(parsed);
  });

  it("clientMessage parses sub / unsub / cursor", () => {
    const sub = frames.clientMessage.ClientMessage({
      type: "sub",
      topic: "room",
      id: "01CH0000000000000000000000",
    });
    assertOk(sub);
    const unsub = frames.clientMessage.ClientMessage({
      type: "unsub",
      topic: "space",
      id: "01S000000000000000000000XX",
    });
    assertOk(unsub);
    const cursor = frames.clientMessage.ClientMessage({ type: "cursor", seq: 0 });
    assertOk(cursor);
  });
});
