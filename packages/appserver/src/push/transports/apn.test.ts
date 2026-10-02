/**
 * APNs transport: the wire request, and the outcome each Apple response maps
 * to.
 *
 * The transport is driven against a real HTTP/2 server on loopback rather than
 * a mocked client, so the assertions cover what a stub would have replaced:
 * the `:path`, the `apns-*` headers, and the JSON body. Because the provider
 * token is signed here rather than by a library, the test also verifies the
 * ES256 signature with WebCrypto — a hand-rolled JWS is exactly the kind of
 * thing that looks right until a real device rejects it.
 *
 * The transport takes its config as an argument, so the credential and the
 * endpoint belong to the test; nothing here reads the process environment.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import http2 from "node:http2";
import { createApnsTransport, type ApnsConfig } from "./apn.ts";
import type { PushDeliveryOptions, PushTarget } from "./types.ts";

const TEAM_ID = "DEF123GHIJ";
const KEY_ID = "ABC123DEFG";
const BUNDLE_ID = "space.roomy";
const DEVICE_TOKEN = "00fc13adff785122b4ad28809a3420982341241421348097878e577c991de8f0";

const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const PAYLOAD = JSON.stringify({
  type: "message",
  spaceId: "did:plc:space",
  roomId: "01ROOM0000000000000000000",
  count: 1,
  roomName: "general",
  authorName: "Alice",
  messageContent: "hello there",
});

const OPTIONS: PushDeliveryOptions = { topic: "room-topic-abc", urgency: "normal" };

interface ObservedRequest {
  path: string;
  headers: http2.IncomingHttpHeaders;
  body: string;
}

/** A local HTTP/2 server that records requests and answers as the test asks. */
class ApnsStub {
  readonly requests: ObservedRequest[] = [];
  port = 0;
  #status = 200;
  #reason = "";
  #server: http2.Http2Server | null = null;
  #sessions: http2.ServerHttp2Session[] = [];

  /** The status/reason every subsequent request receives. */
  reply(status: number, reason = ""): void {
    this.#status = status;
    this.#reason = reason;
  }

