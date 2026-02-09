/**
 * Profile sync E2E tests.
 * Tests Discord -> Roomy user profile synchronization:
 * - Basic profile sync (username, avatar)
 * - Profile idempotency (hash-based change detection)
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import {
  createTestBot,
  connectGuildToNewSpace,
  initE2ERoomyClient,
  getTextChannels,
  createSyncOrchestratorForTest,
} from "../helpers/setup.js";
import { TEST_GUILD_ID } from "../fixtures/test-data.js";
import { registeredBridges } from "../../../src/repositories/db.js";
import { connectedSpaces } from "../../../src/roomy/client.js";
import type { DiscordUser } from "../../../src/services/ProfileSyncService.js";
import { StreamIndex } from "@roomy/sdk";

describe("E2E: Discord Profile Sync (D→R)", () => {
  beforeAll(async () => {
    // Initialize Roomy client once
    await initE2ERoomyClient();
    console.log("Roomy client initialized for E2E profile sync tests");
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

  describe("Profile Sync", () => {
    it("PRF-D2R-01: should sync user profile (username, avatar)", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Profile Sync Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch bot user info from Discord
      const botUser = await bot.rest.getUser(bot.id);

      // Build DiscordUser object
      const discordUser: DiscordUser = {
        id: botUser.id,
        username: botUser.username,
        discriminator: botUser.discriminator,
        globalName: (botUser as any).globalName ?? null,
        avatar: (botUser.avatar as unknown as string | null) ?? null,
      };

      // Sync the profile
      await orchestrator.handleDiscordUserProfile(discordUser);

      // Wait for profile event to be materialized
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Verify: updateProfile event exists
      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const updateProfileEvents = events.filter(
        (e: any) => e.$type === "space.roomy.user.updateProfile.v0",
      );

      expect(updateProfileEvents.length).toBeGreaterThan(0);

      // Verify: Profile event has correct DID
      const expectedDid = `did:discord:${botUser.id}`;
      const profileEvent = updateProfileEvents.find(
        (e: any) => e.did === expectedDid,
      );
      expect(profileEvent).toBeDefined();

      // Verify: Profile has correct name (globalName or username)
      const expectedName = discordUser.globalName ?? discordUser.username;
      expect(profileEvent?.name).toBe(expectedName);

      // Verify: Profile has avatar URL
      expect(profileEvent?.avatar).toBeDefined();
      expect(typeof profileEvent?.avatar).toBe("string");
      expect(profileEvent?.avatar).toMatch(/discord(app)?\.com/);

      // Verify: discordUserOrigin extension with correct snowflake
      const origin =
        profileEvent?.extensions?.[
          "space.roomy.extension.discordUserOrigin.v0"
        ];
      expect(origin).toBeDefined();
      expect(origin?.snowflake).toBe(botUser.id.toString());
      expect(origin?.guildId).toBe(result.guildId.toString());
      expect(origin?.handle).toBe(
        `${discordUser.username}#${discordUser.discriminator}`,
      );

      // Verify: Profile hash is present in extension
      expect(origin?.profileHash).toBeDefined();
      expect(typeof origin?.profileHash).toBe("string");
      expect(origin?.profileHash).toHaveLength(32); // SHA-256 truncated to 32 hex chars
    }, 30000);

    it("PRF-D2R-02: should be idempotent - hash prevents redundant updates", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Profile Idempotency Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch bot user info from Discord
      const botUser = await bot.rest.getUser(bot.id);

      // Build DiscordUser object
      const discordUser: DiscordUser = {
        id: botUser.id,
        username: botUser.username,
        discriminator: botUser.discriminator,
        globalName: (botUser as any).globalName ?? null,
        avatar: (botUser.avatar as unknown as string | null) ?? null,
      };

      // First profile sync
      await orchestrator.handleDiscordUserProfile(discordUser);
      await new Promise((resolve) => setTimeout(resolve, 500));

      let events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      let profileEvents = events.filter(
        (e: any) => e.$type === "space.roomy.user.updateProfile.v0",
      );

      const expectedDid = `did:discord:${botUser.id}`;
      const firstProfileEvent = profileEvents.find(
        (e: any) => e.did === expectedDid,
      );

      expect(firstProfileEvent).toBeDefined();

      // Second profile sync with same data (should be skipped due to hash check)
      await orchestrator.handleDiscordUserProfile(discordUser);
      await new Promise((resolve) => setTimeout(resolve, 500));

      events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      profileEvents = events.filter(
        (e: any) => e.$type === "space.roomy.user.updateProfile.v0",
      );

      // Count events for this user
      const userProfileEvents = profileEvents.filter(
        (e: any) => e.did === expectedDid,
      );

      // Should still have only 1 profile event for this user (idempotent)
      expect(userProfileEvents.length).toBe(1);

      // The profile event should be the same as the first one
      const secondProfileEvent = userProfileEvents.find(
        (e: any) => e.did === expectedDid,
      );
      expect(secondProfileEvent?.id).toBe(firstProfileEvent?.id);
    }, 30000);
  });

  describe("Profile Update Detection", () => {
    it("should sync profile when username changes", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Profile Change Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch bot user info from Discord
      const botUser = await bot.rest.getUser(bot.id);

      // Build DiscordUser object with initial username
      const discordUser: DiscordUser = {
        id: botUser.id,
        username: botUser.username,
        discriminator: botUser.discriminator,
        globalName: (botUser as any).globalName ?? null,
        avatar: (botUser.avatar as unknown as string | null) ?? null,
      };

      // First profile sync
      await orchestrator.handleDiscordUserProfile(discordUser);
      await new Promise((resolve) => setTimeout(resolve, 500));

      let events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      let profileEvents = events.filter(
        (e: any) => e.$type === "space.roomy.user.updateProfile.v0",
      );

      const expectedDid = `did:discord:${botUser.id}`;

      // Modify the username (simulating a profile change)
      const modifiedUser: DiscordUser = {
        ...discordUser,
        username: "ModifiedUsername",
        globalName: "Modified Global Name",
      };

      // Sync the modified profile
      await orchestrator.handleDiscordUserProfile(modifiedUser);
      await new Promise((resolve) => setTimeout(resolve, 500));

      events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      profileEvents = events.filter(
        (e: any) => e.$type === "space.roomy.user.updateProfile.v0",
      );

      // Should have 2 profile events for this user (original + update)
      const userProfileEvents = profileEvents.filter(
        (e: any) => e.did === expectedDid,
      );
      expect(userProfileEvents.length).toBe(2);

      // Verify: The latest profile has the updated name
      const latestProfile = userProfileEvents[userProfileEvents.length - 1];
      expect(latestProfile?.name).toBe("Modified Global Name");

      // Verify: Profile hash is different
      const firstEvent = userProfileEvents[0];
      const firstHash =
        firstEvent?.extensions?.["space.roomy.extension.discordUserOrigin.v0"]
          ?.profileHash;
      const latestHash =
        latestProfile?.extensions?.[
          "space.roomy.extension.discordUserOrigin.v0"
        ]?.profileHash;

      expect(firstHash).toBeDefined();
      expect(latestHash).toBeDefined();
      expect(latestHash).not.toBe(firstHash);
    }, 30000);

    it("should sync profile when avatar changes", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Avatar Change Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Fetch bot user info from Discord
      const botUser = await bot.rest.getUser(bot.id);

      // Build DiscordUser object
      const discordUser: DiscordUser = {
        id: botUser.id,
        username: botUser.username,
        discriminator: botUser.discriminator,
        globalName: (botUser as any).globalName ?? null,
        avatar: (botUser.avatar as unknown as string | null) ?? null,
      };

      // First profile sync
      await orchestrator.handleDiscordUserProfile(discordUser);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Modify the avatar hash (simulating an avatar change)
      const modifiedUser: DiscordUser = {
        ...discordUser,
        avatar: "different_avatar_hash_12345",
      };

      // Sync the modified profile
      await orchestrator.handleDiscordUserProfile(modifiedUser);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const profileEvents = events.filter(
        (e: any) => e.$type === "space.roomy.user.updateProfile.v0",
      );

      const expectedDid = `did:discord:${botUser.id}`;
      const userProfileEvents = profileEvents.filter(
        (e: any) => e.did === expectedDid,
      );

      // Should have 2 profile events (original + avatar update)
      expect(userProfileEvents.length).toBe(2);

      // Verify: Profile hashes are different
      const firstEvent = userProfileEvents[0];
      const latestEvent = userProfileEvents[1];
      const firstHash =
        firstEvent?.extensions?.["space.roomy.extension.discordUserOrigin.v0"]
          ?.profileHash;
      const latestHash =
        latestEvent?.extensions?.["space.roomy.extension.discordUserOrigin.v0"]
          ?.profileHash;

      expect(firstHash).toBeDefined();
      expect(latestHash).toBeDefined();
      expect(latestHash).not.toBe(firstHash);
    }, 30000);
  });

  describe("Profile Fields", () => {
    it("should use globalName as display name when available", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Global Name Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Create a user with both globalName and username
      const discordUser: DiscordUser = {
        id: 123456789n,
        username: "plain_username",
        discriminator: "0001",
        globalName: "Fancy Display Name",
        avatar: null,
      };

      // Sync the profile
      await orchestrator.handleDiscordUserProfile(discordUser);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const profileEvents = events.filter(
        (e: any) => e.$type === "space.roomy.user.updateProfile.v0",
      );

      const expectedDid = `did:discord:123456789`;
      const profileEvent = profileEvents.find(
        (e: any) => e.did === expectedDid,
      );

      expect(profileEvent).toBeDefined();

      // Verify: globalName is used as display name
      expect(profileEvent?.name).toBe("Fancy Display Name");

      // Verify: Handle contains username#discriminator
      const origin =
        profileEvent?.extensions?.[
          "space.roomy.extension.discordUserOrigin.v0"
        ];
      expect(origin?.handle).toBe("plain_username#0001");
    }, 30000);

    it("should fall back to username when globalName is null", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Fallback Name Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Create a user without globalName
      const discordUser: DiscordUser = {
        id: 987654321n,
        username: "fallback_username",
        discriminator: "4242",
        globalName: null,
        avatar: null,
      };

      // Sync the profile
      await orchestrator.handleDiscordUserProfile(discordUser);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const profileEvents = events.filter(
        (e: any) => e.$type === "space.roomy.user.updateProfile.v0",
      );

      const expectedDid = `did:discord:987654321`;
      const profileEvent = profileEvents.find(
        (e: any) => e.did === expectedDid,
      );

      expect(profileEvent).toBeDefined();

      // Verify: username is used as fallback display name
      expect(profileEvent?.name).toBe("fallback_username");

      // Verify: Handle contains username#discriminator
      const origin =
        profileEvent?.extensions?.[
          "space.roomy.extension.discordUserOrigin.v0"
        ];
      expect(origin?.handle).toBe("fallback_username#4242");
    }, 30000);

    it("should handle null avatar gracefully", async () => {
      const roomy = await initE2ERoomyClient();
      const bot = await createTestBot();

      // Connect guild to new space
      const result = await connectGuildToNewSpace(
        roomy,
        TEST_GUILD_ID,
        `E2E Null Avatar Test - ${Date.now()}`,
      );

      // Create orchestrator
      const orchestrator = createSyncOrchestratorForTest(result, bot);

      // Create a user without avatar
      const discordUser: DiscordUser = {
        id: 111222333n,
        username: "no_avatar_user",
        discriminator: "0000",
        globalName: null,
        avatar: null,
      };

      // Sync the profile
      await orchestrator.handleDiscordUserProfile(discordUser);
      await new Promise((resolve) => setTimeout(resolve, 500));

      const events = (
        await result.connectedSpace.fetchEvents(1 as StreamIndex, 200)
      ).map((e: any) => e.event);
      const profileEvents = events.filter(
        (e: any) => e.$type === "space.roomy.user.updateProfile.v0",
      );

      const expectedDid = `did:discord:111222333`;
      const profileEvent = profileEvents.find(
        (e: any) => e.did === expectedDid,
      );

      expect(profileEvent).toBeDefined();

      // Verify: Avatar URL is still generated (Discord default avatar)
      expect(profileEvent?.avatar).toBeDefined();
      expect(typeof profileEvent?.avatar).toBe("string");
      // Discord default avatar URLs contain "discord" and "avatars"
      expect(profileEvent?.avatar).toMatch(/discord(app)?\.com.*avatars/);
    }, 30000);
  });
});
