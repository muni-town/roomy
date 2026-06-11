/**
 * MockRoomyGateway: in-memory event capture for tests.
 *
 * Drop-in replacement for the old createMockSpaceManager tests.
 * Records all events in a per-space map. No vi.fn() needed.
 */

import { type Event } from "@roomy-space/sdk";
import { MockRoomyGateway } from "../../../roomy/mock-gateway.ts";
export { MockRoomyGateway };
export type { RoomyGateway } from "../../../roomy/gateway.ts";