  async start(): Promise<void> {
    const server = http2.createServer();
    this.#server = server;
    server.on("session", (session) => {
      this.#sessions.push(session);
    });
    server.on("stream", (stream, headers) => {
      // bun-types omits `respond` from its `node:http2` stream type though it
      // exists at runtime (and `@types/node` declares it on
      // `ServerHttp2Stream`), so the server-side stream is named through the
      // shape this handler actually uses.
      const serverStream = stream as unknown as {
        respond(headers: Record<string, number | string>): void;
        setEncoding(encoding: string): void;
      };
      let body = "";
      serverStream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("end", () => {
        this.requests.push({ path: String(headers[":path"] ?? ""), headers, body });
        serverStream.respond({
          ":status": this.#status,
          "content-type": "application/json",
        });
        stream.end(this.#reason ? JSON.stringify({ reason: this.#reason }) : "");
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        this.port = typeof address === "object" && address ? address.port : 0;
        resolve();
      }),
    );
  }

  async stop(): Promise<void> {
    // The client's sessions must be destroyed too, or the server never becomes
    // idle and the test process hangs on an open socket.
    for (const session of this.#sessions) session.destroy();
    this.#sessions.length = 0;
    const server = this.#server;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    this.#server = null;
  }

  transport(overrides: Partial<ApnsConfig> = {}) {
    return createApnsTransport({
      key: PRIVATE_PEM,
      keyId: KEY_ID,
      teamId: TEAM_ID,
      topic: BUNDLE_ID,
      host: "127.0.0.1",
      port: this.port,
      ...overrides,
    });
  }
}

const stub = new ApnsStub();

beforeAll(async () => {
  await stub.start();
});

afterAll(async () => {
  await stub.stop();
});

afterEach(() => {
  stub.requests.length = 0;
  stub.reply(200);
});

function target(endpoint = DEVICE_TOKEN): PushTarget {
  return { kind: "apns", endpoint, expirationTime: null };
}

/**
 * Verify a compact JWS produced by the transport against `key`. ES256
 * signatures are the raw `r || s` pair, which is what WebCrypto verifies.
 */
async function verifyEs256(
  jwt: string,
  key: KeyObject,
): Promise<boolean> {
  const [header, claims, signature] = jwt.split(".");
  if (!header || !claims || !signature) return false;
  const { subtle } = globalThis.crypto;
  const spki = key.export({ type: "spki", format: "der" });
  const verifyKey = await subtle.importKey(
    "spki",
    new Uint8Array(spki),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    verifyKey,
    new Uint8Array(Buffer.from(signature, "base64url")),
    new TextEncoder().encode(`${header}.${claims}`),
  );
}

describe("push/apns — the wire request", () => {
  test("POSTs /3/device/<token> with alert headers, the alert text, and the payload as a peer of aps", async () => {
    const transport = stub.transport();
    const result = await transport.deliver(target(), PAYLOAD, OPTIONS);

    expect(result).toEqual({ outcome: "delivered", status: 200 });
    expect(stub.requests).toHaveLength(1);
    const request = stub.requests[0]!;
    expect(request.path).toBe(`/3/device/${DEVICE_TOKEN}`);

    // The headers Apple reads: topic, push type, priority, and the collapse id
    // the dispatcher's room topic maps onto.
    expect(request.headers["apns-topic"]).toBe(BUNDLE_ID);
    expect(request.headers["apns-push-type"]).toBe("alert");
    expect(request.headers["apns-priority"]).toBe("10");
    expect(request.headers["apns-collapse-id"]).toBe(OPTIONS.topic);

    const body = JSON.parse(request.body) as {
      aps: { alert: { title: string; body: string }; sound?: string; "thread-id"?: string };
      roomy: string;
    };
    // The visible text must be present in the payload: iOS shows it with no app
    // running, so a payload carrying only ids would arrive blank.
    expect(body.aps.alert.title).toBe("Alice in general");
    expect(body.aps.alert.body).toBe("hello there");
    expect(body.aps["thread-id"]).toBe(OPTIONS.topic);
    // The raw payload travels as a top-level string, which is what survives the
    // client plugin's String/NSNumber-only projection of userInfo.
    expect(typeof body.roomy).toBe("string");
    expect(JSON.parse(body.roomy)).toEqual(JSON.parse(PAYLOAD));
  });

  test("signs an ES256 provider token whose kid, iss and signature verify", async () => {
    const transport = stub.transport();
    await transport.deliver(target(), PAYLOAD, OPTIONS);

    const authorization = stub.requests[0]!.headers["authorization"];
    expect(typeof authorization).toBe("string");
    const jwt = String(authorization).replace(/^bearer /, "");
    const [headerPart, claimsPart] = jwt.split(".");

    const header = JSON.parse(Buffer.from(headerPart!, "base64url").toString()) as {
      alg: string;
      kid: string;
    };
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe(KEY_ID);

    const claims = JSON.parse(Buffer.from(claimsPart!, "base64url").toString()) as {
      iss: string;
      iat: number;
      aud?: unknown;
      exp?: unknown;
    };
    expect(claims.iss).toBe(TEAM_ID);
    // Apple bounds token validity by `iat` age and forbids `aud`/`exp`.
    expect(typeof claims.iat).toBe("number");
    expect(claims.aud).toBeUndefined();
    expect(claims.exp).toBeUndefined();

    expect(await verifyEs256(jwt, publicKey)).toBe(true);
  });

  test("mints one provider token for several deliveries", async () => {
    const transport = stub.transport();
    await transport.deliver(target(), PAYLOAD, OPTIONS);
    await transport.deliver(target(), PAYLOAD, OPTIONS);
    expect(stub.requests).toHaveLength(2);
    // Apple rate-limits token refreshes, so a cached token must be reused.
    expect(stub.requests[0]!.headers["authorization"]).toBe(
      stub.requests[1]!.headers["authorization"],
    );
  });

  test("omits the collapse and thread ids when no topic is given", async () => {
    const transport = stub.transport();
    await transport.deliver(target(), PAYLOAD, { urgency: "normal" });
    const request = stub.requests[0]!;
    expect(request.headers["apns-collapse-id"]).toBeUndefined();
    const body = JSON.parse(request.body) as { aps: Record<string, unknown> };
    expect(body.aps["thread-id"]).toBeUndefined();
  });
});

describe("push/apns — outcome mapping", () => {
  test("410 Unregistered is gone, so the dispatcher prunes the device", async () => {
    stub.reply(410, "Unregistered");
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result).toEqual({ outcome: "gone", status: 410 });
  });

  test("400 BadDeviceToken is gone", async () => {
    stub.reply(400, "BadDeviceToken");
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result).toEqual({ outcome: "gone", status: 400 });
  });

  test("400 DeviceTokenNotForTopic is gone", async () => {
    stub.reply(400, "DeviceTokenNotForTopic");
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result).toEqual({ outcome: "gone", status: 400 });
  });

  test("a 400 this transport caused is retry, never gone", async () => {
    // Pruning a healthy device because we built a bad request would silently
    // unsubscribe a user; a request bug must stay a failure.
    stub.reply(400, "BadTopic");
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("retry");
    expect(result.status).toBe(400);
  });

  test("429 TooManyRequests is retry", async () => {
    stub.reply(429, "TooManyRequests");
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("retry");
    expect(result.status).toBe(429);
  });

  test("503 ServiceUnavailable is retry", async () => {
    stub.reply(503, "ServiceUnavailable");
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("retry");
    expect(result.status).toBe(503);
  });

  test("a refused provider token is retry and drops the cached token", async () => {
    const transport = stub.transport();
    stub.reply(403, "ExpiredProviderToken");
    const first = await transport.deliver(target(), PAYLOAD, OPTIONS);
    expect(first.outcome).toBe("retry");

    // The next delivery must mint a new token rather than replay the refused one.
    stub.reply(200);
    await transport.deliver(target(), PAYLOAD, OPTIONS);
    expect(stub.requests).toHaveLength(2);
    expect(stub.requests[1]!.headers["authorization"]).not.toBe(
      stub.requests[0]!.headers["authorization"],
    );
  });

  test("an unreachable host is retry with no status", async () => {
    // Port 1 on loopback refuses connections.
    const transport = createApnsTransport({
      key: PRIVATE_PEM,
      keyId: KEY_ID,
      teamId: TEAM_ID,
      topic: BUNDLE_ID,
      host: "127.0.0.1",
      port: 1,
    });
    const result = await transport.deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("retry");
    expect(result.status).toBeNull();
  });

  test("an unparseable payload is retry rather than a prune", async () => {
    const result = await stub.transport().deliver(target(), "not json", OPTIONS);
    expect(result.outcome).toBe("retry");
    expect(stub.requests).toHaveLength(0);
  });
});

