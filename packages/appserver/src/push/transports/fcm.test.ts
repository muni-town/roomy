/**
 * FCM transport: the OAuth2 exchange, the send body, and the outcome each
 * Google error maps to.
 *
 * Both network legs are driven against a local HTTP server: the token
 * endpoint is reached by pointed `host` at the stub, and the send leg by an
 * overridden `origin`. The assertion that matters most is on the message
 * body — Google requires every `data` value to be a string, and a nested
 * object there is rejected at send time, so the payload has to travel as a
 * JSON string under a single key.
 *
 * The transport takes its config as an argument, so the credential and the
 * endpoint belong to the test; nothing here reads the process environment.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createFcmTransport, type FcmConfig } from "./fcm.ts";
import type { PushDeliveryOptions, PushTarget } from "./types.ts";

const PROJECT_ID = "roomy-test-project";
const CLIENT_EMAIL = "pusher@roomy-test-project.iam.gserviceaccount.com";
const REGISTRATION_TOKEN = "fcm-registration-token-abc123";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const SERVICE_ACCOUNT = JSON.stringify({
  type: "service_account",
  project_id: PROJECT_ID,
  client_email: CLIENT_EMAIL,
  private_key: PRIVATE_PEM,
});

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
  body: string;
}

/**
 * A local HTTP server standing in for Google: it answers the OAuth2 token
 * exchange and the FCM send, recording both.
 *
 * A stub for Google's token endpoint cannot be reached by overriding the
 * transport's send host alone, so the transport is pointed at the stub for
 * sends and `globalThis.fetch` is wrapped for the token exchange — the same
 * approach the embed sweeper's tests use.
 */
class FcmStub {
  readonly requests: ObservedRequest[] = [];
  port = 0;
  /** Status/body the next send receives. */
  sendStatus = 200;
  sendBody = "{}";
  #server: Bun.Server<unknown> | null = null;

  async start(): Promise<void> {
    this.#server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.text();
        this.requests.push({ path: url.pathname, body });
        if (url.pathname.endsWith("/messages:send")) {
          return new Response(this.sendBody, {
            status: this.sendStatus,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200 });
      },
    });
    this.port = this.#server.port ?? 0;
  }

  async stop(): Promise<void> {
    this.#server?.stop(true);
    this.#server = null;
  }

  transport(overrides: Partial<FcmConfig> = {}) {
    return createFcmTransport({
      serviceAccountJson: SERVICE_ACCOUNT,
      host: "127.0.0.1",
      port: this.port,
      ...overrides,
    });
  }
}

const stub = new FcmStub();
const realFetch = globalThis.fetch;

/**
 * Route the OAuth2 token exchange to a canned response. The transport's send
 * leg is redirected through its own config, so only Google's token endpoint
 * needs intercepting.
 */
