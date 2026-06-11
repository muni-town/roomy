/**
 * MockRoomyGateway: in-memory event capture for tests.
 *
 * Drop-in replacement for the old createMockSpaceManager tests.
 * Records all events in a per-space map. No vi.fn() needed.
 */

import { MockRoomyGateway } from "../../../roomy/mock-gateway.ts";

export type { RoomyGateway } from "../../../roomy/gateway.ts";
export { MockRoomyGateway };
