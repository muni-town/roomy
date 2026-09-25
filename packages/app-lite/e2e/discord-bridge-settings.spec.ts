/**
 * Discord Bridge settings → backfill status panel.
 *
 * Defends the panel's two user-visible guarantees: rows read channel-first
 * (sidebar order, then remaining channels, then threads) and each row's state
 * is icon-only — a check for complete, a spinner only while a walk is
 * running, an hourglass for queued work — with the synced count as the only
 * text. The bridge REST surface is fulfilled here, so the assertions cover
 * the panel's own ordering and mapping rather than the bridge's.
 *
 * The payload is deliberately shaped like the endpoint's: newest update
 * first (`ORDER BY updated_at DESC`), and with a thread whose parent channel
 * is not in the list — the two conditions under which a thread-first list
 * used to be possible.
 */

import { expect, test, waitForAuthenticated } from "./spec-helpers.ts";
import { BRIDGE_ORIGIN, SEED_ROOM_ID, SEED_SPACE_ID } from "./fixtures.ts";

const GUILD_ID = "987654321098765432";
const LOBBY_DISCORD_ID = "200000000000000001";
const DEV_DISCORD_ID = "200000000000000002";
const BIG_DISCORD_ID = "200000000000000003";
const HELP_THREAD_ID = "300000000000000001";
const ORPHAN_THREAD_ID = "300000000000000003";
/** Parent the bridge no longer enumerates, so the thread renders top-level. */
const UNBRIDGED_PARENT_ID = "200000000000000009";

/** One `backfill_progress` row as the REST endpoint serialises it. */
function row(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    spaceDid: SEED_SPACE_ID,
    guildId: GUILD_ID,
    kind: "channel",
    messagesSkipped: 0,
    cursor: null,
    parentId: null,
    windowSynced: null,
    roomyId: null,
    running: false,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

test.describe("discord bridge settings", () => {
  test("backfill panel lists channels before threads and states each row by icon", async ({
    page,
  }) => {
    // Newest update first: the orphan thread, then a pending channel and a
    // running one, then the channel the sidebar knows about and its thread.
    const channels = [
      row({
        channelId: ORPHAN_THREAD_ID,
        kind: "thread",
        channelName: "orphan-thread",
        parentId: UNBRIDGED_PARENT_ID,
        phase: "phase2",
        messagesSynced: 4,
        windowSynced: 4,
      }),
      row({
        channelId: DEV_DISCORD_ID,
        channelName: "dev-chat",
        phase: "phase1",
        messagesSynced: 0,
      }),
      row({
        channelId: BIG_DISCORD_ID,
        channelName: "big-channel",
        phase: "phase2",
        messagesSynced: 1000,
        windowSynced: 1000,
        running: true,
      }),
      row({
        channelId: LOBBY_DISCORD_ID,
        channelName: "lobby",
        phase: "complete",
        messagesSynced: 12,
        roomyId: SEED_ROOM_ID,
      }),
      row({
        channelId: HELP_THREAD_ID,
        kind: "thread",
        channelName: "help-thread",
        parentId: LOBBY_DISCORD_ID,
        phase: "phase2",
        messagesSynced: 293,
        windowSynced: 293,
      }),
    ];

    const payloadFor = (url: URL): { status: number; body: unknown } => {
      switch (url.pathname) {
        case "/info":
          return {
            status: 200,
            body: {
              discordAppId: "123456789012345678",
              bridgeDid: "did:plc:bridge",
            },
          };
        case "/get-guild-id":
          return { status: 200, body: { guildId: GUILD_ID } };
        case "/backfill/progress":
          return { status: 200, body: { channels } };
        default:
          return { status: 404, body: { error: "not stubbed" } };
      }
    };

    await page.route(`${BRIDGE_ORIGIN}/**`, async (route) => {
      const { status, body } = payloadFor(new URL(route.request().url()));
      await route.fulfill({
        status,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify(body),
      });
    });

    await page.goto(`/${SEED_SPACE_ID}/settings/discord-bridge`);
    await waitForAuthenticated(page);

    const rows = page.locator("section li");
    await expect(rows).toHaveCount(5);

    // Order and text: the sidebar-placed channel leads with its thread nested
    // under it, then the other channels, then the thread whose parent has no
    // row. A row's text is its name plus the synced count — no status words.
    const rendered = await rows.evaluateAll((els) =>
      els.map((el) => ({
        name: el.querySelector("span.truncate")?.textContent?.trim() ?? "",
        text: el.textContent?.replace(/\s+/g, " ").trim() ?? "",
        state:
          el.querySelector("[role=img]")?.getAttribute("aria-label") ?? null,
      })),
    );

    expect(rendered).toEqual([
      { name: "lobby", text: "lobby 12 synced", state: "complete" },
      {
        name: "help-thread",
        text: "help-thread 293 synced",
        state: "deep backfill queued",
      },
      { name: "dev-chat", text: "dev-chat 0 synced", state: "queued" },
      {
        name: "big-channel",
        text: "big-channel 1000 synced",
        state: "deep backfill in progress",
      },
      {
        name: "orphan-thread",
        text: "orphan-thread 4 synced",
        state: "deep backfill queued",
      },
    ]);
  });
});
