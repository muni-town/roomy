/**
 * Mock SpaceManager for service unit tests.
 *
 * Provides a controllable mock of the SpaceManager class that records
 * all calls to getOrConnect and allows assertion on the events passed
 * to each space's sendEvent / sendEvents.
 */

import { type Event, type Ulid } from "@roomy-space/sdk";
import type { SpaceManager } from "../../roomy/space-manager.ts";

export interface MockSpace {
  sendEvent: ReturnType<typeof vi.fn>;
  sendEvents: ReturnType<typeof vi.fn>;
  unsubscribe: ReturnType<typeof vi.fn>;
}

export interface MockSpaceManager {
  /** The underlying mock — cast to SpaceManager when passing to services. */
  _manager: SpaceManager;

  /** Get the mock space for a given DID (creates lazily on getOrConnect). */
  space(spaceDid: string): MockSpace;

  /** Get all events sent to a given space via sendEvent. */
  eventsFor(spaceDid: string): Event[];

  /** Reset all mocks and clear spaces. */
  reset(): void;

  /** Assert that sendEvent was called for a given space with matching event type. */
  expectEvent(spaceDid: string, $type: string): Event;

  /** Assert that sendEvents was called for a given space. */
  expectEvents(spaceDid: string, count?: number): Event[][];
}

export function createMockSpaceManager(): MockSpaceManager {
  const spaces = new Map<string, MockSpace>();

  function ensure(spaceDid: string): MockSpace {
    let s = spaces.get(spaceDid);
    if (!s) {
      s = {
        sendEvent: vi.fn().mockResolvedValue(undefined),
        sendEvents: vi.fn().mockResolvedValue(undefined),
        unsubscribe: vi.fn().mockResolvedValue(undefined),
      };
      spaces.set(spaceDid, s);
    }
    return s;
  }

  const getOrConnect = vi.fn(async (spaceDid: string) => {
    const s = ensure(spaceDid);
    return {
      sendEvent: s.sendEvent,
      sendEvents: s.sendEvents,
      unsubscribe: s.unsubscribe,
      // Minimal ConnectedSpace shape — add fields as needed
      streamDid: spaceDid,
    } as any;
  });

  const disconnectAll = vi.fn().mockResolvedValue(undefined);

  const manager = {
    getOrConnect,
    disconnectAll,
  } as unknown as SpaceManager;

  return {
    _manager: manager,
    space(spaceDid: string) {
      return ensure(spaceDid);
    },
    eventsFor(spaceDid: string): Event[] {
      const s = ensure(spaceDid);
      return s.sendEvent.mock.calls.map((call: unknown[]) => call[0] as Event);
    },
    reset() {
      spaces.clear();
      getOrConnect.mockReset();
      getOrConnect.mockResolvedValue(undefined as any);
      // Re-bind default behaviour
      getOrConnect.mockImplementation(async (spaceDid: string) => {
        const s = ensure(spaceDid);
        return {
          sendEvent: s.sendEvent,
          sendEvents: s.sendEvents,
          unsubscribe: s.unsubscribe,
          streamDid: spaceDid,
        } as any;
      });
      disconnectAll.mockReset();
      disconnectAll.mockResolvedValue(undefined);
    },
    expectEvent(spaceDid: string, $type: string): Event {
      const events = this.eventsFor(spaceDid);
      const evt = events.find((e) => e.$type === $type);
      if (!evt) {
        throw new Error(
          `Expected event ${$type} for ${spaceDid}, got: ${events.map((e) => e.$type).join(", ")}`,
        );
      }
      return evt;
    },
    expectEvents(spaceDid: string, count?: number): Event[][] {
      const s = ensure(spaceDid);
      const calls = s.sendEvents.mock.calls as unknown as Event[][];
      if (count !== undefined && calls.length !== count) {
        throw new Error(
          `Expected ${count} sendEvents call(s) for ${spaceDid}, got ${calls.length}`,
        );
      }
      return calls;
    },
  };
}