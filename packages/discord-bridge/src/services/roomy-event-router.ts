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
 * - createRoom     → persist room metadata until its creation link arrives
 * - createRoomLink → create a Discord thread for a Roomy thread
 * - forwardMessages → forward mapped messages to Discord
 * - moveMessages   → forward mapped messages to Discord (like forwardMessages,
 *                    but does NOT delete the original Discord message)
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
import { deserializeBody, fromBytes, RICHTEXT_MIME } from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { DiscordSender } from "../discord/sender.ts";
import type { WebhookManager } from "../discord/webhook-manager.ts";
import { createLogger } from "../logger.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";
import type { ProfileResolver } from "../roomy/profile-resolver.ts";
import { blocksToDiscordMarkdown } from "./blocks-to-discord.ts";

const log = createLogger("roomy-router");

/**
 * Resolve an attachment URI to a fetchable HTTP URL.
 *
 * Roomy media attachments carry `atblob://<did>/<cid>` refs (blobs stored on
 * the author's PDS). These aren't directly fetchable, so they're resolved to
 * the appserver's blob proxy (`/blob/<did>/<cid>`), which streams the bytes
 * from the PDS. Plain HTTP(S) URIs pass through unchanged.
 */
export function resolveAttachmentUrl(
	uri: string,
	appserverUrl: string,
): string {
	if (uri.startsWith("atblob://")) {
		const rest = uri.slice("atblob://".length);
		const slash = rest.indexOf("/");
		if (slash === -1) return uri;
		const did = rest.slice(0, slash);
		const cid = rest.slice(slash + 1);
		return `${appserverUrl}/blob/${encodeURIComponent(did)}/${encodeURIComponent(cid)}`;
	}
	return uri;
}

/**
 * Default attachment fetcher: downloads bytes from the attachment URI over
 * HTTP(S), resolving `atblob://` refs via the appserver blob proxy.
 * Injectable in the constructor so tests can stub it.
 */
async function defaultFetchAttachment(
	uri: string,
	appserverUrl: string,
): Promise<Uint8Array<ArrayBuffer>> {
	const url = resolveAttachmentUrl(uri, appserverUrl);
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Failed to fetch attachment ${uri}: HTTP ${res.status}`);
	}
	const buf = await res.arrayBuffer();
	return new Uint8Array(buf);
}

/** Derive a sensible Discord filename from an attachment URI + mime type. */
function filenameFromUri(uri: string, mimeType: string): string {
	const last = uri.split("/").filter(Boolean).pop() ?? "";
	if (last?.includes(".")) return last;
	const ext = mimeType.split("/")[1] ?? "bin";
	return last ? `${last}.${ext}` : `attachment.${ext}`;
}

/**
 * Strip HTML tags from a legacy body before it reaches Discord. The composer's
 * tiptap-markdown serializer used to inline mention anchors (`<a …>@label</a>`)
 * verbatim into `text/markdown` bodies; this guarantees no raw HTML is ever
 * forwarded even if a producer regresses. Deliberately a small regex stripper
 * (no DOM lib): it only removes `<…>` tag spans, keeping the text between them.
 *
 * The pattern only matches tag-shaped spans: `<` + optional `/` + an ASCII tag
 * name + optional attributes + `>`. Markdown autolinks (`<https://…>`) do not
 * match — the `:` after the "tag name" can't start an attribute list or close
 * the tag — so user links survive stripping.
 */
function stripHtmlTags(text: string): string {
	return text.replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^<>]*)?\/?>/g, "");
}

/**
 * Decode a message body from a Roomy event into a Discord-renderable string.
 *
 * - Rich text bodies (`application/vnd.roomy.richtext+json`) are parsed into
 *   blocks and rendered to Discord markdown via `blocksToDiscordMarkdown`.
 * - Legacy `text/markdown` / `text/plain` bodies are passed through as-is
 *   (Roomy markdown is largely Discord-compatible) after stripping raw HTML
 *   tags (mention anchors can't leak into Discord) and unwrapping markdown
 *   autolinks (`<url>` → `url`, so Discord embeds the link like a normal one).
 *
 * Uses the SDK's `fromBytes` to handle both BytesWrapper instances and the
 * `{ $bytes }` JSON form. Returns undefined for unsupported MIME types (or an
 * unparseable rich text body) so callers can skip forwarding them to Discord.
 */
