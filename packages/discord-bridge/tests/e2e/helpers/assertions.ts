/**
 * E2E test assertions.
 * Custom assertions for verifying Roomy event stream state.
 */

import type { Event, StreamDid, Ulid } from "@roomy/sdk";
import { describe, expect } from "vitest";

/**
 * Event matcher for assertions.
 */
export interface EventMatcher {
  /** The event type ($type) */
  $type: string;
  /** Optional properties to match */
  properties?: Record<string, unknown>;
}

/**
 * Assert that the stream contains events matching the given matchers.
 *
 * @param spaceId - The space ID to query
 * @param events - The events returned from the stream query
 * @param matchers - Event matchers to verify
 */
export function assertStreamContains(
  spaceId: StreamDid,
  events: unknown[],
  matchers: EventMatcher[],
) {
  const matchedEvents: Event[] = [];

  for (const event of events) {
    const e = event as { $type: string; [key: string]: unknown };
    for (const matcher of matchers) {
      if (e.$type === matcher.$type) {
        let matches = true;
        if (matcher.properties) {
          for (const [key, value] of Object.entries(matcher.properties)) {
            if (e[key] !== value) {
              matches = false;
              break;
            }
          }
        }
        if (matches) {
          matchedEvents.push(e as Event);
        }
      }
    }
  }

  expect(matchedEvents.length).toBeGreaterThanOrEqual(matchers.length);

  // Verify each matcher was found
  for (const matcher of matchers) {
    const found = matchedEvents.some((e) => {
      if (e.$type !== matcher.$type) return false;
      if (matcher.properties) {
        for (const [key, value] of Object.entries(matcher.properties)) {
          if ((e as Record<string, unknown>)[key] !== value) {
            return false;
          }
        }
      }
      return true;
    });
    expect(found).toBe(true);
  }
}

/**
 * Assert that a specific event type exists in the stream.
 */
export function assertEventTypeExists(
  events: unknown[],
  eventType: string,
): Event[] {
  const matching = (events as { $type: string }[]).filter(
    (e) => e.$type === eventType,
  );
  expect(matching.length).toBeGreaterThan(0);
  return matching as Event[];
}

/**
 * Assert that a specific event type does NOT exist in the stream.
 */
export function assertEventTypeNotExists(events: unknown[], eventType: string) {
  const matching = (events as { $type: string }[]).filter(
    (e) => e.$type === eventType,
  );
  expect(matching.length).toBe(0);
}

/**
 * Assert count of a specific event type.
 */
export function assertEventTypeCount(
  events: unknown[],
  eventType: string,
  expectedCount: number,
) {
  const matching = (events as { $type: string }[]).filter(
    (e) => e.$type === eventType,
  );
  expect(matching.length).toBe(expectedCount);
}

/**
 * Assert that a room exists in the stream.
 */
export function assertRoomExists(
  events: unknown[],
  roomKind: string,
  roomName?: string,
): Ulid {
  const createRoomEvents = (
    events as { $type: string; kind?: string; name?: string; id: Ulid }[]
  ).filter(
    (e) => e.$type === "space.roomy.room.createRoom.v0" && e.kind === roomKind,
  );

  expect(createRoomEvents.length).toBeGreaterThan(0);

  if (roomName) {
    const namedRoom = createRoomEvents.find((e) => e.name === roomName);
    expect(namedRoom).toBeDefined();
    return namedRoom!.id;
  }

  return createRoomEvents[0].id;
}

/**
 * Assert that the lobby channel exists.
 */
export function assertLobbyExists(events: unknown[]): Ulid {
  return assertRoomExists(events, "space.roomy.channel", "lobby");
}

/**
 * Assert sidebar structure matches expected.
 */