describe("push/apns — configuration", () => {
  test("is not configured without a key, key id or team id", () => {
    expect(stub.transport({ key: "" }).isConfigured()).toBe(false);
    expect(stub.transport({ keyId: "" }).isConfigured()).toBe(false);
    expect(stub.transport({ teamId: "" }).isConfigured()).toBe(false);
    expect(stub.transport().isConfigured()).toBe(true);
  });

  test("is not configured when the key cannot be decoded", () => {
    // A private_key pasted without its newlines is a real deployment failure;
    // reporting it as configured would promise delivery that always throws.
    expect(stub.transport({ key: "not-a-key" }).isConfigured()).toBe(false);
  });

  test("an unconfigured transport skips instead of reporting a failure", async () => {
    const result = await stub
      .transport({ key: "" })
      .deliver(target(), PAYLOAD, OPTIONS);
    expect(result).toEqual({ outcome: "skipped", status: null });
    expect(stub.requests).toHaveLength(0);
  });

  test("accepts a base64-encoded key with escaped newlines", async () => {
    // How a single-line secret value arrives from most secret stores.
    const base64 = Buffer.from(PRIVATE_PEM).toString("base64");
    const transport = stub.transport({ key: base64.replace(/\n/g, "\\n") });
    expect(transport.isConfigured()).toBe(true);
    const result = await transport.deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("delivered");
  });
});
