/**
 * HTTP E2E — full channel-federation chain.
 *
 * Boots a real appserver (test-mode auth) with two spaces A (origin) and B
 * (receiving), then drives the entire flow over XRPC:
 *
 *   request → approve → origin grant → receiver grant → federated read → federated write
 *
 * This is the integration test the Phase 5 plan calls for: it proves the
 * cross-space access, global-DB registry, and materialization all line up
 * through the real HTTP transport (not direct DB pokes).
 */

import { describe, expect, test, beforeEach } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedRoom,
  seedJoinedSpace,
  seedUser,
  type E2eContext,
} from "./helpers.ts";

const A = "did:web:fed-a.example"; // origin space A
const B = "did:web:fed-b.example"; // receiving space B
const ADMIN_A = "did:plc:admin-a";
const ADMIN_B = "did:plc:admin-b";
const MEMBER_B = "did:plc:member-b"; // B member granted federated access
const MEMBER_C = "did:plc:member-c"; // B member NOT granted federated access
const CHANNEL = newUlid();

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("channel federation — full HTTP E2E chain", () => {
  let ctx: E2eContext;

  beforeEach(async () => {
    ctx = await startAppserver();
    const { db } = ctx;

    // Space A (origin): ADMIN_A is admin; ADMIN_B is a member (the federation
    // precondition). A private space (no public join).
    seedSpace(db, A, ADMIN_A);
    seedSpace(db, A, ADMIN_B);
    // Space B (receiving): ADMIN_B is admin; MEMBER_B/MEMBER_C are members.
    seedSpace(db, B, ADMIN_B);
    seedSpace(db, B, MEMBER_B);
    seedSpace(db, B, MEMBER_C);
    // Admin edges (head=spaceId, tail=did, label='admin').
    (db as any).forSpace(A).run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
      [A, ADMIN_A],
    );
    (db as any).forSpace(B).run(
      "insert or ignore into edges (head, tail, label) values (?, ?, 'admin')",
      [B, ADMIN_B],
    );
    // Global membership (joinedSpace) so federatedRoomAccess detects B as a
    // home space for ADMIN_B / MEMBER_B.
    seedJoinedSpace(db, ADMIN_B, B);
    seedJoinedSpace(db, MEMBER_B, B);
    // ADMIN_B's global profile (the requester) so getRequests can resolve
    // the display name + handle instead of exposing the raw DID.
    seedUser(db, ADMIN_B, "admin-b.example");
    (db as any).global().run(
      "update profiles set name = ? where did = ?",
      ["Admin Bee", ADMIN_B],
    );
    seedJoinedSpace(db, MEMBER_C, B);
    // A private channel in A: default_access 'none' so B can only access it
    // through federation, never natively.
    seedRoom(db, CHANNEL, A);
    (db as any).forSpace(A).run(
      "update comp_room set default_access = 'none' where entity = ?",
      [CHANNEL],
    );
  });

  const send = (did: string, spaceId: string, event: Record<string, unknown>) =>
    ctx.authedFetch(did)(`${ctx.baseUrl}/xrpc/space.roomy.space.sendEvents`, {
      method: "POST",
      body: JSON.stringify({ spaceId, events: [event] }),
    });

  test("full request → approve → grant → read → write chain", async () => {
    // 1. ADMIN_B (admin of B, member of A) submits a federation request on A.
    let res = await send(ADMIN_B, A, {
      id: newUlid(),
      $type: "space.roomy.federation.request.v0",
      federatingSpaceDid: B,
      message: "please federate",
    });
    expect(res.status).toBe(200);

    // 2. ADMIN_A sees the pending request.
    res = await ctx.authedFetch(ADMIN_A)(
      `${ctx.baseUrl}/xrpc/space.roomy.federation.getRequests?spaceId=${A}`,
    );
    expect(res.status).toBe(200);
    let body = await res.json();
    expect(body.requests[0].federatingSpaceDid).toBe(B);
    // The counterpart space's display name is resolved from B's per-space DB.
    expect(body.requests[0].federatingSpaceName).toBe("Test Space");
    // The requester's profile is resolved: display name + handle, not the DID.
    expect(body.requests[0].requestedByDid).toBe(ADMIN_B);
    expect(body.requests[0].requestedByName).toBe("Admin Bee");
    expect(body.requests[0].requestedByHandle).toBe("admin-b.example");


    // 3. ADMIN_A approves.
    res = await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.respond.v0",
      federatingSpaceDid: B,
      approve: true,
    });
    expect(res.status).toBe(200);

    // ADMIN_A's outgoing list shows the federation as active.
    res = await ctx.authedFetch(ADMIN_A)(
      `${ctx.baseUrl}/xrpc/space.roomy.federation.getOutgoing?spaceId=${A}`,
    );
    body = await res.json();
    expect(body.federations.some((f: { federatingSpaceDid: string; status: string }) =>
      f.federatingSpaceDid === B && f.status === "active",
    )).toBe(true);

    // 4. ADMIN_A grants origin readwrite on the channel.
    res = await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.setRoomPermission.v0",
      federatingSpaceDid: B,
      roomId: CHANNEL,
      permission: "readwrite",
    });
    expect(res.status).toBe(200);

    // 5. ADMIN_A's grants view shows the origin grant.
    res = await ctx.authedFetch(ADMIN_A)(
      `${ctx.baseUrl}/xrpc/space.roomy.federation.getGrants?spaceId=${A}`,
    );
    body = await res.json();
    expect(body.originGrants).toEqual([
      {
        federatingSpaceDid: B,
        federatingSpaceName: "Test Space",
        roomId: CHANNEL,
        permission: "readwrite",
      },
    ]);

    // The federated channel appears in B's sidebar decorated with the
    // origin space's display info (name + avatar from A's comp_info).
    res = await ctx.authedFetch(ADMIN_B)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${B}`,
    );
    expect(res.status).toBe(200);
    body = await res.json();
    const fedChannel = (body.sidebar.orphans ?? []).find(
      (ch: { id: string }) => ch.id === CHANNEL,
    );
    expect(fedChannel?.federated).toEqual({
      originSpaceId: A,
      originSpaceName: "Test Space",
      permission: "readwrite",
    });
    // No messages in the channel yet → no unread marker on the federated row
    // (the sidebar renders unreadCount > 0 as the unread dot).
    expect(fedChannel?.unreadCount).toBe(0);

    // 6. ADMIN_B configures a receiver grant for MEMBER_B (on B's stream).
    res = await send(ADMIN_B, B, {
      id: newUlid(),
      $type: "space.roomy.federation.setReceiverPermission.v0",
      originSpaceId: A,
      roomId: CHANNEL,
      grantee: MEMBER_B,
      kind: "user",
      permission: "readwrite",
    });
    expect(res.status).toBe(200);

    // 7. ADMIN_B's grants view shows the receiver grant.
    res = await ctx.authedFetch(ADMIN_B)(
      `${ctx.baseUrl}/xrpc/space.roomy.federation.getGrants?spaceId=${B}`,
    );
    body = await res.json();
    expect(body.receiverGrants).toEqual([
      {
        originSpaceId: A,
        originSpaceName: "Test Space",
        roomId: CHANNEL,
        grantee: MEMBER_B,
        kind: "user",
        permission: "readwrite",
      },
    ]);

    // 8. MEMBER_B can now READ the federated channel (federated access).
    res = await ctx.authedFetch(MEMBER_B)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMetadata?roomId=${CHANNEL}`,
    );
    expect(res.status).toBe(200);
    body = await res.json();
    expect(body.canRead).toBe(true);
    expect(body.canWrite).toBe(true);

    // 9. MEMBER_B can WRITE a message to the federated channel (on A's stream).
    res = await send(MEMBER_B, A, {
      id: newUlid(),
      $type: "space.roomy.message.createMessage.v0",
      room: CHANNEL,
      body: {
        mimeType: "text/plain",
        data: { $bytes: base64("hello from federated space B") },
      },
      extensions: {},
    });
    expect(res.status).toBe(200);

    // 10. MEMBER_B can read the message back via the federated channel.
    res = await ctx.authedFetch(MEMBER_B)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMessages?roomId=${CHANNEL}`,
    );
    expect(res.status).toBe(200);
    body = await res.json();
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages.length).toBeGreaterThanOrEqual(1);

    // 11. The federated channel follows native-channel unread semantics.
    // MEMBER_B's earlier getMetadata (step 8) lazily created her read
    // position at 0; the message at step 9 bumped it to 1 — so the
    // receiving space's sidebar now shows the unread dot for a federated
    // channel (the fix for "federated channels never show unreads").
    res = await ctx.authedFetch(MEMBER_B)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${B}`,
    );
    expect(res.status).toBe(200);
    body = await res.json();
    let fedAfterMsg = (body.sidebar.orphans ?? []).find(
      (ch: { id: string }) => ch.id === CHANNEL,
    );
    expect(fedAfterMsg?.unreadCount).toBeGreaterThan(0);

    // 12. Marking the federated room read clears the receiving-space
    // sidebar dot (updateSeen resolves federated access the same way reads
    // do, and invalidates B's metadata for this user).
    res = await ctx.authedFetch(MEMBER_B)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.updateSeen`,
      {
        method: "POST",
        body: JSON.stringify({ roomId: CHANNEL }),
      },
    );
    expect(res.status).toBe(200);

    res = await ctx.authedFetch(MEMBER_B)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${B}`,
    );
    expect(res.status).toBe(200);
    body = await res.json();
    fedAfterMsg = (body.sidebar.orphans ?? []).find(
      (ch: { id: string }) => ch.id === CHANNEL,
    );
    expect(fedAfterMsg?.unreadCount).toBe(0);
  });

  test("a federated channel placed in a category by reorder stays there", async () => {
    // Establish request → approve → origin grant.
    await send(ADMIN_B, A, {
      id: newUlid(),
      $type: "space.roomy.federation.request.v0",
      federatingSpaceDid: B,
    });
    await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.respond.v0",
      federatingSpaceDid: B,
      approve: true,
    });
    await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.setRoomPermission.v0",
      federatingSpaceDid: B,
      roomId: CHANNEL,
      permission: "readwrite",
    });

    // ADMIN_B drags the federated channel into a category (what the sidebar
    // edit mode writes on reorder).
    const categoryId = newUlid();
    let res = await send(ADMIN_B, B, {
      id: newUlid(),
      $type: "space.roomy.space.updateSidebar.v1",
      categories: [
        { id: categoryId, name: "Shared", children: [CHANNEL] },
      ],
    });
    expect(res.status).toBe(200);

    // The channel renders inside the category, not in orphans.
    res = await ctx.authedFetch(ADMIN_B)(
      `${ctx.baseUrl}/xrpc/space.roomy.space.getMetadata?spaceId=${B}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const cat = (body.sidebar.categories ?? []).find(
      (c: { id: string }) => c.id === categoryId,
    );
    expect(cat).toBeDefined();
    expect(cat.channels.map((ch: { id: string }) => ch.id)).toEqual([CHANNEL]);
    expect(cat.channels[0].federated).toEqual({
      originSpaceId: A,
      originSpaceName: "Test Space",
      permission: "readwrite",
    });
    expect(
      (body.sidebar.orphans ?? []).some((ch: { id: string }) => ch.id === CHANNEL),
    ).toBe(false);
  });

  test("a B member without a receiver grant is denied federated read", async () => {
    // Establish request → approve → origin grant (but no receiver grant for
    // MEMBER_C).
    await send(ADMIN_B, A, {
      id: newUlid(),
      $type: "space.roomy.federation.request.v0",
      federatingSpaceDid: B,
    });
    await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.respond.v0",
      federatingSpaceDid: B,
      approve: true,
    });
    await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.setRoomPermission.v0",
      federatingSpaceDid: B,
      roomId: CHANNEL,
      permission: "read",
    });

    const res = await ctx.authedFetch(MEMBER_C)(
      `${ctx.baseUrl}/xrpc/space.roomy.room.getMetadata?roomId=${CHANNEL}`,
    );
    expect(res.status).toBe(403);
  });

  test("a members-wide receiver grant grants every B member", async () => {
    // Request → approve → origin grant (readwrite ceiling).
    await send(ADMIN_B, A, {
      id: newUlid(),
      $type: "space.roomy.federation.request.v0",
      federatingSpaceDid: B,
    });
    await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.respond.v0",
      federatingSpaceDid: B,
      approve: true,
    });
    await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.setRoomPermission.v0",
      federatingSpaceDid: B,
      roomId: CHANNEL,
      permission: "readwrite",
    });

    // ADMIN_B grants readwrite to ALL of B's members via a single
    // kind='members' grant (grantee = B's space DID).
    let res = await send(ADMIN_B, B, {
      id: newUlid(),
      $type: "space.roomy.federation.setReceiverPermission.v0",
      originSpaceId: A,
      roomId: CHANNEL,
      grantee: B,
      kind: "members",
      permission: "readwrite",
    });
    expect(res.status).toBe(200);

    // MEMBER_B and MEMBER_C (neither individually granted) both get access.
    for (const member of [MEMBER_B, MEMBER_C]) {
      res = await ctx.authedFetch(member)(
        `${ctx.baseUrl}/xrpc/space.roomy.room.getMetadata?roomId=${CHANNEL}`,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.canRead).toBe(true);
      expect(body.canWrite).toBe(true);
    }

    // A member can WRITE through the members grant (on A's stream).
    res = await send(MEMBER_C, A, {
      id: newUlid(),
      $type: "space.roomy.message.createMessage.v0",
      room: CHANNEL,
      body: {
        mimeType: "text/plain",
        data: { $bytes: base64("hello via members grant") },
      },
      extensions: {},
    });
    expect(res.status).toBe(200);

    // The grant shows up in B's grant view with kind='members'.
    res = await ctx.authedFetch(ADMIN_B)(
      `${ctx.baseUrl}/xrpc/space.roomy.federation.getGrants?spaceId=${B}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.receiverGrants).toContainEqual({
      originSpaceId: A,
      originSpaceName: "Test Space",
      roomId: CHANNEL,
      grantee: B,
      kind: "members",
      permission: "readwrite",
    });
  });

  test("A-side revoke drops the channel from B's grant view", async () => {
    await send(ADMIN_B, A, {
      id: newUlid(),
      $type: "space.roomy.federation.request.v0",
      federatingSpaceDid: B,
    });
    await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.respond.v0",
      federatingSpaceDid: B,
      approve: true,
    });
    await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.setRoomPermission.v0",
      federatingSpaceDid: B,
      roomId: CHANNEL,
      permission: "readwrite",
    });

    // ADMIN_A revokes the federation.
    let res = await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.remove.v0",
      federatingSpaceDid: B,
    });
    expect(res.status).toBe(200);

    // The origin grant is gone.
    res = await ctx.authedFetch(ADMIN_A)(
      `${ctx.baseUrl}/xrpc/space.roomy.federation.getGrants?spaceId=${A}`,
    );
    const body = await res.json();
    expect(body.originGrants).toHaveLength(0);
  });

  test("getOutgoing survives a counterpart space on a stale schema (no comp_info)", async () => {
    // Establish an active federation with an origin grant (A → B).
    await send(ADMIN_B, A, {
      id: newUlid(),
      $type: "space.roomy.federation.request.v0",
      federatingSpaceDid: B,
    });
    await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.respond.v0",
      federatingSpaceDid: B,
      approve: true,
    });
    await send(ADMIN_A, A, {
      id: newUlid(),
      $type: "space.roomy.federation.setRoomPermission.v0",
      federatingSpaceDid: B,
      roomId: CHANNEL,
      permission: "readwrite",
    });

    // Simulate B's per-space DB being on a stale schema that predates
    // comp_info (blue-green serves the old file until rebuilt): drop the
    // table so the name lookup throws. The handler must degrade to the DID
    // instead of 500ing the whole outgoing list.
    (ctx.db as any).forSpace(B).run("drop table comp_info");

    const res = await ctx.authedFetch(ADMIN_A)(
      `${ctx.baseUrl}/xrpc/space.roomy.federation.getOutgoing?spaceId=${A}`,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const fed = body.federations.find(
      (f: { federatingSpaceDid: string }) => f.federatingSpaceDid === B,
    );
    expect(fed).toBeDefined();
    expect(fed.federatingSpaceName).toBeUndefined();
  });
});
