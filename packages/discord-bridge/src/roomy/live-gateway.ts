/**
 * LiveRoomyGateway: wraps SpaceManager to send events to real Roomy spaces.
 */

import type { Event } from "@roomy-space/sdk";
import type { RoomyGateway } from "./gateway.ts";
import type { SpaceManager } from "./space-manager.ts";

export class LiveRoomyGateway implements RoomyGateway {
  #spaceManager: SpaceManager;

  constructor(spaceManager: SpaceManager) {
    this.#spaceManager = spaceManager;
  }

  async sendEvent(spaceDid: string, event: Event): Promise<void> {
    const connected = await this.#spaceManager.getOrConnect(spaceDid);
    await connected.sendEvent(event);
  }

  async sendEvents(spaceDid: string, events: Event[]): Promise<void> {
    const connected = await this.#spaceManager.getOrConnect(spaceDid);
    await connected.sendEvents(events);
  }

  async disconnectAll(): Promise<void> {
    await this.#spaceManager.disconnectAll();
  }
}