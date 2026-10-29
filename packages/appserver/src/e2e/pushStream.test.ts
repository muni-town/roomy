/**
 * Push stream coverage (space.roomy.push.stream), through HTTP
 * Each test registers an `sse`, then opens and watches the stream.
 * response status, SSE frames, and when the stream ends.
 *
 * Run: bun test --cwd packages/appserver src/e2e/pushStream.test.ts
 */

import net from "node:net";
import { describe, expect, test } from "bun:test";
import { openReadStateDb } from "../db/db.ts";
import {
  _resetPushDispatcher,
  holdsPushDispatcher,
  startPushDispatcher,
} from "../push/dispatcher.ts";
import { PUSH_TRANSPORTS, type PushTarget } from "../push/transports/types.ts";
import { startAppserver, type E2eContext } from "./helpers.ts";

const USER = "did:plc:e2e-stream-user";
const OTHER_USER = "did:plc:e2e-stream-other";
const ENDPOINT = "q83vEq7mR1xk0Zb9TfNwXA";

const WAIT_TIMEOUT_MS = 3000;

function streamUrl(ctx: E2eContext, endpoint: string): string {
  return `${ctx.baseUrl}/xrpc/space.roomy.push.stream?endpoint=${encodeURIComponent(endpoint)}`;
}

async function register(ctx: E2eContext, did: string, endpoint: string) {
  const res = await ctx.authedFetch(did)(
    `${ctx.baseUrl}/xrpc/space.roomy.push.registerSubscription`,
    { method: "POST", body: JSON.stringify({ endpoint, kind: "sse" }) },
  );
  expect(res.status).toBe(200);
}

async function unregister(ctx: E2eContext, did: string, endpoint: string) {
  const res = await ctx.authedFetch(did)(
    `${ctx.baseUrl}/xrpc/space.roomy.push.unregisterSubscription`,
    { method: "POST", body: JSON.stringify({ endpoint }) },
  );
  expect(res.status).toBe(200);
}

/** Hand the sse transport a payload, as the dispatcher does for a stored row. */
function deliver(endpoint: string, body: string) {
  const transport = PUSH_TRANSPORTS["sse"];
  if (transport === undefined) throw new Error("the sse transport is not registered");
  const target: PushTarget = {
    kind: "sse",
    endpoint,
    p256dh: "",
    auth: "",
    expirationTime: null,
  };
  return transport.deliver(target, body, {});
}

