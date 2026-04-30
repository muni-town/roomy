import { ConnectedSpace, StreamDid, modules } from "@roomy-space/sdk";
import type { RoomyClient } from "@roomy-space/sdk";
import { createLogger } from "../logger.ts";

const log = createLogger("spaces");

export class SpaceManager {
  #client: RoomyClient;
  #spaces = new Map<string, ConnectedSpace>();

  constructor(client: RoomyClient) {
    this.#client = client;
  }

  async getOrConnect(spaceDid: string): Promise<ConnectedSpace> {
    const existing = this.#spaces.get(spaceDid);
    if (existing) return existing;

    log.info(`Connecting to space ${spaceDid}...`);
    const connected = await ConnectedSpace.connect({
      client: this.#client,
      streamDid: StreamDid.assert(spaceDid),
      module: modules.space,
    });
    this.#spaces.set(spaceDid, connected);
    log.info(`Connected to space ${spaceDid}`);
    return connected;
  }

  get(spaceDid: string): ConnectedSpace | undefined {
    return this.#spaces.get(spaceDid);
  }

  async disconnectAll(): Promise<void> {
    for (const [did, space] of this.#spaces) {
      log.info(`Disconnecting from space ${did}`);
      await space.unsubscribe();
    }
    this.#spaces.clear();
  }
}
