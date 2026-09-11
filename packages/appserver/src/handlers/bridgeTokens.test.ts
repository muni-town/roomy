/**
 * Unit tests for the bridge-token handlers: spend rule (>100 members marks
 * the grant spent, once, permanently), revocation guards (pending vs spent
 * vs not-grantor), grant conflicts (one active grant per user), and the
 * admin getSpaceMembership response shape.
 *
 * Polar fetches are stubbed (never hit real Polar in tests). The read-state
 * + per-space DBs run in-memory via openDb({ path: ":memory:" }).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { StreamDid, UserDid } from "@roomy-space/sdk";

import { closeDb, openDb, openReadStateDb, openSpaceDb } from "../db/db.ts";
import { _resetHydrationInflight } from "../hydration/userHydration.ts";
import { Router } from "../invalidation/router.ts";
import { _setAdminDids } from "../admin.ts";
import {
  _clearPolarCache,
  setPolar,
  type PolarConfig,
  type PolarCustomerState,
} from "../billing/polar.ts";
import { markGrantSpent, selectGrantForGrantor } from "../queries/bridgeTokens.ts";
import { grantBridgeTokenHandler } from "./space.roomy.space.grantBridgeToken.ts";
import { revokeBridgeTokenHandler } from "./space.roomy.space.revokeBridgeToken.ts";
import { adminGetSpaceMembershipHandler } from "./space.roomy.admin.getSpaceMembership.ts";
import { XrpcError } from "../xrpc/errors.ts";

const GRANTOR = UserDid.assert("did:plc:bt-grantor");
const OTHER = UserDid.assert("did:plc:bt-other");
const SPACE = StreamDid.assert("did:web:bt-space.example");

const CONFIG: PolarConfig = {
  endpoint: "https://sandbox-api.polar.sh/v1",
  accessToken: "polar_oat_test",
  roomyProProductId: "prod_roomy_pro",
  appOrigin: "https://roomy.space",
};

function proState(): PolarCustomerState {
  return {
    active_subscriptions: [
      {
        status: "active",
        product_id: CONFIG.roomyProProductId,
        cancel_at_period_end: false,
      },
    ],
    granted_benefits: [],
  };
}

const realFetch = globalThis.fetch;

function stubPolar(state: PolarCustomerState | null, status = 200): void {
  const next: typeof fetch = (() =>
    Promise.resolve(
      status === 404
        ? new Response("", { status: 404 })
        : Response.json(state ?? proState(), { status }),
    )) as unknown as typeof fetch;
  globalThis.fetch = next;
}

function resetFetch(): void {
  globalThis.fetch = realFetch;
}

function auth(did: UserDid | null) {
  return { did: did === null ? null : String(did) };
}

/**
 * Insert a user into the space as a member by writing the entity + edge
 * rows the access query reads (`edges` head=space, label='member').
 */
async function makeMember(userDid: string, spaceDid: StreamDid = SPACE): Promise<void> {
  const spaceDb = openSpaceDb(spaceDid);
  await spaceDb.run(
    `insert or ignore into entities (id, stream_id) values (?, ?)`,
    userDid,
    spaceDid,
  );
  await spaceDb.run(
    `insert or ignore into entities (id, stream_id) values (?, ?)`,
    spaceDid,
    spaceDid,
  );
  await spaceDb.run(
    `insert or ignore into edges (head, tail, label) values (?, ?, 'member')`,
    spaceDid,
    userDid,
  );
}

beforeEach(async () => {
  closeDb();
  _resetHydrationInflight();
  Router.resetInstance();
  _clearPolarCache();
  setPolar(CONFIG);
  _setAdminDids([String(GRANTOR)]);

  openDb({ path: ":memory:" });
});

afterEach(() => {
  resetFetch();
  setPolar(null);
  closeDb();
  _resetHydrationInflight();
  Router.resetInstance();
});

describe("grantBridgeToken", () => {
  test("Pro grantor → inserts pending grant with capacity snapshot 1000", async () => {
    stubPolar(proState());
    await makeMember(GRANTOR);

    const res = await grantBridgeTokenHandler({}, auth(GRANTOR), {
      spaceId: SPACE,
    });
    expect(res).toEqual({ status: "pending", capacity: 1000 });

    const row = await selectGrantForGrantor(openReadStateDb(), GRANTOR);
    expect(row).not.toBeNull();
    expect(row?.space_did).toBe(SPACE);
    expect(row?.spent_at).toBeNull();
    expect(row?.capacity_snapshot).toBe(1000);
  });

  test("granting while a pending grant exists (another space) → 409", async () => {
    stubPolar(proState());
    await makeMember(GRANTOR);
    await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });

    const otherSpace = StreamDid.assert("did:web:bt-other-space.example");
    await makeMember(GRANTOR, otherSpace);

    try {
      await grantBridgeTokenHandler({}, auth(GRANTOR), {
        spaceId: otherSpace,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(409);
      expect((err as XrpcError).xrpcError).toBe("AlreadyGranted");
    }
  });

  test("granting while a spent grant exists → 409 (spent is permanent)", async () => {
    stubPolar(proState());
    await makeMember(GRANTOR);
    await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });

    await markGrantSpent(openReadStateDb(), GRANTOR);

    try {
      await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(409);
      expect((err as XrpcError).xrpcError).toBe("AlreadySpent");
    }
  });

  test("non-Pro (no valid Polar state) → not a Pro member", async () => {
    stubPolar({ active_subscriptions: [], granted_benefits: [] });
    await makeMember(GRANTOR);
    try {
      await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(403);
      expect((err as XrpcError).xrpcError).toBe("NotProMember");
    }
  });

  test("Polar disabled (no config) → 503", async () => {
    setPolar(null);
    await makeMember(GRANTOR);
    try {
      await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(503);
    }
  });
});