function withTimeout<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${what}`)),
      WAIT_TIMEOUT_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Split one SSE frame into its event name and JSON data. */
function parseFrame(frame: string): { event: string; data: unknown } {
  const fields = new Map<string, string>();
  for (const line of frame.split("\n")) {
    const separator = line.indexOf(": ");
    fields.set(line.slice(0, separator), line.slice(separator + 2));
  }
  const event = fields.get("event");
  const data = fields.get("data");
  if (event === undefined || data === undefined) {
    throw new Error(`malformed SSE frame: ${JSON.stringify(frame)}`);
  }
  return { event, data: JSON.parse(data) };
}

type OpenStream = {
  nextFrame(): Promise<string>;
  ended(): Promise<void>;
}

const openStreams: AbortController[] = [];

async function openStream(
  ctx: E2eContext,
  did: string,
  endpoint: string,
): Promise<OpenStream> {
  const aborter = new AbortController();
  openStreams.push(aborter);
  const response = await ctx.authedFetch(did)(streamUrl(ctx, endpoint), {
    signal: aborter.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("stream response has no body");

  const decoder = new TextDecoder();
  let buffered = "";

  async function readFrame(): Promise<string> {
    for (;;) {
      const boundary = buffered.indexOf("\n\n");
      if (boundary !== -1) {
        const frame = buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        if (frame.startsWith(":")) continue;
        return frame;
      }
      if (reader === undefined) throw new Error("stream response has no body");
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream ended while waiting for a frame");
      buffered += decoder.decode(chunk.value, { stream: true });
    }
  }

  async function drain(): Promise<void> {
    if (reader === undefined) throw new Error("stream response has no body");
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return;
    }
  }

  return {
    nextFrame: () => withTimeout(readFrame(), "an event frame"),
    ended: () => withTimeout(drain(), "the stream to end"),
  };
}

function openStalledStream(
  ctx: E2eContext,
  did: string,
  endpoint: string,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(ctx.handle.port, "localhost", () => {
      socket.write(
        `GET /xrpc/space.roomy.push.stream?endpoint=${encodeURIComponent(endpoint)} HTTP/1.1\r\n` +
          `Host: localhost\r\nX-Test-Did: ${did}\r\n\r\n`,
      );
    });
    socket.once("data", () => {
      socket.pause();
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

async function waitForLease(attempts = 300): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (holdsPushDispatcher()) return;
    await Bun.sleep(10);
  }
  throw new Error("the push dispatcher never acquired its lease");
}

/** Run `body` against an appserver whose dispatcher holds the lease. */
async function withStreamServer(
  body: (ctx: E2eContext) => Promise<void>,
): Promise<void> {
  const ctx = await startAppserver();
  startPushDispatcher({ db: openReadStateDb() });
  try {
    await waitForLease();
    await body(ctx);
  } finally {
    for (const aborter of openStreams.splice(0)) aborter.abort();
    await _resetPushDispatcher();
  }
}

describe("space.roomy.push.stream", () => {
  test("replica that does not hold the dispatcher lease returns 503 with Retry-After", async () => {
    const ctx = await startAppserver();
    await register(ctx, USER, ENDPOINT);
    expect(holdsPushDispatcher()).toBe(false);

    const res = await ctx.authedFetch(USER)(streamUrl(ctx, ENDPOINT));

    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("5");
    expect(((await res.json()) as { error: string }).error).toBe("NotDispatcher");
  });

  test("refuses callers and endpoints it cannot serve", () =>
    withStreamServer(async (ctx) => {
      await register(ctx, USER, ENDPOINT);
      const refusals: Array<[label: string, res: Response, status: number, error?: string]> = [
        ["anonymous", await ctx.anonFetch(streamUrl(ctx, ENDPOINT)), 401],
        [
          "an endpoint that was never registered",
          await ctx.authedFetch(USER)(streamUrl(ctx, "Zm9vYmFyYmF6cXV4cXV1eHF1dXhx")),
          400,
          "NotRegistered",
        ],
        [
          "another user's registered endpoint",
          await ctx.authedFetch(OTHER_USER)(streamUrl(ctx, ENDPOINT)),
          400,
          "NotRegistered",
        ],
        [
          "no endpoint at all",
          await ctx.authedFetch(USER)(`${ctx.baseUrl}/xrpc/space.roomy.push.stream`),
          400,
          "InvalidRequest",
        ],
      ];

      const actual: Array<[string, number, string | undefined]> = [];
      for (const [label, res, , error] of refusals) {
        const body = (await res.json()) as { error?: string };
        actual.push([label, res.status, error === undefined ? undefined : body.error]);
      }
      expect(actual).toEqual(
        refusals.map(([label, , status, error]) => [label, status, error]),
      );
    }));

  test("registered device gets an event stream that starts with ready", () =>
    withStreamServer(async (ctx) => {
      await register(ctx, USER, ENDPOINT);
      const stream = await openStream(ctx, USER, ENDPOINT);

      const ready = parseFrame(await stream.nextFrame());

      expect(ready.event).toBe("ready");
      expect(ready.data).toHaveProperty("maxAgeMs");
    }));

  test("a delivery arrives on the stream, and body cannot forge further events", () =>
    withStreamServer(async (ctx) => {
      await register(ctx, USER, ENDPOINT);
      const stream = await openStream(ctx, USER, ENDPOINT);
      await stream.nextFrame();

      const message = { type: "message", roomName: "general" };
      expect((await deliver(ENDPOINT, JSON.stringify(message))).outcome).toBe("delivered");
      expect(parseFrame(await stream.nextFrame())).toEqual({ event: "push", data: message });

      const poisoned = '{"a":1}\n\nevent: push\ndata: {"forged":true}';
      expect((await deliver(ENDPOINT, poisoned)).outcome).toBe("retry");
      const canary = { type: "message", roomName: "canary" };
      await deliver(ENDPOINT, JSON.stringify(canary));
      expect(parseFrame(await stream.nextFrame())).toEqual({ event: "push", data: canary });
    }));

  test("reconnect ends previous stream and takes over delivery", () =>
    withStreamServer(async (ctx) => {
      await register(ctx, USER, ENDPOINT);
      const first = await openStream(ctx, USER, ENDPOINT);
      await first.nextFrame();
      const second = await openStream(ctx, USER, ENDPOINT);
      await second.nextFrame();

      await first.ended();

      const message = { type: "message", roomName: "general" };
      expect((await deliver(ENDPOINT, JSON.stringify(message))).outcome).toBe("delivered");
      expect(parseFrame(await second.nextFrame())).toEqual({ event: "push", data: message });
    }));

  test("client that stops reading is dropped", () =>
    withStreamServer(async (ctx) => {
      await register(ctx, USER, ENDPOINT);
      const stalled = await openStalledStream(ctx, USER, ENDPOINT);
      try {
        const padding = JSON.stringify({ padding: "x".repeat(256 * 1024) });
        let outcome = "delivered";
        for (let attempt = 0; attempt < 400 && outcome === "delivered"; attempt += 1) {
          outcome = (await deliver(ENDPOINT, padding)).outcome;

          await Bun.sleep(0);
        }

        expect(outcome).toBe("skipped");
        expect((await deliver(ENDPOINT, padding)).outcome).toBe("skipped");
      } finally {
        stalled.destroy();
      }
    }));

  test("unregistering ends the stream and stops delivery", () =>
    withStreamServer(async (ctx) => {
      await register(ctx, USER, ENDPOINT);
      const stream = await openStream(ctx, USER, ENDPOINT);
      await stream.nextFrame();

      await unregister(ctx, USER, ENDPOINT);

      await stream.ended();
      expect((await deliver(ENDPOINT, "{}")).outcome).toBe("skipped");
    }));
});