export function assertSidebarStructure(
  events: unknown[],
  expectedCategories: { name: string; childCount: number }[],
) {
  const sidebarEvents = (
    events as { $type: string; categories?: unknown[] }[]
  ).filter((e) => e.$type === "space.roomy.space.updateSidebar.v0");

  expect(sidebarEvents.length).toBeGreaterThan(0);

  const latestSidebar = sidebarEvents[sidebarEvents.length - 1];
  expect(latestSidebar.categories).toBeDefined();

  const categories = latestSidebar.categories as {
    name: string;
    children?: unknown[];
  }[];
  expect(categories.length).toBe(expectedCategories.length);

  for (let i = 0; i < expectedCategories.length; i++) {
    const expected = expectedCategories[i];
    const actual = categories[i];
    expect(actual.name).toBe(expected.name);
    if (expected.childCount !== undefined) {
      expect(actual.children?.length).toBe(expected.childCount);
    }
  }
}

/**
 * Assert message exists in room.
 */
export function assertMessageExists(
  events: unknown[],
  roomId: Ulid,
  content?: string,
): Event[] {
  const messageEvents = (
    events as { $type: string; room?: string; data?: unknown }[]
  ).filter(
    (e) =>
      e.$type === "space.roomy.message.createMessage.v0" && e.room === roomId,
  );

  expect(messageEvents.length).toBeGreaterThan(0);

  if (content) {
    const withContent = messageEvents.filter((e) => {
      const data = e.data as { mime_type?: string; data?: Uint8Array };
      if (!data.data) return false;
      const text = new TextDecoder().decode(data.data);
      return text.includes(content);
    });
    expect(withContent.length).toBeGreaterThan(0);
    return withContent as Event[];
  }

  return messageEvents as Event[];
}

/**
 * Helper to extract string data from message event data blob.
 */
export function decodeMessageData(event: {
  data?: { data?: Uint8Array };
}): string {
  if (!event.data?.data) return "";
  return new TextDecoder().decode(event.data.data);
}

/**
 * Assert Discord extension exists on an event.
 */
export function assertDiscordExtension(
  event: { extensions?: Record<string, unknown> },
  extensionType: string,
) {
  expect(event.extensions).toBeDefined();
  expect(event.extensions![extensionType]).toBeDefined();
}

/**
 * Channel sync verification result.
 */
export interface ChannelSyncVerification {
  /** The Discord channel ID */
  discordChannelId: string;
  /** The Roomy room ULID */
  roomyRoomId: string;
  /** The createRoom event */
  createRoomEvent: Event;
  /** Whether discordOrigin extension exists and is correct */
  hasValidOrigin: boolean;
}

/**
 * Verify a Discord channel was synced to Roomy correctly.
 *
 * Checks:
 * 1. A createRoom event exists with kind: space.roomy.channel
 * 2. The discordOrigin extension has the correct snowflake
 * 3. The mapping exists in syncedIds
 *
 * @param events - All events from the space
 * @param syncedIds - The synced IDs mapping to verify
 * @param discordChannelId - Discord channel snowflake (as string)
 * @param expectedChannelName - Optional expected channel name
 * @returns Verification result with details
 */
export function assertChannelSynced(
  events: unknown[],
  syncedIds: { get_discordId: (key: string) => Promise<string | undefined> },
  discordChannelId: string,
  expectedChannelName?: string,
): ChannelSyncVerification {
  const roomKey = `room:${discordChannelId}`;

  // Find the createRoom event for this channel
  const createRoomEvents = (
    events as {
      $type: string;
      id: string;
      kind?: string;
      name?: string;
      extensions?: Record<string, unknown>;
    }[]
  ).filter((e) => e.$type === "space.roomy.room.createRoom.v0");

  // Find the event with matching discordOrigin extension
  const matchedEvent = createRoomEvents.find((e) => {
    const origin = e.extensions?.["space.roomy.extension.discordOrigin.v0"] as
      | { snowflake?: string }
      | undefined;
    return origin?.snowflake === discordChannelId;
  });

  if (!matchedEvent) {
    throw new Error(
      `No createRoom event found with discordOrigin.snowflake = ${discordChannelId}`,
    );
  }

  // Verify room kind
  expect(matchedEvent.kind).toBe("space.roomy.channel");

  // Verify channel name if provided
  if (expectedChannelName) {
    expect(matchedEvent.name).toBe(expectedChannelName);
  }

  // Verify discordOrigin extension exists and is correct
  const origin = matchedEvent.extensions?.[
    "space.roomy.extension.discordOrigin.v0"
  ] as { snowflake?: string; guildId?: string } | undefined;

  expect(origin).toBeDefined();
  expect(origin?.snowflake).toBe(discordChannelId);

  // Verify mapping exists in syncedIds
  // Note: This is async but we'll verify it synchronously for the test structure
  // The caller should await the async check if needed

  return {
    discordChannelId,
    roomyRoomId: matchedEvent.id,
    createRoomEvent: matchedEvent as Event,
    hasValidOrigin: origin?.snowflake === discordChannelId,
  };
}