describe("revokeBridgeToken", () => {
  test("pending grant → revoke deletes the row", async () => {
    stubPolar(proState());
    await makeMember(GRANTOR);
    await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });

    const res = await revokeBridgeTokenHandler({}, auth(GRANTOR), {
      spaceId: SPACE,
    });
    expect(res).toEqual({ revoked: true });

    expect(
      await selectGrantForGrantor(openReadStateDb(), GRANTOR),
    ).toBeNull();
  });

  test("spent grant → 409 (permanent, cannot revoke)", async () => {
    stubPolar(proState());
    await makeMember(GRANTOR);
    await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });
    await markGrantSpent(openReadStateDb(), GRANTOR);

    try {
      await revokeBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(409);
      expect((err as XrpcError).xrpcError).toBe("AlreadySpent");
    }

    // Row still present (spent grants are never deleted).
    expect(
      await selectGrantForGrantor(openReadStateDb(), GRANTOR),
    ).not.toBeNull();
  });

  test("member without a grant → 403", async () => {
    await makeMember(OTHER);
    try {
      await revokeBridgeTokenHandler({}, auth(OTHER), { spaceId: SPACE });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(403);
    }
  });

  test("grantor revoking for a space other than their grant → 403", async () => {
    stubPolar(proState());
    await makeMember(GRANTOR);
    await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });

    const otherSpace = StreamDid.assert("did:web:bt-other-space-2.example");
    await makeMember(GRANTOR, otherSpace);

    try {
      await revokeBridgeTokenHandler({}, auth(GRANTOR), {
        spaceId: otherSpace,
      });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(XrpcError);
      expect((err as XrpcError).status).toBe(403);
    }
  });
});

describe("admin getSpaceMembership (spend rule + response shape)", () => {
  test("memberCount ≤ 100 keeps a pending grant pending and live", async () => {
    stubPolar(proState());
    await makeMember(GRANTOR);
    await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });

    // 50 members total (grantor + 49 extras).
    for (let i = 0; i < 49; i++) {
      await makeMember(`did:plc:bt-extra-${i}`);
    }

    const res = await adminGetSpaceMembershipHandler(
      { spaceId: SPACE },
      auth(GRANTOR),
    );
    expect(res.spaceDid).toBe(SPACE);
    expect(res.memberCount).toBe(50);
    const token = res.tokens.find((t) => t.grantorDid === String(GRANTOR));
    expect(token?.status).toBe("pending");
    expect(token?.live).toBe(true);
    expect(token?.capacity).toBe(1000);
    expect(res.validTokenCount).toBe(1);
    expect(res.maxMembers).toBe(1000);
    expect(res.overLimit).toBe(false);
    expect(res.stale).toBe(false);
    expect(res.checkedAt).toBeTypeOf("number");
  });

  test("memberCount > 100 marks a pending grant spent (persisted, permanent)", async () => {
    stubPolar(proState());
    await makeMember(GRANTOR);
    await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });

    // 101 members total (grantor + 100 extras).
    for (let i = 0; i < 100; i++) {
      await makeMember(`did:plc:bt-extra-${i}`);
    }

    const res = await adminGetSpaceMembershipHandler(
      { spaceId: SPACE },
      auth(GRANTOR),
    );
    expect(res.memberCount).toBe(101);
    const token = res.tokens.find((t) => t.grantorDid === String(GRANTOR));
    expect(token?.status).toBe("spent");
    expect(token?.capacity).toBe(0);
    expect(token?.live).toBe(false);
    expect(res.maxMembers).toBe(0);
    expect(res.overLimit).toBe(true);

    // Persisted → grant is spent forever.
    const row = await selectGrantForGrantor(openReadStateDb(), GRANTOR);
    expect(row?.spent_at).not.toBeNull();

    // Granting again is refused; revoking is refused.
    try {
      await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as XrpcError).status).toBe(409);
    }
    try {
      await revokeBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as XrpcError).status).toBe(409);
    }
  });

  test("spent grant stays spent even though the grantor's Polar lapses", async () => {
    stubPolar(proState());
    await makeMember(GRANTOR);
    await grantBridgeTokenHandler({}, auth(GRANTOR), { spaceId: SPACE });

    // Force-spend.
    await markGrantSpent(openReadStateDb(), GRANTOR);

    // Grantor's sub lapsing must not resurrect the token.
    stubPolar({ active_subscriptions: [], granted_benefits: [] });
    const res = await adminGetSpaceMembershipHandler(
      { spaceId: SPACE },
      auth(GRANTOR),
    );
    const token = res.tokens.find((t) => t.grantorDid === String(GRANTOR));
    expect(token?.status).toBe("spent");
    expect(token?.capacity).toBe(0);
  });
});