function stubTokenExchange(
  response: unknown,
  { ok = true, status = 200 }: { ok?: boolean; status?: number } = {},
): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("oauth2.googleapis.com")) {
      return Promise.resolve(
        new Response(typeof response === "string" ? response : JSON.stringify(response), {
          status,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return realFetch(input, init);
  }) as typeof globalThis.fetch;
}

beforeAll(async () => {
  await stub.start();
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await stub.stop();
});

afterEach(() => {
  stub.requests.length = 0;
  stub.sendStatus = 200;
  stub.sendBody = "{}";
  stubTokenExchange({ access_token: "test-access-token", expires_in: 3600 });
});

stubTokenExchange({ access_token: "test-access-token", expires_in: 3600 });

function target(endpoint = REGISTRATION_TOKEN): PushTarget {
  return { kind: "fcm", endpoint, expirationTime: null };
}

/** The single `messages:send` request the stub observed. */
function sendRequest(): { path: string; body: Record<string, unknown> } {
  const request = stub.requests.find((r) => r.path.endsWith("/messages:send"));
  if (!request) throw new Error("no messages:send request was made");
  return { path: request.path, body: JSON.parse(request.body) as Record<string, unknown> };
}

describe("push/fcm — the wire request", () => {
  test("POSTs messages:send with a string-valued data payload and a notification block", async () => {
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result).toEqual({ outcome: "delivered", status: 200 });

    const { path, body } = sendRequest();
    expect(path).toBe(`/v1/projects/${PROJECT_ID}/messages:send`);

    const message = body.message as {
      token: string;
      notification: { title: string; body: string };
      data: Record<string, string>;
      android: { priority: string; ttl: string; collapse_key?: string };
    };
    expect(message.token).toBe(REGISTRATION_TOKEN);
    // Android will not display a data-only message with the app closed, so the
    // visible text must be in `notification` as well as in the payload.
    expect(message.notification.title).toBe("Alice in general");
    expect(message.notification.body).toBe("hello there");
    // Every `data` value must be a string — Google rejects a nested object.
    // The payload is carried verbatim, as the single string value Google
    // requires, so the client's own decode is a plain JSON.parse.
    expect(message.data.roomy ?? "").toBe(PAYLOAD);
    expect(message.android.collapse_key).toBe(OPTIONS.topic);
    expect(message.android.ttl).toBe("2419200s");
  });

  test("maps a normal urgency to normal priority and a low one to normal too", async () => {
    await stub.transport().deliver(target(), PAYLOAD, { urgency: "high" });
    let message = sendRequest().body.message as { android: { priority: string } };
    expect(message.android.priority).toBe("high");

    stub.requests.length = 0;
    await stub.transport().deliver(target(), PAYLOAD, { urgency: "normal" });
    message = sendRequest().body.message as { android: { priority: string } };
    expect(message.android.priority).toBe("high");

    stub.requests.length = 0;
    await stub.transport().deliver(target(), PAYLOAD, { urgency: "low" });
    message = sendRequest().body.message as { android: { priority: string } };
    expect(message.android.priority).toBe("normal");
  });

  test("honours a ttl hint and omits the collapse key without a topic", async () => {
    await stub.transport().deliver(target(), PAYLOAD, { urgency: "normal", ttl: 60 });
    const message = sendRequest().body.message as {
      android: { ttl: string; collapse_key?: string };
    };
    expect(message.android.ttl).toBe("60s");
    expect(message.android.collapse_key).toBeUndefined();
  });

  test("exchanges the service account for a bearer token with a signed RS256 assertion", async () => {
    let captured = "";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) {
        captured = String(init?.body ?? "");
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "abc", expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;

    try {
      await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    } finally {
      globalThis.fetch = originalFetch;
    }

    const params = new URLSearchParams(captured);
    expect(params.get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const assertion = params.get("assertion") ?? "";
    const [headerPart, claimsPart, signature] = assertion.split(".");
    const header = JSON.parse(Buffer.from(headerPart!, "base64url").toString()) as {
      alg: string;
    };
    expect(header.alg).toBe("RS256");
    const claims = JSON.parse(Buffer.from(claimsPart!, "base64url").toString()) as {
      iss: string;
      scope: string;
      aud: string;
      sub?: unknown;
    };
    expect(claims.iss).toBe(CLIENT_EMAIL);
    expect(claims.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
    // `sub` is reserved for domain-wide delegation and must not be set.
    expect(claims.sub).toBeUndefined();
    expect(signature).toBeTruthy();
  });

  test("sends the bearer token it exchanged", async () => {
    await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    // The stub records bodies, not headers, so assert via a header capture.
    const seen: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization");
      if (authorization) seen.push(authorization);
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
    try {
      await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(seen).toEqual(["Bearer test-access-token"]);
  });
});

describe("push/fcm — outcome mapping", () => {
  test("UNREGISTERED in the error details is gone, so the device is pruned", async () => {
    stub.sendStatus = 404;
    stub.sendBody = JSON.stringify({
      error: {
        status: "NOT_FOUND",
        message: "Requested entity was not found.",
        details: [
          {
            "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
            errorCode: "UNREGISTERED",
          },
        ],
      },
    });
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result).toEqual({ outcome: "gone", status: 404 });
  });

  test("a 404 without a code is still gone", async () => {
    stub.sendStatus = 404;
    stub.sendBody = JSON.stringify({ error: { status: "NOT_FOUND" } });
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result).toEqual({ outcome: "gone", status: 404 });
  });

  test("UNAVAILABLE is retry", async () => {
    stub.sendStatus = 503;
    stub.sendBody = JSON.stringify({
      error: { status: "UNAVAILABLE", details: [{ errorCode: "UNAVAILABLE" }] },
    });
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("retry");
    expect(result.status).toBe(503);
  });

  test("QUOTA_EXCEEDED is retry", async () => {
    stub.sendStatus = 429;
    stub.sendBody = JSON.stringify({
      error: { status: "QUOTA_EXCEEDED", details: [{ errorCode: "QUOTA_EXCEEDED" }] },
    });
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("retry");
    expect(result.status).toBe(429);
  });

  test("INVALID_ARGUMENT is retry, never gone", async () => {
    // A bad request is our bug; pruning the device would silently unsubscribe
    // a user whose token may be perfectly valid.
    stub.sendStatus = 400;
    stub.sendBody = JSON.stringify({
      error: { status: "INVALID_ARGUMENT", details: [{ errorCode: "INVALID_ARGUMENT" }] },
    });
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("retry");
    expect(result.status).toBe(400);
  });

  test("a refused bearer token is retry and drops the cached token", async () => {
    const transport = stub.transport();
    await transport.deliver(target(), PAYLOAD, OPTIONS);
    expect(stub.requests.length).toBeGreaterThan(0);

    stub.sendStatus = 401;
    stub.sendBody = JSON.stringify({ error: { status: "UNAUTHENTICATED" } });
    const refused = await transport.deliver(target(), PAYLOAD, OPTIONS);
    expect(refused.outcome).toBe("retry");

    // The next delivery must re-exchange rather than replay a refused token.
    let exchanges = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("oauth2.googleapis.com")) exchanges++;
      return originalFetch(input, init);
    }) as typeof globalThis.fetch;
    stub.sendStatus = 200;
    stub.sendBody = "{}";
    try {
      await transport.deliver(target(), PAYLOAD, OPTIONS);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(exchanges).toBe(1);
  });

  test("a failed token exchange is retry", async () => {
    stubTokenExchange({ error: "invalid_grant" }, { ok: false, status: 400 });
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("retry");
    expect(result.status).toBeNull();
  });

  test("a token exchange without an access_token is retry", async () => {
    stubTokenExchange({ token_type: "Bearer" });
    const result = await stub.transport().deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("retry");
  });

  test("an unparseable payload is retry rather than a prune", async () => {
    const result = await stub.transport().deliver(target(), "not json", OPTIONS);
    expect(result.outcome).toBe("retry");
    expect(stub.requests.length).toBe(0);
  });
});

