/**
 * RoomyEventRouter: subscribes to bridged Roomy spaces and routes
 * events to Discord.
 *
 * Handles the Roomy→Discord direction of the bridge:
 * - createMessage  → send to Discord via webhook
 * - editMessage    → edit in Discord
 * - deleteMessage  → delete from Discord
 * - addReaction    → add reaction in Discord
 * - removeReaction → remove reaction from Discord
 *
 * Echo prevention:
 * - Messages with discordMessageOrigin extension are skipped
 *   (they came from Discord, don't bridge back)
 * - Messages already mapped in the repo are skipped
 *   (they were already bridged to Discord)
 *
 * Error handling:
 * - Handlers log errors with full context (message ID, channel ID, etc.)
 *   then rethrow so the gateway can control cursor advancement.
 * - The gateway catches rethrown errors and freezes the cursor so the
 *   failed event is retried on restart.
 */

import type { Event } from "@roomy-space/sdk";
import { fromBytes } from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { DiscordSender } from "../discord/sender.ts";
import type { WebhookManager } from "../discord/webhook-manager.ts";
import { createLogger } from "../logger.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";
import type { ProfileResolver } from "../roomy/profile-resolver.ts";

const log = createLogger("roomy-router");

/**
 * Decode a message body from a Roomy event into a plain text string.
 * Uses the SDK's `fromBytes` to handle both BytesWrapper instances and
 * `{ $bytes }` JSON form. Returns undefined for unsupported MIME types
 * so callers can skip forwarding them to Discord.
 */
function decodeBody(body: {
	mimeType: string;
	data: { buf?: Uint8Array; $bytes: string };
}): string | undefined {
	if (body.mimeType !== "text/markdown" && body.mimeType !== "text/plain") {
		return undefined;
	}

	try {
		return new TextDecoder().decode(fromBytes(body.data));
	} catch {
		return "";
	}
}

export class RoomyEventRouter {
	#roomy: RoomyGateway;
	#discord: DiscordSender;
	#webhooks: WebhookManager;
	#profiles: ProfileResolver;
	#repo: BridgeRepository;

	constructor(
		roomy: RoomyGateway,
		discord: DiscordSender,
		webhooks: WebhookManager,
		profiles: ProfileResolver,
		repo: BridgeRepository,
	) {
		this.#roomy = roomy;
		this.#discord = discord;
		this.#webhooks = webhooks;
		this.#profiles = profiles;
		this.#repo = repo;
	}

