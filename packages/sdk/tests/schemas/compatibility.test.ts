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
          avatar: null,
          description: null,
          unreadCount: 0,
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
      name: "Space",
      avatar: null,
      description: null,
      joinPolicy: { allowPublicJoin: true, allowMemberInvites: false },
      isMember: true,
      isAdmin: false,
      sidebar: {
        categories: [
          {
            id: null, // v0 legacy categories — appserver returns null
            name: "General",
            position: 0,
            channels: [
              {
                id: "01CH0000000000000000000000",
                name: null, // info row may be missing
                defaultAccess: "readwrite",
                canRead: true,
                canWrite: true,
                unreadCount: 0,
                lastRead: null,
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
      threads: [
        {
          id: "01T0000000000000000000000X",
          name: null,
          channel: "01CH00000000000000000000X0",
          activity: {
            latestTimestamp: null,
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
          avatar: null,
          description: null,
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
          avatar: null,
          isAdmin: true,
          roleIds: ["01R000000000000000000000XX"],
        },
      ],
      externalAdmins: [
        {
          did: "did:plc:ghijkl",
          handle: null,
          name: null,
          avatar: null,
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
      recentThreads: [
        {
          id: "01T0000000000000000000000X",
          name: null,
          canRead: true,
          canWrite: true,
          unreadCount: 0,
          lastRead: null,
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
          activity: { latestTimestamp: null, latestMembers: [] },
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
          authorAvatar: null,
          timestamp: "2026-05-17T00:00:00.000Z",
          replyTo: null,
          forwardedFrom: null,
          reactions: [{ emoji: "👍", dids: ["did:plc:abcdef"], myReactionId: null }],
          media: [{ url: "https://x/y.png", type: "image/png", alt: null }],
          tags: [],
        },
      ],
      cursor: null,
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
      authorAvatar: null,
      timestamp: "2026-05-17T00:00:00.000Z",
      replyTo: null,
      forwardedFrom: { name: "other-room", roomId: "01CH0000000000000000000000" },
      reactions: [],
      media: [],
      tags: [],
    };
    const parsed = queries.getMessage.Response(ex);
    assertOk(parsed);
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
      authorAvatar: null,
      timestamp: "2026-05-17T00:00:00.000Z",
      replyTo: null,
      forwardedFrom: null,
      reactions: [],
      media: [],
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
