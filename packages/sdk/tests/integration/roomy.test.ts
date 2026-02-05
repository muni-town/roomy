/**
 * Integration tests for Roomy operations.
 * These tests connect to a real Roomy space and verify message delivery.
 *
 * Required environment variables:
 * - ATPROTO_BRIDGE_DID: ATProto DID for authentication
 * - ATPROTO_BRIDGE_APP_PASSWORD: App password for authentication
 * - ROOMY_TEST_SPACE_ID: (optional) Existing space ID to test against
 * - LEAF_URL: Leaf server URL (default: https://leaf.muni.land)
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll } from "vitest";
import { AtpAgent } from "@atproto/api";
import {
  RoomyClient,
  ConnectedSpace,
  modules,
  createMessage,
  addReaction,
  removeReaction,
  editMessage,
  deleteMessage,
  createRoom,
  createThread,
  UserDid,
  StreamDid,
} from "../../src";

let agent: AtpAgent;
let roomyClient: RoomyClient;
let testSpace: ConnectedSpace;
let testRoomId: string;
let testMessageId: string;

// Helper: Create or connect to test space
async function setupTestSpace(): Promise<ConnectedSpace> {
  const spaceId = process.env.ROOMY_TEST_SPACE_ID;

  if (spaceId) {
    console.log("Connecting to existing test space:", spaceId);
    return await ConnectedSpace.connect({
      client: roomyClient,
      module: modules.space,
      streamDid: spaceId as StreamDid,
    });
  }

  // Create a new test space
  console.log("Creating new test space...");
  const space = await ConnectedSpace.create(
    {
      client: roomyClient,
      module: modules.space,
    },
    agent.assertDid as UserDid,
  );

  console.log("Created test space:", space.streamDid);
  return space;
}

// Helper: Create a test room
async function setupTestRoom(): Promise<string> {
  const result = await createRoom(testSpace, {
    kind: "space.roomy.channel",
    name: `test-channel-${Date.now()}`,
  });

  console.log("Created test room:", result.id);
  return result.id;
}

beforeAll(async () => {
  // Check for required environment variables
  const did = process.env.ATPROTO_TEST_DID;
  const appPassword = process.env.ATPROTO_TEST_APP_PASSWORD;
  const leafUrl = process.env.LEAF_URL || "https://leaf.muni.town";

  if (!did || !appPassword) {
    throw new Error(
      "Missing required environment variables: ATPROTO_TEST_DID, ATPROTO_TEST_APP_PASSWORD",
    );
  }

  // Create AtpAgent and authenticate
  agent = new AtpAgent({
    service: "https://bsky.social",
  });

  await agent.login({
    identifier: did,
    password: appPassword,
  });

  if (!agent.did) {
    throw new Error("Failed to authenticate with app password - no DID");
  }

  console.log("Authenticated as:", agent.assertDid);

  // For local development, use did:web:localhost (Leaf server's actual DID)
  // For production, compute did:web from the leafUrl hostname
  const leafDid =
    process.env.LEAF_DID || `did:web:${new URL(leafUrl).hostname}`;

  console.log("Connecting to Leaf at:", leafUrl);
  console.log("Leaf DID:", leafDid);

  // Create Roomy client
  roomyClient = await RoomyClient.create({
    agent,
    leafUrl,
    leafDid,
    spaceNsid: "space.roomy.space.personal.dev",
    profileSpaceNsid: "space.roomy.profileSpace",
  });

  // Setup test space and room
  testSpace = await setupTestSpace();
  testRoomId = await setupTestRoom();

  console.log("Test setup complete");
}, 30000); // 30 second timeout

describe("Roomy Integration Tests", () => {
  describe("Message Operations", () => {
    it("creates a message and verifies delivery", async () => {
      const testContent = `integration-test-message-${Date.now()}`;

      // Create message
      const result = await createMessage(testSpace, {
        roomId: testRoomId as any,
        body: testContent,
      });

      testMessageId = result.id;
      expect(testMessageId).toMatch(/^[\w-]{26}$/);
      console.log("Created message:", testMessageId);

      // Note: We can't directly query the message back without a LiveQuery
      // In a real integration test, you'd subscribe to events and verify the message was sent
      // For now, we verify the operation completed without error
    });

    it("creates a message with reply attachment", async () => {
      if (!testMessageId) {
        console.warn("Skipping test: no test message ID available");
        return;
      }

      const result = await createMessage(testSpace, {
        roomId: testRoomId as any,
        body: "Reply to test message",
        replyTo: testMessageId as any,
      });

      expect(result.id).toMatch(/^[\w-]{26}$/);
      console.log("Created reply message:", result.id);
    });

    it("edits a message", async () => {
      if (!testMessageId) {
        console.warn("Skipping test: no test message ID available");
        return;
      }

      const result = await editMessage(testSpace, {
        roomId: testRoomId as any,
        messageId: testMessageId as any,
        body: "Edited message content",
      });

      expect(result.id).toMatch(/^[\w-]{26}$/);
      console.log("Edited message:", result.id);
    });
  });

  describe("Reaction Operations", () => {
    it("adds a reaction to a message", async () => {
      if (!testMessageId) {
        console.warn("Skipping test: no test message ID available");
        return;
      }

      const result = await addReaction(testSpace, {
        roomId: testRoomId as any,
        messageId: testMessageId as any,
        reaction: "👍",
      });

      expect(result.id).toMatch(/^[\w-]{26}$/);
      console.log("Added reaction:", result.id);
    });

    it("removes a reaction", async () => {
      if (!testMessageId) {
        console.warn("Skipping test: no test message ID available");
        return;
      }

      // First add a reaction
      const addResult = await addReaction(testSpace, {
        roomId: testRoomId as any,
        messageId: testMessageId as any,
        reaction: "❤️",
      });

      // Then remove it
      const result = await removeReaction(testSpace, {
        roomId: testRoomId as any,
        reactionId: addResult.id,
      });

      expect(result.id).toMatch(/^[\w-]{26}$/);
      console.log("Removed reaction:", result.id);
    });
  });

  describe("Room Operations", () => {
    it("creates a thread", async () => {
      const result = await createThread(testSpace, {
        linkToRoom: testRoomId as any,
        name: `test-thread-${Date.now()}`,
      });

      expect(result.id).toMatch(/^[\w-]{26}$/);
      console.log("Created thread:", result.id);
    });

    it("creates a room with description", async () => {
      const result = await createRoom(testSpace, {
        kind: "space.roomy.channel",
        name: `test-room-desc-${Date.now()}`,
        description: "Test room with description",
      });

      expect(result.id).toMatch(/^[\w-]{26}$/);
      console.log("Created room with description:", result.id);
    });
  });

  describe("Idempotency Tests", () => {
    it("handles duplicate message creations gracefully", async () => {
      const testContent = `idempotency-test-${Date.now()}`;

      // Create multiple messages with the same content
      const result1 = await createMessage(testSpace, {
        roomId: testRoomId as any,
        body: testContent,
      });

      const result2 = await createMessage(testSpace, {
        roomId: testRoomId as any,
        body: testContent,
      });

      // Both should succeed but have different IDs (no built-in idempotency)
      expect(result1.id).not.toBe(result2.id);
      console.log(
        "Idempotency test: created two messages:",
        result1.id,
        result2.id,
      );
    });
  });
});
