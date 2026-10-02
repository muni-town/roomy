/**
 * LiveKit token minting, room naming, and webhook signature verification.
 *
 * All three are pure functions, so the entire LiveKit contract is exercised
 * without an SFU: a token is a JWT the test decodes, and a webhook request is
 * one the test mints the way LiveKit would.
 */

import { describe, expect, test } from "bun:test";
import { StreamDid } from "@roomy-space/sdk";
import { createHash, createHmac } from "node:crypto";
import {
  LIVEKIT_TOKEN_TTL_SECONDS,
  type LiveKitConfig,
} from "../voice/livekit.ts";
import {
  liveKitRoomName,
  mintLiveKitToken,
  parseLiveKitRoomName,
  resolveRoomName,
  verifyLiveKitWebhook,
} from "../voice/tokens.ts";

const CONFIG: LiveKitConfig = {
  url: "wss://livekit.example.com",
  apiKey: "APIabc123",
  apiSecret: "supersecret",
  webhookSecret: "webhooksecret",
  serverId: "roomy",
};

const SPACE = "did:plc:abcdefghijklmnopqrstuvwx";
const ROOM = "01J8ZQK4T2M9V6F0W3B7XN5HRC";
const CALL = "01J8ZQK4T2M9V6F0W3B7XN5HSD";
const DID = "did:plc:userdiduserdiduserdid";

/** The branded DID `resolveRoomName` returns, so the comparison is typed. */
const SPACE_DID = StreamDid.assert(SPACE);

describe("liveKitRoomName", () => {
  test("nests the call generation in the suffix", () => {
    expect(liveKitRoomName(CONFIG, SPACE, ROOM, CALL)).toBe(
      `roomy.${SPACE}.${ROOM}@${CALL}`,
    );
  });

  test("round-trips through parse", () => {
    const name = liveKitRoomName(CONFIG, SPACE, ROOM, CALL);
    expect(parseLiveKitRoomName(name)).toEqual({
      serverId: "roomy",
      spaceId: SPACE,
      roomId: ROOM,
      callId: CALL,
    });
  });

  test("rejects a name with no call suffix", () => {
    expect(parseLiveKitRoomName(`roomy.${SPACE}.${ROOM}`)).toBeNull();
  });


  test("round-trips a did:web space DID, which contains dots", () => {
    const webSpace = "did:web:spaces.example.com";
    const name = liveKitRoomName(CONFIG, webSpace, ROOM, CALL);
    expect(parseLiveKitRoomName(name)).toEqual({
      serverId: "roomy",
      spaceId: webSpace,
      roomId: ROOM,
      callId: CALL,
    });
  });
  test("rejects a name with no room segment", () => {
    expect(parseLiveKitRoomName(`roomy.${SPACE}@${CALL}`)).toBeNull();
  });
});

describe("resolveRoomName", () => {
  test("accepts a name this deployment minted", () => {
    const name = liveKitRoomName(CONFIG, SPACE, ROOM, CALL);
    const resolved = resolveRoomName(name, "roomy");
    expect(resolved?.spaceId).toBe(SPACE_DID);
    expect(resolved?.roomId).toBe(ROOM);
    expect(resolved?.callId).toBe(CALL);
  });

  test("drops another deployment's rooms on a shared LiveKit project", () => {
    const name = liveKitRoomName({ ...CONFIG, serverId: "other" }, SPACE, ROOM, CALL);
    expect(resolveRoomName(name, "roomy")).toBeNull();
  });

  test("drops a malformed name rather than guessing", () => {
    expect(resolveRoomName("nonsense", "roomy")).toBeNull();
  });
});

