/**
 * E2E test for the WebSocket sync subscription path.
 *
 * Tests:
 * 1. getConnectionTicket → ticket string.
 * 2. Open WS with ticket → connection opens.
 * 3. Bad/expired ticket → WS closes with error.
 * 4. Missing ticket → 401 HTTP response.
 *
 * Run: bun test --cwd packages/appserver src/e2e/sync.test.ts
 */

import { describe, expect, test } from "bun:test";
import { newUlid } from "@roomy-space/sdk";
import {
  startAppserver,
  seedSpace,
  seedPersonalStream,
  seedJoinedSpace,
  seedRoom,
  seedMessage,
  preWarmPersonalMaterializer,
  preWarmSpaceMaterializer,
  type E2eContext,
} from "./helpers.ts";

const USER = "did:plc:sync-user";
const PERSONAL = "did:web:personal-sync.example";
const SPACE = "did:web:space-sync.example";
const ROOM = newUlid();
const MSG = newUlid();

/**
 * Set up a minimal seeded space for sync tests.
 */
async function setupSyncSpace(): Promise<E2eContext> {
  const ctx = startAppserver();
  const { db } = ctx;

  seedSpace(db, SPACE, USER);
  seedPersonalStream(db, USER, PERSONAL);
  seedJoinedSpace(db, PERSONAL, SPACE);
  seedRoom(db, ROOM, SPACE);
  seedMessage(db, MSG, ROOM, SPACE, "a");
  await preWarmPersonalMaterializer(PERSONAL);
  await preWarmSpaceMaterializer(SPACE);

  return ctx;
}

describe("WebSocket sync subscription", () => {
  test(
    "getConnectionTicket → WS connect → opens",
    async () => {
      const ctx = await setupSyncSpace();

      // 1. Get a connection ticket
      const ticketRes = await ctx.authedFetch(USER)(
        `${ctx.baseUrl}/xrpc/space.roomy.auth.getConnectionTicket`,
        { method: "POST", body: "{}" },
      );
      expect(ticketRes.status).toBe(200);
      const { ticket } = await ticketRes.json();
      expect(typeof ticket).toBe("string");

      // 2. Open WebSocket with the ticket
      const wsUrl = `ws://localhost:${ctx.handle.port}/xrpc/space.roomy.sync.subscribe?ticket=${ticket}`;
      const ws = new WebSocket(wsUrl);

      // 3. Wait for connection open
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket connection failed"));
        // Safety timeout
        setTimeout(() => reject(new Error("Timeout waiting for WS open")), 5000);
      });

      // 4. Close cleanly
      ws.close();
      await new Promise<void>((resolve) => {
        ws.onclose = () => resolve();
      });
    },
    { timeout: 10000 },
  );

  test(
    "bad ticket → WS closes with error",
    async () => {
      const ctx = await setupSyncSpace();

      const wsUrl = `ws://localhost:${ctx.handle.port}/xrpc/space.roomy.sync.subscribe?ticket=invalid-ticket`;
      const ws = new WebSocket(wsUrl);

      const closeEvent = await new Promise<{ code: number; reason: string }>(
        (resolve, reject) => {
          ws.onclose = (event) => resolve({ code: event.code, reason: event.reason });
          ws.onerror = () => {
            // Error may fire before close; ignore, close will follow.
          };
          setTimeout(
            () => reject(new Error("Timeout waiting for WS close")),
            5000,
          );
        },
      );

      // The router closes with a non-1000 code for auth errors.
      // Bun uses 1002 (protocol error) when the server rejects the upgrade.
      // Either way, it should not be 1000 (normal closure).
      expect(closeEvent.code).not.toBe(1000);
    },
    { timeout: 10000 },
  );

  test(
    "missing ticket → 401 HTTP response",
    async () => {
      const ctx = await setupSyncSpace();

      const res = await ctx.anonFetch(
        `${ctx.baseUrl}/xrpc/space.roomy.sync.subscribe`,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body).toHaveProperty("error");
      expect(body.error).toBe("AuthRequired");
    },
    { timeout: 10000 },
  );
});