describe("push/fcm — configuration", () => {
  test("is not configured without a service account", () => {
    expect(stub.transport({ serviceAccountJson: "" }).isConfigured()).toBe(false);
    expect(stub.transport().isConfigured()).toBe(true);
  });

  test("is not configured when the JSON is incomplete or the key is unusable", () => {
    expect(stub.transport({ serviceAccountJson: "{}" }).isConfigured()).toBe(false);
    expect(
      stub.transport({
        serviceAccountJson: JSON.stringify({
          project_id: PROJECT_ID,
          client_email: CLIENT_EMAIL,
          private_key: "not-a-key",
        }),
      }).isConfigured(),
    ).toBe(false);
    expect(stub.transport({ serviceAccountJson: "not json" }).isConfigured()).toBe(false);
  });

  test("an unconfigured transport skips instead of reporting a failure", async () => {
    const result = await stub
      .transport({ serviceAccountJson: "" })
      .deliver(target(), PAYLOAD, OPTIONS);
    expect(result).toEqual({ outcome: "skipped", status: null });
    expect(stub.requests.length).toBe(0);
  });

  test("accepts a private key whose newlines are escaped", async () => {
    // How a single-line secret value arrives from most secret stores.
    const transport = stub.transport({
      serviceAccountJson: JSON.stringify({
        project_id: PROJECT_ID,
        client_email: CLIENT_EMAIL,
        private_key: PRIVATE_PEM.replace(/\n/g, "\\n"),
      }),
    });
    expect(transport.isConfigured()).toBe(true);
    const result = await transport.deliver(target(), PAYLOAD, OPTIONS);
    expect(result.outcome).toBe("delivered");
  });
});