describe("mintLiveKitToken", () => {
  test("produces a verifiable HS256 JWT with a room grant", () => {
    const { token } = mintLiveKitToken(CONFIG, "roomy.s.r@c", DID, {
      did: DID,
    });
    const [header, payload, signature] = token.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();

    const expected = createHmac("sha256", CONFIG.apiSecret)
      .update(`${header}.${payload}`)
      .digest("base64url");
    expect(signature).toBe(expected);

    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString()) as {
      iss: string;
      sub: string;
      video: { room: string; roomJoin: boolean };
      metadata: string;
    };
    expect(claims.iss).toBe(CONFIG.apiKey);
    expect(claims.sub).toBe(DID);
    expect(claims.video.room).toBe("roomy.s.r@c");
    expect(claims.video.roomJoin).toBe(true);
    expect(JSON.parse(claims.metadata)).toEqual({ did: DID });
  });

  test("carries the profile fields the client renders a card from", () => {
    const { token } = mintLiveKitToken(CONFIG, "room", DID, {
      did: DID,
      handle: "alice.test",
      displayName: "Alice",
      avatarUrl: "https://cdn.example/a.png",
    });
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    ) as { metadata: string; name: string };
    expect(JSON.parse(claims.metadata)).toEqual({
      did: DID,
      handle: "alice.test",
      displayName: "Alice",
      avatarUrl: "https://cdn.example/a.png",
    });
    expect(claims.name).toBe("Alice");
  });

  test("expires after the documented TTL", () => {
    const now = 1_700_000_000_000;
    const { token, expiresAt } = mintLiveKitToken(CONFIG, "room", DID, { did: DID }, now);
    const claims = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString(),
    ) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBe(LIVEKIT_TOKEN_TTL_SECONDS);
    expect(expiresAt).toBe((claims.iat + LIVEKIT_TOKEN_TTL_SECONDS) * 1000);
  });
});

describe("verifyLiveKitWebhook", () => {
  /** A request signed the way LiveKit signs one. */
  function sign(body: Buffer, secret = CONFIG.webhookSecret): string {
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) + 60,
        sha256: createHash("sha256").update(body).digest("base64url"),
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", secret)
      .update(`${header}.${claims}`)
      .digest("base64url");
    return `Bearer ${header}.${claims}.${signature}`;
  }

  test("accepts a correctly signed body", () => {
    const body = Buffer.from(JSON.stringify({ event: "participant_joined" }));
    expect(verifyLiveKitWebhook(CONFIG, sign(body), body)).toBe(true);
  });

  test("rejects a body that was tampered with after signing", () => {
    const signed = Buffer.from(JSON.stringify({ event: "participant_joined" }));
    const tampered = Buffer.from(
      JSON.stringify({ event: "room_finished", room: { name: "evil" } }),
    );
    expect(verifyLiveKitWebhook(CONFIG, sign(signed), tampered)).toBe(false);
  });

  test("rejects a token signed with the wrong secret", () => {
    const body = Buffer.from(JSON.stringify({ event: "room_finished" }));
    expect(verifyLiveKitWebhook(CONFIG, sign(body, "wrongsecret"), body)).toBe(
      false,
    );
  });

  test("rejects a missing or malformed Authorization header", () => {
    const body = Buffer.from("{}");
    expect(verifyLiveKitWebhook(CONFIG, null, body)).toBe(false);
    expect(verifyLiveKitWebhook(CONFIG, "Bearer not.a.jwt", body)).toBe(false);
    expect(verifyLiveKitWebhook(CONFIG, "garbage", body)).toBe(false);
  });

  test("rejects an expired token", () => {
    const body = Buffer.from(JSON.stringify({ event: "room_finished" }));
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const claims = Buffer.from(
      JSON.stringify({
        exp: Math.floor(Date.now() / 1000) - 60,
        sha256: createHash("sha256").update(body).digest("base64url"),
      }),
    ).toString("base64url");
    const signature = createHmac("sha256", CONFIG.webhookSecret)
      .update(`${header}.${claims}`)
      .digest("base64url");
    expect(
      verifyLiveKitWebhook(CONFIG, `Bearer ${header}.${claims}.${signature}`, body),
    ).toBe(false);
  });
});