function decodeBody(body: {
	mimeType: string;
	data: { buf?: Uint8Array; $bytes: string };
}): string | undefined {
	if (body.mimeType === RICHTEXT_MIME) {
		let bytes: Uint8Array | null;
		try {
			bytes = fromBytes(body.data);
		} catch {
			return undefined;
		}
		const blocks = deserializeBody(body.mimeType, bytes);
		if (Array.isArray(blocks)) {
			return blocksToDiscordMarkdown(blocks);
		}
		// Empty or invalid rich text body — treat as skipped (like empty legacy).
		return undefined;
	}

	if (body.mimeType !== "text/markdown" && body.mimeType !== "text/plain") {
		return undefined;
	}
	try {
		// Strip raw HTML, then unwrap markdown autolinks (`<https://…>`) to bare
		// URLs: Discord treats `<url>` as embed-suppression syntax, and a bare
		// URL auto-links with its preview — matching how the rich-text path
		// emits link facets whose text is the URI. Unwrapping must run after
		// stripping; the stripper leaves the autolink's `<>` pair intact (see
		// stripHtmlTags — `https://…` isn't tag-shaped).
		return stripHtmlTags(
			new TextDecoder().decode(fromBytes(body.data)),
		).replace(/<(https?:\/\/[^\s<>]+)>/g, "$1");
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
	#fetchAttachment: (uri: string) => Promise<Uint8Array<ArrayBuffer>>;
	#queryMessage: (
		messageId: string,
	) => Promise<
		{ authorDid: string; authorName: string; authorHandle?: string } | undefined
	>;

	constructor(
		roomy: RoomyGateway,
		discord: DiscordSender,
		webhooks: WebhookManager,
		profiles: ProfileResolver,
		repo: BridgeRepository,
		opts?: {
			appserverUrl?: string;
			fetchAttachment?: (uri: string) => Promise<Uint8Array<ArrayBuffer>>;
			queryMessage?: (
				messageId: string,
			) => Promise<
				| { authorDid: string; authorName: string; authorHandle?: string }
				| undefined
			>;
		},
	) {
		this.#roomy = roomy;
		this.#discord = discord;
		this.#webhooks = webhooks;
		this.#profiles = profiles;
		this.#repo = repo;
		const appserverUrl = opts?.appserverUrl ?? "";
		this.#fetchAttachment =
			opts?.fetchAttachment ??
			((uri) => defaultFetchAttachment(uri, appserverUrl));
		this.#queryMessage = opts?.queryMessage ?? (async () => undefined);
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
		// TODO: Retry failed subscriptions with backoff. A transient network error
		// during startup permanently disables Roomy→Discord routing for that space
		// until the process is restarted. The gateway's subscribe() catch block
		// cleans up the failed subscription so a later retry can re-subscribe,
		// but nothing currently triggers that retry.
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
			case "space.roomy.room.createRoom.v0":
				await this.#handleCreateRoom(spaceDid, event);
				break;
			case "space.roomy.link.createRoomLink.v0":
				await this.#handleCreateRoomLink(spaceDid, event);
				break;
			case "space.roomy.message.forwardMessages.v0":
				await this.#handleForwardMessages(spaceDid, event, meta);
				break;
			case "space.roomy.message.moveMessages.v0":
				await this.#handleMoveMessages(spaceDid, event, meta);
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

		// Extract reply + media attachments to carry into Discord.
		const { replyTargetDiscordId, files } = await this.#extractAttachments(
			spaceDid,
			event,
		);

		// Skip messages with nothing renderable: unsupported body and no files.
		if (content === undefined && files.length === 0) {
			log.debug(
				`Skipping createMessage ${event.id}: unsupported MIME type ${event.body.mimeType}`,
			);
			return;
		}

		// Skip empty content with no files (e.g. media-less blank messages).
		// Sending a blank Discord message is worse than sending nothing.
		if (content === "" && files.length === 0) {
			log.debug(
				`Skipping createMessage ${event.id}: empty body (likely media-only)`,
			);
			return;
		}
		let sendContent = content ?? "";

		// Faux reply: Discord webhooks can't set message_reference, so a reply
		// is rendered as a small grey "↪ <link>" prefix above the content. This
		// keeps the webhook's custom username/avatar attribution.
		if (replyTargetDiscordId) {
			const replyPrefix = await this.#buildReplyPrefix(
				discordChannelId,
				replyTargetDiscordId,
			);
			if (replyPrefix) sendContent = `${replyPrefix}\n${sendContent}`;
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
				sendContent,
				{ username, avatarUrl, webhook, threadId, files },
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

	/**
	 * Resolve the Discord reply target and downloadable media files carried by a
	 * createMessage's attachments extension.
	 *
	 * - `reply.v0` → the Discord snowflake of the Roomy message being replied to
	 *   (undefined when the target was never bridged to Discord — the message
	 *   then falls back to a plain Discord message).
	 * - `image.v0` / `video.v0` / `file.v0` → bytes fetched from the attachment
	 *   URI for a multipart webhook upload. Unfetchable attachments are skipped
	 *   (with a warning) rather than failing the whole message.
	 */
	async #extractAttachments(
		spaceDid: string,
		event: Event & { $type: "space.roomy.message.createMessage.v0" },
	): Promise<{
		replyTargetDiscordId?: string;
		files: {
			filename: string;
			contentType: string;
			data: Uint8Array<ArrayBuffer>;
		}[];
	}> {
		const attExt = event.extensions?.["space.roomy.extension.attachments.v0"];
		const attachments = attExt?.attachments ?? [];
		let replyTargetDiscordId: string | undefined;
		const files: {
			filename: string;
			contentType: string;
			data: Uint8Array<ArrayBuffer>;
		}[] = [];

		for (const att of attachments) {
			if (att.$type === "space.roomy.attachment.reply.v0") {
				const discordMessageId = this.#repo.getDiscordId(
					spaceDid,
					"message",
					att.target,
				);
				if (discordMessageId) replyTargetDiscordId = discordMessageId;
				continue;
			}

			if (
				att.$type !== "space.roomy.attachment.image.v0" &&
				att.$type !== "space.roomy.attachment.video.v0" &&
				att.$type !== "space.roomy.attachment.file.v0"
			) {
				continue;
			}

			const filename =
				att.$type === "space.roomy.attachment.file.v0" && att.name
					? att.name
					: filenameFromUri(att.uri, att.mimeType);
			try {
				const data = await this.#fetchAttachment(att.uri);
				files.push({ filename, contentType: att.mimeType, data });
			} catch (err) {
				log.warn(
					`Failed to fetch attachment ${att.uri} for message ${event.id}; skipping file`,
					err,
				);
			}
		}

		return { replyTargetDiscordId, files };
	}

	/**
	 * Build a faux reply prefix for a Roomy message that replies to another.
	 *
	 * Discord webhooks can't set `message_reference`, so a reply is rendered
	 * as small grey text: `-# ↪ <message-link> <quote-snippet>`. The raw link
	 * renders as a clickable button in Discord. Falls back to no prefix when
	 * the target message or guild can't be resolved.
	 */
	async #buildReplyPrefix(
		channelId: string,
		targetDiscordId: string,
	): Promise<string | undefined> {
		const QUOTE_MAX_LENGTH = 50;
		const guildId = await this.#discord.getGuildId(channelId);
		if (!guildId) return undefined;

		const link = `https://discord.com/channels/${guildId}/${channelId}/${targetDiscordId}`;

		let snippet = "";
		try {
			const original = await this.#discord.getMessage(
				channelId,
				targetDiscordId,
			);
			if (original?.content) {
				snippet =
					original.content.length > QUOTE_MAX_LENGTH
						? ` ${original.content.slice(0, QUOTE_MAX_LENGTH)}...`
						: ` ${original.content}`;
			}
		} catch {
			// Message may be deleted or inaccessible — link alone is fine.
		}

		return `-# ↪ ${link}${snippet}`;
	}

	/**
	 * Build the content for a faux forward: a small grey "Forwarded from
	 * <link>" prefix above the original message's content. Sent via webhook so
	 * the forwarded message keeps the author's custom username/avatar.
	 */
	async #buildForwardContent(
		targetChannelId: string,
		sourceChannelId: string,
		discordMessageId: string,
		originalAuthorName: string,
	): Promise<string | undefined> {
		const guildId = await this.#discord.getGuildId(targetChannelId);
		if (!guildId) return undefined;

		const link = `https://discord.com/channels/${guildId}/${sourceChannelId}/${discordMessageId}`;
		let body = "";
		try {
			const original = await this.#discord.getMessage(
				sourceChannelId,
				discordMessageId,
			);
			body = original?.content ?? "";
		} catch {
			// Message may be deleted — forward the link alone.
		}

		return `-# ↪ Forwarded from ${link} by ${originalAuthorName}\n${body}`;
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
			const parentId = await this.#discord.getParentChannelId(discordChannelId);
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
			// Bridged messages are sent via the channel's webhook, so delete
			// them via the webhook's own endpoint — the bot can't delete
			// webhook-authored messages without the Manage Messages permission.
			const webhook = await this.#webhooks.ensureWebhook(discordChannelId);
			await this.#discord.deleteMessage(
				discordChannelId,
				discordMessageId,
				webhook,
			);
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

	async #handleCreateRoom(
		spaceDid: string,
		event: Event & { $type: "space.roomy.room.createRoom.v0" },
	): Promise<void> {
		// Echo prevention: skip rooms that originated from Discord
		if (event.extensions?.["space.roomy.extension.discordOrigin.v0"]) {
			return;
		}

		// Already mapped? Skip (prevents duplicates on restart/re-backfill)
		if (this.#repo.getDiscordId(spaceDid, "thread", event.id)) {
			return;
		}

		// Only Roomy threads are turned into Discord threads. Persist the
		// room metadata so the matching createRoomLink (isCreationLink) can
		// create the Discord thread, even after a process restart.
		if (event.kind !== "space.roomy.thread") return;

		this.#repo.storePendingRoomCreation(
			spaceDid,
			event.id,
			event.kind,
			event.name ?? "Thread",
			event.defaultAccess,
		);
	}

	async #handleCreateRoomLink(
		spaceDid: string,
		event: Event & { $type: "space.roomy.link.createRoomLink.v0" },
	): Promise<void> {
		// We only create Discord threads for links emitted as part of thread
		// creation. Other room links are ignored.
		if (!event.isCreationLink) return;

		const pending = this.#repo.getPendingRoomCreation(
			spaceDid,
			event.linkToRoom,
		);
		if (!pending) {
			log.debug(
				`No pending createRoom for isCreationLink ${event.id}; skipping`,
			);
			return;
		}

		// The creation link has been observed, so the pending metadata is no
		// longer needed.
		this.#repo.deletePendingRoomCreation(spaceDid, event.linkToRoom);

		if (!event.room) {
			log.debug("createRoomLink isCreationLink has no room; skipping");
			return;
		}

		// Check if the parent room maps to a Discord channel
		const discordChannelId = this.#repo.getDiscordId(
			spaceDid,
			"channel",
			event.room,
		);
		if (!discordChannelId) {
			// Parent room is not bridged to Discord — skip
			return;
		}

		// Already mapped? Skip (prevents duplicates on restart/re-backfill)
		if (this.#repo.getDiscordId(spaceDid, "thread", event.linkToRoom)) {
			return;
		}

		const discordThreadId = await this.#discord.createThread(
			discordChannelId,
			pending.name,
			pending.defaultAccess === "none",
		);

		// Register mapping so messages in this thread get bridged
		this.#repo.registerMapping(
			spaceDid,
			"thread",
			discordThreadId,
			event.linkToRoom,
		);

		log.info(
			`Created Discord thread ${discordThreadId} for Roomy thread ${event.linkToRoom} in channel ${discordChannelId}`,
		);
	}

	async #handleForwardMessages(
		spaceDid: string,
		event: Event & { $type: "space.roomy.message.forwardMessages.v0" },
		meta: { userDid: string },
	): Promise<void> {
		if (!event.room) {
			log.debug("forwardMessages event has no room; skipping");
			return;
		}

		// Resolve the source room's Discord channel/thread. This is used both
		// as an early-return guard (skip the entire event when the source room
		// isn't bridged) and passed to forwardMessage so Discord can resolve
		// the source message reference faster and more reliably.
		const sourceChannelId =
			this.#repo.getDiscordId(spaceDid, "channel", event.fromRoomId) ??
			this.#repo.getDiscordId(spaceDid, "thread", event.fromRoomId);

		await this.#forwardMessageBatch(
			spaceDid,
			event,
			event.fromRoomId,
			event.room,
			sourceChannelId,
			"forward",
			meta.userDid,
		);
	}

	async #handleMoveMessages(
		spaceDid: string,
		event: Event & { $type: "space.roomy.message.moveMessages.v0" },
		meta: { userDid: string },
	): Promise<void> {
		if (!event.room) {
			log.debug("moveMessages event has no room; skipping");
			return;
		}

		// event.room is the source room (where the message currently is).
		// event.toRoomId is the destination room.
		const sourceRoomId = event.room;
		const destRoomId = event.toRoomId;

		// Find the Discord channel for the source room
		const sourceChannelId =
			this.#repo.getDiscordId(spaceDid, "channel", sourceRoomId) ??
			this.#repo.getDiscordId(spaceDid, "thread", sourceRoomId);

		await this.#forwardMessageBatch(
			spaceDid,
			event,
			sourceRoomId,
			destRoomId,
			sourceChannelId,
			"move",
			meta.userDid,
		);
	}

	/**
	 * Shared implementation for forwardMessages and moveMessages. Both events
	 * result in a Discord message being forwarded/cross-posted from a source
	 * channel/thread to a destination channel/thread. The original Discord
	 * message is always preserved because Discord has no native move operation.
	 */
	async #forwardMessageBatch(
		spaceDid: string,
		event:
			| (Event & { $type: "space.roomy.message.forwardMessages.v0" })
			| (Event & { $type: "space.roomy.message.moveMessages.v0" }),
		sourceRoomId: string,
		destRoomId: string,
		sourceChannelId: string | undefined,
		action: "forward" | "move",
		forwarderDid: string,
	): Promise<void> {
		if (!sourceChannelId) {
			log.debug(
				`Skipping ${action}Messages: source room ${sourceRoomId} not bridged to Discord`,
			);
			return;
		}

		// Find the Discord channel for the destination room
		const targetChannelId =
			this.#repo.getDiscordId(spaceDid, "channel", destRoomId) ??
			this.#repo.getDiscordId(spaceDid, "thread", destRoomId);
		if (!targetChannelId) {
			log.debug(
				`Skipping ${action}Messages: destination room ${destRoomId} not bridged to Discord`,
			);
			return;
		}

		// Threads can't have their own webhooks — use the parent channel's
		// webhook and pass threadId so the faux forward lands in the thread.
		let webhookChannelId = targetChannelId;
		let threadId: string | undefined;
		if (this.#repo.getDiscordId(spaceDid, "thread", destRoomId)) {
			const parentId = await this.#discord.getParentChannelId(targetChannelId);
			if (!parentId) {
				log.warn(
					`Could not find parent channel for thread ${targetChannelId}; skipping ${action}`,
				);
				return;
			}
			webhookChannelId = parentId;
			threadId = targetChannelId;
		}
		const webhook = await this.#webhooks.ensureWebhook(webhookChannelId);

		// The webhook user is the person who did the forward, so the forwarded
		// message is attributed to them (not the bridge bot).
		let username = "Roomy";
		let avatarUrl: string | undefined;
		const forwarderProfile = await this.#profiles.getProfile(forwarderDid);
		if (forwarderProfile) {
			username =
				forwarderProfile.name &&
				forwarderProfile.handle &&
				forwarderProfile.name !== forwarderProfile.handle
					? `${forwarderProfile.name} - @${forwarderProfile.handle}`
					: forwarderProfile.name;
			avatarUrl = forwarderProfile.avatarUrl ?? undefined;
		}

		let count = 0;
		for (const messageId of event.messageIds) {
			// Per-message dedup: use a composite key (event ID + message ID) so
			// that each forwarded/moved message is tracked independently. This
			// allows partial retries — if some messages failed on a previous
			// attempt, only the un-processed ones will be retried.
			const compositeKey = `${event.id}:${messageId}`;
			if (this.#repo.getDiscordId(spaceDid, "message", compositeKey)) {
				continue;
			}

			const discordMessageId = this.#repo.getDiscordId(
				spaceDid,
				"message",
				messageId,
			);
			if (!discordMessageId) {
				log.debug(
					`Skipping ${action} of message ${messageId}: not bridged to Discord`,
				);
				continue;
			}

			try {
				// Faux forward: Discord webhooks can't create native forwards, so
				// send the original content with a "Forwarded from <link> by
				// <original author>" prefix via the webhook, attributed to the
				// user who did the forward.
				const original = await this.#queryMessage(messageId);
				const originalAuthorName = original
					? original.authorName ||
						(original.authorHandle ? `@${original.authorHandle}` : "someone")
					: "someone";
				const forwardContent = await this.#buildForwardContent(
					targetChannelId,
					sourceChannelId,
					discordMessageId,
					originalAuthorName,
				);
				if (!forwardContent) {
					log.debug(
						`Skipping ${action} of message ${messageId}: could not build forward content`,
					);
					continue;
				}

				const newDiscordMessageId = await this.#discord.sendMessage(
					targetChannelId,
					forwardContent,
					{ username, avatarUrl, webhook, threadId },
				);

				// Register a mapping so the Discord→Roomy ingestion dedup
				// skips this forwarded message when the gateway event arrives.
				this.#repo.registerMapping(
					spaceDid,
					"message",
					newDiscordMessageId,
					compositeKey,
				);

				count++;
			} catch (err) {
				log.error(
					`Failed to ${action} Discord message ${discordMessageId} to channel ${targetChannelId}`,
					err,
				);
				throw err;
			}
		}

		if (count > 0) {
			const actionLabel = action === "forward" ? "Forwarded" : "Moved";
			log.info(
				`${actionLabel} ${count} message(s) to Discord channel ${targetChannelId} for Roomy room ${destRoomId}`,
			);
		}
	}
}