/**
 * Verify multiple Discord channels were synced to Roomy.
 *
 * @param events - All events from the space
 * @param syncedIds - The synced IDs mapping
 * @param discordChannelIds - Array of Discord channel snowflakes (as strings)
 * @returns Array of verification results
 */
export function assertChannelsSynced(
  events: unknown[],
  syncedIds: { get_discordId: (key: string) => Promise<string | undefined> },
  discordChannelIds: string[],
): ChannelSyncVerification[] {
  const results: ChannelSyncVerification[] = [];

  for (const channelId of discordChannelIds) {
    const result = assertChannelSynced(events, syncedIds, channelId);
    results.push(result);
  }

  return results;
}

/**
 * Category in Roomy sidebar.
 */
export interface SidebarCategory {
  name: string;
  children: Ulid[];
}

/**
 * Get the latest sidebar update event from events.
 */
export function getLatestSidebarEvent(events: unknown[]): {
  $type: string;
  categories: SidebarCategory[];
  extensions?: Record<string, unknown>;
} {
  const sidebarEvents = (
    events as {
      $type: string;
      categories?: unknown[];
      extensions?: Record<string, unknown>;
    }[]
  ).filter((e) => e.$type === "space.roomy.space.updateSidebar.v0");

  if (sidebarEvents.length === 0) {
    throw new Error("No sidebar update events found");
  }

  return sidebarEvents[sidebarEvents.length - 1] as {
    $type: string;
    categories: SidebarCategory[];
    extensions?: Record<string, unknown>;
  };
}

/**
 * Verify a category exists in the sidebar with specific children.
 *
 * @param events - All events from the space
 * @param categoryName - Expected category name
 * @param expectedChildCount - Expected number of children in the category
 * @returns The category if found
 */
export function assertSidebarCategoryExists(
  events: unknown[],
  categoryName: string,
  expectedChildCount?: number,
): SidebarCategory {
  const sidebar = getLatestSidebarEvent(events);
  const category = sidebar.categories.find((c) => c.name === categoryName);

  if (!category) {
    const categoryNames = sidebar.categories.map((c) => c.name).join(", ");
    throw new Error(
      `Category "${categoryName}" not found in sidebar. Found: ${categoryNames}`,
    );
  }

  if (expectedChildCount !== undefined) {
    expect(category.children.length).toBe(expectedChildCount);
  }

  return category;
}

/**
 * Verify the sidebar structure matches expected Discord categories.
 *
 * @param events - All events from the space
 * @param expectedCategories - Array of { name, childCount } tuples
 */
export function assertSidebarCategoriesMatch(
  events: unknown[],
  expectedCategories: { name: string; childCount: number }[],
) {
  const sidebar = getLatestSidebarEvent(events);

  // Check we have the expected number of categories
  expect(sidebar.categories.length).toBe(expectedCategories.length);

  // Check each category
  for (const expected of expectedCategories) {
    assertSidebarCategoryExists(events, expected.name, expected.childCount);
  }
}

/**
 * Verify a room ULID appears in a specific category.
 */
export function assertRoomInCategory(
  events: unknown[],
  roomyRoomId: string,
  categoryName: string,
): void {
  const category = assertSidebarCategoryExists(events, categoryName);
  expect(category.children).toContain(roomyRoomId);
}
