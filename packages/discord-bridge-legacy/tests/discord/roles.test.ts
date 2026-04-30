/**
 * Integration tests for bot-managed role utilities.
 *
 * Tests cover:
 * - createBridgeRole: creates a named role in the guild
 * - deleteBridgeRole: deletes a role (graceful on already-deleted)
 * - setChannelBridgePermissions: sets VIEW_CHANNEL overwrite on channels
 *
 * These tests use a mock DiscordBot to verify correct API calls
 * without hitting the real Discord API.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createBridgeRole,
  deleteBridgeRole,
  setChannelBridgePermissions,
} from "../../src/discord/roles.js";
import type { DiscordBot } from "../../src/discord/types.js";

// ─── Mock bot factory ─────────────────────────────────────────────

function createMockBot(overrides: Record<string, any> = {}): DiscordBot {
  return {
    helpers: {
      createRole: vi.fn(async () => ({ id: 999888777n })),
      deleteRole: vi.fn(async () => {}),
      editChannelPermissionOverrides: vi.fn(async () => {}),
      ...overrides,
    },
  } as any;
}

const GUILD_ID = 100200300n;

// ─── createBridgeRole ─────────────────────────────────────────────

describe("createBridgeRole", () => {
  it("creates a role named 'Roomy: <spaceName>'", async () => {
    const bot = createMockBot();

    const roleId = await createBridgeRole(bot, GUILD_ID, "My Space");

    expect(bot.helpers.createRole).toHaveBeenCalledWith(GUILD_ID, {
      name: "Roomy: My Space",
      mentionable: false,
    });
    expect(roleId).toBe("999888777");
  });

  it("returns the role snowflake as a string", async () => {
    const bot = createMockBot({
      createRole: vi.fn(async () => ({ id: 42n })),
    });

    const roleId = await createBridgeRole(bot, GUILD_ID, "Test");

    expect(typeof roleId).toBe("string");
    expect(roleId).toBe("42");
  });

  it("handles space names with special characters", async () => {
    const bot = createMockBot();

    await createBridgeRole(bot, GUILD_ID, "Café & Lounge 🍵");

    expect(bot.helpers.createRole).toHaveBeenCalledWith(
      GUILD_ID,
      expect.objectContaining({ name: "Roomy: Café & Lounge 🍵" }),
    );
  });

  it("propagates errors from the Discord API", async () => {
    const bot = createMockBot({
      createRole: vi.fn(async () => {
        throw new Error("Missing Permissions");
      }),
    });

    await expect(
      createBridgeRole(bot, GUILD_ID, "Test"),
    ).rejects.toThrow("Missing Permissions");
  });
});

// ─── deleteBridgeRole ─────────────────────────────────────────────

describe("deleteBridgeRole", () => {
  it("deletes the role by guild and role ID", async () => {
    const bot = createMockBot();

    await deleteBridgeRole(bot, GUILD_ID, "555666777");

    expect(bot.helpers.deleteRole).toHaveBeenCalledWith(
      GUILD_ID,
      555666777n,
    );
  });

  it("does not throw if the role was already deleted", async () => {
    const bot = createMockBot({
      deleteRole: vi.fn(async () => {
        throw new Error("Unknown Role");
      }),
    });

    // Should not throw — graceful handling
    await expect(
      deleteBridgeRole(bot, GUILD_ID, "123"),
    ).resolves.toBeUndefined();
  });

  it("converts string roleId to bigint for the API call", async () => {
    const bot = createMockBot();

    await deleteBridgeRole(bot, GUILD_ID, "123456789012345678");

    expect(bot.helpers.deleteRole).toHaveBeenCalledWith(
      GUILD_ID,
      123456789012345678n,
    );
  });
});

// ─── setChannelBridgePermissions ──────────────────────────────────

describe("setChannelBridgePermissions", () => {
  it("sets VIEW_CHANNEL permission on each channel", async () => {
    const bot = createMockBot();
    const channelIds = ["111", "222", "333"];
    const roleId = "999";

    await setChannelBridgePermissions(bot, channelIds, roleId);

    expect(bot.helpers.editChannelPermissionOverrides).toHaveBeenCalledTimes(3);

    // Verify each call
    for (const chId of channelIds) {
      expect(bot.helpers.editChannelPermissionOverrides).toHaveBeenCalledWith(
        BigInt(chId),
        expect.objectContaining({
          id: 999n,
          type: 0,
          allow: ["VIEW_CHANNEL"],
          deny: [],
        }),
      );
    }
  });

  it("handles empty channel list without errors", async () => {
    const bot = createMockBot();

    await setChannelBridgePermissions(bot, [], "999");

    expect(bot.helpers.editChannelPermissionOverrides).not.toHaveBeenCalled();
  });

  it("sets permissions in parallel", async () => {
    const callOrder: string[] = [];
    const bot = createMockBot({
      editChannelPermissionOverrides: vi.fn(async (channelId: bigint) => {
        // Simulate slight delay
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(channelId.toString());
      }),
    });

    const start = Date.now();
    await setChannelBridgePermissions(bot, ["111", "222", "333"], "999");
    const elapsed = Date.now() - start;

    // All three should be called
    expect(callOrder).toHaveLength(3);
    // Parallel execution should complete in roughly 1x the delay, not 3x
    expect(elapsed).toBeLessThan(100);
  });

  it("continues processing other channels if one fails", async () => {
    let callCount = 0;
    const bot = createMockBot({
      editChannelPermissionOverrides: vi.fn(async (channelId: bigint) => {
        callCount++;
        if (channelId === 222n) {
          throw new Error("Missing Access");
        }
      }),
    });

    // Should not throw
    await expect(
      setChannelBridgePermissions(bot, ["111", "222", "333"], "999"),
    ).resolves.toBeUndefined();

    // All three should have been attempted
    expect(callCount).toBe(3);
  });

  it("converts channel and role IDs to bigint", async () => {
    const bot = createMockBot();

    await setChannelBridgePermissions(
      bot,
      ["123456789012345678"],
      "987654321098765432",
    );

    expect(bot.helpers.editChannelPermissionOverrides).toHaveBeenCalledWith(
      123456789012345678n,
      expect.objectContaining({
        id: 987654321098765432n,
      }),
    );
  });
});