	/**
	 * Subscribe to all bridged spaces and start routing events to Discord.
	 */
	async start(): Promise<void> {
		const configs = this.#repo.listAllBridgeConfigs();
		if (configs.length === 0) {
			log.info("No bridge configs found, skipping Roomy event subscription");
			return;
		}

		const uniqueSpaces = new Set(configs.map((c) => c.spaceDid));
		log.info(
			`Subscribing to ${uniqueSpaces.size} Roomy space(s) for Roomy→Discord routing`,
		);

		// Subscribe to all spaces in parallel so startup isn't blocked
		// by sequential backfill.
		const results = await Promise.allSettled(
			[...uniqueSpaces].map((spaceDid) =>
				this.#roomy.subscribe(spaceDid, (event, meta) => {
					return this.#handleEvent(spaceDid, event, meta);
				}),
			),
		);

		for (const [index, result] of results.entries()) {
			const spaceDid = [...uniqueSpaces][index];
			if (result.status === "rejected") {
				log.error(
					`Failed to subscribe to Roomy space ${spaceDid}`,
					result.reason,
				);
			}
		}
	}

	/**
	 * Subscribe to a single space (called when a new bridge is created at runtime).
	 */
	async subscribeToSpace(spaceDid: string): Promise<void> {
		await this.#roomy.subscribe(spaceDid, (event, meta) => {
			return this.#handleEvent(spaceDid, event, meta);
		});
	}

	async #handleEvent(
		spaceDid: string,
		event: Event,
		meta: { isBackfill: boolean; userDid: string },
	): Promise<void> {
		switch (event.$type) {
			case "space.roomy.message.createMessage.v0":
				await this.#handleCreateMessage(spaceDid, event, meta);
				break;
			case "space.roomy.message.editMessage.v0":
				await this.#handleEditMessage(spaceDid, event);
				break;
			case "space.roomy.message.deleteMessage.v0":
				await this.#handleDeleteMessage(spaceDid, event);
				break;
			case "space.roomy.reaction.addReaction.v0":
				await this.#handleAddReaction(spaceDid, event);
				break;
			case "space.roomy.reaction.removeReaction.v0":
				await this.#handleRemoveReaction(spaceDid, event);
				break;
			// Ignore other event types (room lifecycle, space events, etc.)
		}
	}

	async #handleCreateMessage(
		spaceDid: string,
		event: Event & { $type: "space.roomy.message.createMessage.v0" },
		meta: { isBackfill: boolean; userDid: string },
	): Promise<void> {
		// Echo prevention: skip messages that originated from Discord
		if (event.extensions?.["space.roomy.extension.discordMessageOrigin.v0"]) {
			return;
		}

		// Already bridged to Discord? Skip (prevents duplicates on restart/re-backfill)
		if (this.#repo.getDiscordId(spaceDid, "message", event.id)) {
			return;
		}

		if (!event.room) {
			log.debug("createMessage event has no room; skipping");
			return;
		}

		// Resolve the Roomy room ULID to a Discord channel or thread ID
		const isThread =
			this.#repo.getDiscordId(spaceDid, "thread", event.room) !== undefined;
		const discordChannelId =
			this.#repo.getDiscordId(spaceDid, "channel", event.room) ??
			this.#repo.getDiscordId(spaceDid, "thread", event.room);

		if (!discordChannelId) {
			// Room is not bridged to Discord — skip
			return;
		}

		// Threads can't have their own webhooks — use the parent channel's
		// webhook and pass threadId so the message lands in the thread.
		let webhookChannelId = discordChannelId;
		let threadId: string | undefined;
		if (isThread) {
			const parentId = await this.#discord.getParentChannelId(discordChannelId);
			if (!parentId) {
				log.warn(
					`Could not find parent channel for thread ${discordChannelId}; skipping message`,
				);
				return;
			}
			webhookChannelId = parentId;
			threadId = discordChannelId;
		}

		// Decode the message body
		const content = decodeBody(event.body);
		if (content === undefined) {
			log.debug(
				`Skipping createMessage ${event.id}: unsupported MIME type ${event.body.mimeType}`,
			);
			return;
		}

		// Skip empty content (e.g. media-only messages where attachments
		// aren't forwarded yet). Sending a blank Discord message is worse
		// than sending nothing.
		if (content === "") {
			log.debug(
				`Skipping createMessage ${event.id}: empty body (likely media-only)`,
			);
			return;
		}

		// Resolve author profile.
		// Prefer the authorOverride extension (set by Discord→Roomy ingestion
		// to preserve the Discord user's identity). Fall back to the stream
		// event's user DID (the Roomy-native author).
		const authorDid =
			event.extensions?.["space.roomy.extension.authorOverride.v0"]?.did ??
			meta.userDid;
		let username = "Roomy";
		let avatarUrl: string | undefined;

		const profile = await this.#profiles.getProfile(authorDid);
		if (profile) {
			// Format: "Display Name - @handle" when both are available,
			// otherwise just the display name or handle.
			if (profile.name && profile.handle && profile.name !== profile.handle) {
				username = `${profile.name} - @${profile.handle}`;
			} else {
				username = profile.name;
			}
			avatarUrl = profile.avatarUrl ?? undefined;
		}

		// Get webhook for the target channel (or parent channel if thread)
		const webhook = await this.#webhooks.ensureWebhook(webhookChannelId);

		// Send to Discord
		try {
			const discordMessageId = await this.#discord.sendMessage(
				discordChannelId,
				content,
				{ username, avatarUrl, webhook, threadId },
			);

			// Register mapping so Discord→Roomy dedup catches the echo
			this.#repo.registerMapping(
				spaceDid,
				"message",
				discordMessageId,
				event.id,
			);

			log.debug(
				`Bridged Roomy message ${event.id} → Discord ${discordMessageId} in channel ${discordChannelId}`,
			);
		} catch (err) {
			log.error(
				`Failed to bridge Roomy message ${event.id} to Discord channel ${discordChannelId}`,
				err,
			);
			throw err;
		}
	}

	async #handleEditMessage(
		spaceDid: string,
		event: Event & { $type: "space.roomy.message.editMessage.v0" },
	): Promise<void> {
		// Echo prevention: skip edits that originated from Discord
		if (event.extensions?.["space.roomy.extension.discordMessageOrigin.v0"]) {
			return;
		}

		// Find the Discord message ID for the Roomy message being edited
		const discordMessageId = this.#repo.getDiscordId(
			spaceDid,
			"message",
			event.messageId,
		);
		if (!discordMessageId) return; // message wasn't bridged to Discord

		// Find the Discord channel for the room this edit was sent in
		if (!event.room) return;
		const discordChannelId =
			this.#repo.getDiscordId(spaceDid, "channel", event.room) ??
			this.#repo.getDiscordId(spaceDid, "thread", event.room);
		if (!discordChannelId) return;

		const content = decodeBody(event.body);
		if (content === undefined) {
			// Unsupported body type (e.g. text/x-dmp-patch). Discord can't
			// render a patch, so skip the edit rather than sending blank content.
			log.debug(
				`Skipping edit for ${event.messageId}: unsupported MIME type ${event.body.mimeType}`,
			);
			return;
		}

		// Messages sent via webhook are authored by the webhook, not the bot.
		// We need the webhook credentials to edit them. Threads use their
		// parent channel's webhook.
		const isThread =
			this.#repo.getDiscordId(spaceDid, "thread", event.room) !== undefined;
		let webhookChannelId = discordChannelId;
		if (isThread) {
			const parentId = await this.#discord.getParentChannelId(
				discordChannelId,
			);
			if (!parentId) {
				log.warn(
					`Could not find parent channel for thread ${discordChannelId}; skipping edit`,
				);
				return;
			}
			webhookChannelId = parentId;
		}

		const webhook = await this.#webhooks.ensureWebhook(webhookChannelId);

		try {
			await this.#discord.editMessage(
				discordChannelId,
				discordMessageId,
				content,
				webhook,
			);
		} catch (err) {
			log.error(
				`Failed to edit Discord message ${discordMessageId} in channel ${discordChannelId}`,
				err,
			);
			throw err;
		}
	}

	async #handleDeleteMessage(
		spaceDid: string,
		event: Event & { $type: "space.roomy.message.deleteMessage.v0" },
	): Promise<void> {
		// Echo prevention: skip deletes that originated from Discord
		if (event.extensions?.["space.roomy.extension.discordMessageOrigin.v0"]) {
			return;
		}

		const discordMessageId = this.#repo.getDiscordId(
			spaceDid,
			"message",
			event.messageId,
		);
		if (!discordMessageId) return;

		// Find the Discord channel for the room
		if (!event.room) return;
		const discordChannelId =
			this.#repo.getDiscordId(spaceDid, "channel", event.room) ??
			this.#repo.getDiscordId(spaceDid, "thread", event.room);
		if (!discordChannelId) return;

		try {
			await this.#discord.deleteMessage(discordChannelId, discordMessageId);
			this.#repo.unregisterMapping(spaceDid, "message", discordMessageId);
		} catch (err) {
			log.error(
				`Failed to delete Discord message ${discordMessageId} in channel ${discordChannelId}`,
				err,
			);
			throw err;
		}
	}

	async #handleAddReaction(
		spaceDid: string,
		event: Event & { $type: "space.roomy.reaction.addReaction.v0" },
	): Promise<void> {
		// Find the Discord message ID for the reacted-to Roomy message
		const discordMessageId = this.#repo.getDiscordId(
			spaceDid,
			"message",
			event.reactionTo,
		);
		if (!discordMessageId) return;

		// Find the Discord channel for the room
		if (!event.room) return;
		const discordChannelId =
			this.#repo.getDiscordId(spaceDid, "channel", event.room) ??
			this.#repo.getDiscordId(spaceDid, "thread", event.room);
		if (!discordChannelId) return;

		try {
			await this.#discord.addReaction(
				discordChannelId,
				discordMessageId,
				event.reaction,
			);
		} catch (err) {
			log.error(
				`Failed to add reaction to Discord message ${discordMessageId} in channel ${discordChannelId}`,
				err,
			);
			throw err;
		}
	}

	async #handleRemoveReaction(
		_spaceDid: string,
		_event: Event & { $type: "space.roomy.reaction.removeReaction.v0" },
	): Promise<void> {
		// TODO: The removeReaction event only has reactionId (the ULID of the
		// original addReaction event), not the emoji itself. To remove the reaction
		// from Discord we need the emoji. Options:
		//   1. Store emoji in the reaction mapping when bridging addReaction
		//   2. Query the Leaf server for the original addReaction event
		// For now, skip — the reaction is removed from Roomy but not from Discord.
		// This is a minor gap; reactions are ephemeral and rarely removed.
	}
}
