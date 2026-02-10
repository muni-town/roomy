/**
 * Message sync E2E tests.
 * Tests Discord -> Roomy message synchronization:
 * - Basic message sync
 * - Message edits
 * - Message deletions
 * - Attachments (images, files, videos)
 * - Reply messages
 * - Thread starter messages
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  createTestBot,
  connectGuildToNewSpace,
  initE2ERoomyClient,
  getTextChannels,
  createBridgeForTest,
} from "../helpers/setup.js";
import {
  assertEventTypeExists,
  assertEventTypeCount,
} from "../helpers/assertions.js";
import { fromBytes, StreamIndex } from "@roomy/sdk";
import { TEST_GUILD_ID } from "../fixtures/test-data.js";
import { registeredBridges } from "../../../src/repositories/LevelDBBridgeRepository.js";
import { connectedSpaces } from "../../../src/roomy/client.js";

describe("E2E: Discord Message Sync (D→R)", () => {
  beforeAll(async () => {
    // Initialize Roomy client once
    await initE2ERoomyClient();
    console.log("Roomy client initialized for E2E message sync tests");
  }, 60000);

  beforeEach(async () => {
    // Aggressive cleanup for each test to ensure clean slate
    // NOTE: This uses clear() which can affect other test files running in parallel
    // Tests should be run individually until better database isolation is implemented
    // await registeredBridges.clear();// DISABLED: Database cleanup causing issues between test files
    // NOTE: Database cleanup disabled due to LevelDB state issues between test files
    // Each test creates its own space, so cleanup isn't strictly necessary
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  afterEach(async () => {
    // afterEach cleanup is now handled by beforeEach in the next test
  });

  describe("Basic Message Sync", () => {
    it("MSG-D2R-01: should sync a basic text message", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Message Sync Test - ${Date.now()}`,
      );

      // Create orchestrator
      const bridge = await createBridgeForTest(result, bot);

      // Fetch channels from Discord
      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      expect(channels.length).toBeGreaterThan(0);

      // Sync the first channel
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create a test message in Discord
      const testContent = `Test message at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      // Sync the message to Roomy
      const roomyMessageId = await bridge.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );

      // Verify: Message was synced
      expect(roomyMessageId).toBeDefined();

      // Verify: createMessage event exists
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const createMessageEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.createMessage.v0",
      );

      expect(createMessageEvents.length).toBeGreaterThan(0);

      // Verify: Message has correct content
      const syncedMessage = createMessageEvents.find(
        (e: any) => e.id === roomyMessageId,
      );
      expect(syncedMessage).toBeDefined();
      // Message body structure: { mimeType: string, data: Bytes }
      const bodyData = fromBytes(syncedMessage!.body?.data);
      expect(bodyData).toBeDefined();
      const decodedContent = new TextDecoder().decode(bodyData);
      expect(decodedContent).toBe(testContent);

      // Verify: discordOrigin extension with correct snowflake
      const origin =
        syncedMessage?.extensions?.[
          "space.roomy.extension.discordMessageOrigin.v0"
        ];
      expect(origin).toBeDefined();
      expect(origin?.snowflake).toBe(testMessage.id.toString());

      // Verify: Mapping exists in syncedIds
      const mappedRoomyId = await result.guildContext.syncedIds.get_discordId(
        testMessage.id.toString(),
      );
      expect(mappedRoomyId).toBe(roomyMessageId);

      // Clean up: Delete test message
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);

    it("MSG-D2R-01: should sync multiple messages in order", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Multiple Message Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create multiple test messages
      const messages: string[] = [];
      for (let i = 0; i < 3; i++) {
        const content = `Batch test message ${i} at ${Date.now()}`;
        messages.push(content);
        await bot.helpers.sendMessage(firstChannel.id, { content });
        // Small delay to ensure different timestamps
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Fetch all messages from Discord
      const discordMessages = await bot.rest.getMessages(firstChannel.id, {
        limit: 3,
      });

      // Sync all messages to Roomy
      const roomyMessageIds: (string | null)[] = [];
      for (const msg of discordMessages) {
        const roomId = await bridge.handleDiscordMessageCreate(
          msg,
          roomyRoomId,
        );
        roomyMessageIds.push(roomId);
      }

      // Verify: All messages were synced
      expect(roomyMessageIds.filter(Boolean).length).toBe(3);

      // Verify: All messages have createMessage events
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 500)
      ).map((e: any) => e.event);
      const createMessageEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.createMessage.v0",
      );

      expect(createMessageEvents.length).toBeGreaterThanOrEqual(3);

      // Clean up: Delete test messages
      for (const msg of discordMessages) {
        await bot.helpers.deleteMessage(firstChannel.id, msg.id);
      }
    }, 45000);
  });

  describe("Message Edit Sync", () => {
    it("MSG-D2R-04: should sync message edits", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Message Edit Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create a test message
      const originalContent = `Original message at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: originalContent,
      });

      // Sync the original message
      const roomyMessageId = await bridge.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );
      expect(roomyMessageId).toBeDefined();

      // Wait for event materialization
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Edit the message
      const editedContent = `Edited message at ${Date.now()}`;
      const editedMessage = await bot.helpers.editMessage(
        firstChannel.id,
        testMessage.id,
        {
          content: editedContent,
        },
      );

      // Sync the edit to Roomy
      await bridge.handleDiscordMessageUpdate(editedMessage);

      // Wait for event materialization
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify: editMessage event exists
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const editMessageEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.editMessage.v0",
      );

      expect(editMessageEvents.length).toBeGreaterThan(0);

      // Verify: Edit event has correct new content
      const editEvent = editMessageEvents.find(
        (e: any) => e.messageId === roomyMessageId,
      );
      expect(editEvent).toBeDefined();
      // Edit event body structure: { mimeType: string, data: Bytes }
      const editBodyData = fromBytes(editEvent!.body?.data);
      expect(editBodyData).toBeDefined();
      const decodedEdit = new TextDecoder().decode(editBodyData);
      expect(decodedEdit).toBe(editedContent);

      // Verify: discordMessageOrigin extension has editedTimestamp
      const origin =
        editEvent?.extensions?.[
          "space.roomy.extension.discordMessageOrigin.v0"
        ];
      expect(origin).toBeDefined();
      expect(origin?.editedTimestamp).toBeDefined();
      expect(origin?.editedTimestamp).toBeGreaterThan(0);

      // Clean up: Delete test message
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);

    it("MSG-D2R-04: should be idempotent - duplicate edits are skipped", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Edit Idempotency Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create and sync a message
      const originalContent = `Idempotency test message at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: originalContent,
      });
      await bridge.handleDiscordMessageCreate(testMessage);

      // Edit the message
      const editedContent = `Edited for idempotency at ${Date.now()}`;
      const editedMessage = await bot.helpers.editMessage(
        firstChannel.id,
        testMessage.id,
        {
          content: editedContent,
        },
      );

      // First edit sync
      await bridge.handleDiscordMessageUpdate(editedMessage);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events1 = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const editEvents1 = events1.filter(
        (e: any) => e.$type === "space.roomy.message.editMessage.v0",
      );

      // Second edit sync with same data (should be skipped due to hash check)
      await bridge.handleDiscordMessageUpdate(editedMessage);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events2 = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const editEvents2 = events2.filter(
        (e: any) => e.$type === "space.roomy.message.editMessage.v0",
      );

      // Should not have created a new edit event
      expect(editEvents2.length).toBe(editEvents1.length);

      // Clean up: Delete test message
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });

  describe("Message Delete Sync", () => {
    it("MSG-D2R-05: should sync message deletions", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Message Delete Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create and sync a message
      const testContent = `Message to delete at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      const roomyMessageId = await bridge.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );
      expect(roomyMessageId).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Delete the message from Discord
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);

      // Sync the deletion to Roomy
      await bridge.handleDiscordMessageDelete(
        testMessage.id,
        firstChannel.id,
      );

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify: deleteMessage event exists
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const deleteMessageEvents = events.filter(
        (e: any) => e.$type === "space.roomy.message.deleteMessage.v0",
      );

      expect(deleteMessageEvents.length).toBeGreaterThan(0);

      // Verify: Delete event targets correct message
      const deleteEvent = deleteMessageEvents.find(
        (e: any) => e.messageId === roomyMessageId,
      );
      expect(deleteEvent).toBeDefined();
    }, 30000);
  });

  describe("Message Idempotency", () => {
    it("IDM-04: should not duplicate messages on re-sync", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Message Idempotency Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create a test message
      const testContent = `Idempotency test at ${Date.now()}`;
      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: testContent,
      });

      // First sync
      const roomId1 = await bridge.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events1 = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const messageEvents1 = events1.filter(
        (e: any) => e.$type === "space.roomy.message.createMessage.v0",
      );

      // Second sync with same message
      const roomId2 = await bridge.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events2 = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const messageEvents2 = events2.filter(
        (e: any) => e.$type === "space.roomy.message.createMessage.v0",
      );

      // Verify: Same room ID returned
      expect(roomId1).toBe(roomId2);

      // Verify: No new createMessage event created
      expect(messageEvents2.length).toBe(messageEvents1.length);

      // Clean up: Delete test message
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });

  describe("Reply Messages", () => {
    it("MSG-D2R-06: should handle reply messages", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Reply Message Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create original message
      const originalContent = `Original message for reply at ${Date.now()}`;
      const originalMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: originalContent,
      });

      // Sync original message
      await bridge.handleDiscordMessageCreate(
        originalMessage,
        roomyRoomId,
      );

      // Create reply message
      const replyContent = `Reply at ${Date.now()}`;
      const replyMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: replyContent,
        messageReference: {
          messageId: originalMessage.id,
        },
      });

      // Sync reply message
      const roomyReplyId = await bridge.handleDiscordMessageCreate(
        replyMessage,
        roomyRoomId,
      );

      expect(roomyReplyId).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify: Reply message has reply attachment
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const replyEvent = events.find((e: any) => e.id === roomyReplyId);

      expect(replyEvent).toBeDefined();

      // Check for reply attachment in extensions
      const attachmentsExt =
        replyEvent?.extensions?.["space.roomy.extension.attachments.v0"];
      expect(attachmentsExt).toBeDefined();

      const replyAttachment = attachmentsExt?.attachments?.find(
        (a: any) => a.$type === "space.roomy.attachment.reply.v0",
      );
      expect(replyAttachment).toBeDefined();

      // Verify the reply attachment targets the original message
      const originalRoomyId = await result.guildContext.syncedIds.get_discordId(
        originalMessage.id.toString(),
      );
      expect(replyAttachment?.target).toBe(originalRoomyId);

      // Clean up: Delete test messages
      await bot.helpers.deleteMessage(firstChannel.id, replyMessage.id);
      await bot.helpers.deleteMessage(firstChannel.id, originalMessage.id);
    }, 30000);
  });

  describe("Attachment Messages", () => {
    it.skip("MSG-D2R-02: should sync message with image attachment", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Image Attachment Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create a message with an image attachment
      // Using a simple 1x1 red PNG (base64)
      const imageData =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
      const imageBuffer = Buffer.from(imageData, "base64");

      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: `Test image at ${Date.now()}`,
        files: [
          {
            name: "test.png",
            data: imageBuffer,
          },
        ],
      });

      // Sync the message
      const roomyMessageId = await bridge.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );

      expect(roomyMessageId).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify: Message has image attachment
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const messageEvent = events.find((e: any) => e.id === roomyMessageId);

      expect(messageEvent).toBeDefined();

      const attachmentsExt =
        messageEvent?.extensions?.["space.roomy.extension.attachments.v0"];
      expect(attachmentsExt).toBeDefined();

      const imageAttachment = attachmentsExt?.attachments?.find(
        (a: any) => a.$type === "space.roomy.attachment.image.v0",
      );
      expect(imageAttachment).toBeDefined();
      expect(imageAttachment?.mimeType).toContain("image/");

      // Clean up: Delete test message
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);

    it.skip("MSG-D2R-03: should sync message with file attachment", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E File Attachment Test - ${Date.now()}`,
      );

      const bridge = await createBridgeForTest(result, bot);

      const channels = await getTextChannels(bot, TEST_GUILD_ID);
      const firstChannel = channels[0];
      const roomyRoomId =
        await bridge.handleDiscordChannelCreate(firstChannel);

      // Create a message with a text file attachment
      const fileContent = "Test file content";
      const fileBuffer = Buffer.from(fileContent, "utf-8");

      const testMessage = await bot.helpers.sendMessage(firstChannel.id, {
        content: `Test file at ${Date.now()}`,
        files: [
          {
            name: "test.txt",
            data: fileBuffer,
          },
        ],
      });

      // Sync the message
      const roomyMessageId = await bridge.handleDiscordMessageCreate(
        testMessage,
        roomyRoomId,
      );

      expect(roomyMessageId).toBeDefined();

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify: Message has file attachment
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const messageEvent = events.find((e: any) => e.id === roomyMessageId);

      expect(messageEvent).toBeDefined();

      const attachmentsExt =
        messageEvent?.extensions?.["space.roomy.extension.attachments.v0"];
      expect(attachmentsExt).toBeDefined();

      const fileAttachment = attachmentsExt?.attachments?.find(
        (a: any) => a.$type === "space.roomy.attachment.file.v0",
      );
      expect(fileAttachment).toBeDefined();
      expect(fileAttachment?.name).toBe("test.txt");

      // Clean up: Delete test message
      await bot.helpers.deleteMessage(firstChannel.id, testMessage.id);
    }, 30000);
  });
});
