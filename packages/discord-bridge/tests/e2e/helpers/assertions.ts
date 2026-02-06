/**
 * E2E test assertions.
 * Custom assertions for verifying Roomy event stream state.
 */

import type { Event, StreamDid, Ulid } from "@roomy-sdk/sdk";
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
  const matching = (events as { $type: string }[]).filter((e) => e.$type === eventType);
  expect(matching.length).toBeGreaterThan(0);
  return matching as Event[];
}

/**
 * Assert that a specific event type does NOT exist in the stream.
 */
export function assertEventTypeNotExists(
  events: unknown[],
  eventType: string,
) {
  const matching = (events as { $type: string }[]).filter((e) => e.$type === eventType);
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
  const matching = (events as { $type: string }[]).filter((e) => e.$type === eventType);
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
  const createRoomEvents = (events as { $type: string; kind?: string; name?: string; id: Ulid }[]).filter(
    (e) => e.$type === "space.roomy.room.createRoom.v0" && e.kind === roomKind
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
  const sidebarEvents = (events as { $type: string; categories?: unknown[] }[]).filter(
    (e) => e.$type === "space.roomy.space.updateSidebar.v0"
  );

  expect(sidebarEvents.length).toBeGreaterThan(0);

  const latestSidebar = sidebarEvents[sidebarEvents.length - 1];
  expect(latestSidebar.categories).toBeDefined();

  const categories = latestSidebar.categories as { name: string; children?: unknown[] }[];
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
  const messageEvents = (events as { $type: string; room?: string; data?: unknown }[]).filter(
    (e) => e.$type === "space.roomy.message.createMessage.v0" && e.room === roomId
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
export function decodeMessageData(event: { data?: { data?: Uint8Array } }): string {
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
