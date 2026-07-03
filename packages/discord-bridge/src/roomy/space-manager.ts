import { transport } from "@roomy-space/sdk";
import type { RoomyClient } from "@roomy-space/sdk";
import { createLogger } from "../logger.ts";

const log = createLogger("spaces");

export class SpaceManager {
	#xrpc: transport.DirectXrpcClient;
	#spaces = new Map<string, { streamDid: string }>();

	constructor(client: RoomyClient, appserverUrl: string, appserverDid: string) {
		const serviceAuth = new transport.ServiceAuthClient(client.agent);
		this.#xrpc = new transport.DirectXrpcClient(appserverUrl, appserverDid, serviceAuth);
	}

	/** Expose the XRPC client for use by LiveRoomyGateway. */
	get xrpc(): transport.DirectXrpcClient {
		return this.#xrpc;
	}

	async getOrConnect(spaceDid: string): Promise<{ streamDid: string }> {
		const existing = this.#spaces.get(spaceDid);
		if (existing) return existing;

		log.info(`Connecting to space ${spaceDid}...`);
		// Verify space exists via XRPC
		await this.#xrpc.query("space.roomy.space.getMetadata", { spaceId: spaceDid });

		const entry = { streamDid: spaceDid };
		this.#spaces.set(spaceDid, entry);
		log.info(`Connected to space ${spaceDid}`);
		return entry;
	}

	get(spaceDid: string): { streamDid: string } | undefined {
		return this.#spaces.get(spaceDid);
	}

	async disconnectAll(): Promise<void> {
		this.#spaces.clear();
	}
}
