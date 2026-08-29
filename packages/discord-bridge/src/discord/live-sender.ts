/**
 * LiveDiscordSender: sends messages, edits, deletes, and reactions
 * to Discord via the Discordeno bot and Discord webhook API.
 *
 * Uses webhooks for message creation (to set custom username/avatar)
 * and bot helpers for edits, deletes, and reactions.
 */

import { ChannelTypes } from "@discordeno/bot";
import type { DiscordSender, SendMessageOptions } from "./sender.ts";
import type { DiscordBot } from "./types.ts";

/**
 * Hard deadline for a single Discord REST call on the Roomy→Discord path.
 *
 * Discordeno's rest manager has no per-request timeout (and its default
 * `maxRetryCount` is Infinity), so a hung TCP connection to Discord would
 * otherwise block the per-space delivery chain indefinitely — the same
 * failure mode as the profile fetch. Capping the wait ensures a stuck
 * send rejects fast and the chain advances, rather than stalling for the
 * minutes it takes an intermediary to reap an idle socket.
 */
const DISCORD_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Race a promise against a timeout. Resolves/rejects with the underlying
 * result, or rejects with a TimeoutError if `ms` elapses first. The
 * underlying promise is not cancelled (Discordeno exposes no signal), but
 * the caller is unblocked; the in-flight request is left to settle.
 */
function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label: string,
): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		}, ms);
		Promise.resolve(promise).then(
			(v) => {
				clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				clearTimeout(timer);
				reject(e);
			},
		);
	});
}

export class LiveDiscordSender implements DiscordSender {
	#bot: DiscordBot;

	constructor(bot: DiscordBot) {
		this.#bot = bot;
	}

	async sendMessage(
		channelId: string,
		content: string,
		options?: SendMessageOptions,
	): Promise<string> {
		if (options?.webhook) {
			return this.#sendViaWebhook(channelId, content, options);
		}

		// Fallback: send as the bot itself
		const result = await withTimeout(
			this.#bot.helpers.sendMessage(BigInt(channelId), {
				content,
			}),
			DISCORD_REQUEST_TIMEOUT_MS,
			`bot sendMessage to channel ${channelId}`,
		);
		return result.id.toString();
	}

	async #sendViaWebhook(
		channelId: string,
		content: string,
		options: SendMessageOptions,
	): Promise<string> {
		const webhook = options.webhook;
		if (!webhook) {
			throw new Error("sendViaWebhook called without webhook");
		}
		if (!webhook.token) {
			throw new Error(
				`Webhook for channel ${channelId} has no token; cannot send message`,
			);
		}

		// Build the URL with query parameters (wait, threadId) and send body
		// separately. The Discordeno executeWebhook helper puts everything in
		// the body, but `wait` and `threadId` are query parameters — Discord's
		// API rejects them in the body.
		//
		// TODO: Once the Discordeno bug is fixed (wait/threadId stripped from
		// body before sending), revert to using:
		//   this.#bot.helpers.executeWebhook(BigInt(webhook.id), webhook.token, {
		//     wait: true,
		//     content,
		//     username: options.username,
		//     avatarUrl: options.avatarUrl,
		//     threadId: options.threadId ? BigInt(options.threadId) : undefined,
		//   })
		let url = `/webhooks/${webhook.id}/${webhook.token}?wait=true`;
		if (options.threadId) {
			url += `&thread_id=${options.threadId}`;
		}

		const body: Record<string, unknown> = {
			content,
		};
		if (options.username) {
			body.username = options.username;
		}
		if (options.avatarUrl) {
			body.avatar_url = options.avatarUrl;
		}
		// Optional multipart file upload. When files are present, Discordeno's
		// createRequestBody serialises `body` into `payload_json` and appends
		// the files as multipart parts (the standard webhook upload format).
		const files = options.files?.map((f) => ({
			blob: new Blob([f.data], { type: f.contentType }),
			name: f.filename,
		}));

		const result = await withTimeout(
			this.#bot.rest.post<{ id: string }>(url, {
				body,
				unauthorized: true,
				...(files && files.length > 0 ? { files } : {}),
			}),
			DISCORD_REQUEST_TIMEOUT_MS,
			`webhook send to channel ${channelId}`,
		);

		if (!result) {
			throw new Error(
				`Webhook send to channel ${channelId} returned no message`,
			);
		}

		return result.id.toString();
	}

	async editMessage(
		channelId: string,
		messageId: string,
		content: string,
		webhook?: { id: string; token: string },
	): Promise<void> {
		if (webhook?.token) {
			// Messages sent via webhook are authored by the webhook, not the bot.
			// Use the webhook's own edit endpoint to edit them.
			let url = `/webhooks/${webhook.id}/${webhook.token}/messages/${messageId}`;
			// Webhook messages in threads are located by the thread's ID, not the
			// parent channel's. Without `thread_id` Discord returns 404 Unknown
			// Message, so edits in threads silently fail. Detect a thread by its
			// parent channel and append the thread ID.
			const parentId = await this.getParentChannelId(channelId);
			if (parentId) {
				url += `?thread_id=${channelId}`;
			}
			await this.#bot.rest.patch(url, {
				body: { content },
				unauthorized: true,
			});
			return;
		}

		await this.#bot.helpers.editMessage(BigInt(channelId), BigInt(messageId), {
			content,
		});
	}

	async deleteMessage(
		channelId: string,
		messageId: string,
		webhook?: { id: string; token: string },
	): Promise<void> {
		if (webhook?.token) {
			// Messages sent via webhook are authored by the webhook, not the bot.
			// Use the webhook's own delete endpoint, which doesn't require the
			// bot to have the Manage Messages permission.
			let url = `/webhooks/${webhook.id}/${webhook.token}/messages/${messageId}`;
			// Webhook messages in threads are located by the thread's ID, not the
			// parent channel's. Without `thread_id` Discord returns 404 Unknown
			// Message, so deletes in threads silently fail. Detect a thread by its
			// parent channel and append the thread ID.
			const parentId = await this.getParentChannelId(channelId);
			if (parentId) {
				url += `?thread_id=${channelId}`;
			}
			await this.#bot.rest.delete(url, { unauthorized: true });
			return;
		}

		await this.#bot.helpers.deleteMessage(BigInt(channelId), BigInt(messageId));
	}

	async addReaction(
		channelId: string,
		messageId: string,
		emoji: string,
	): Promise<void> {
		await this.#bot.helpers.addReaction(
			BigInt(channelId),
			BigInt(messageId),
			emoji,
		);
	}

	async removeReaction(
		channelId: string,
		messageId: string,
		emoji: string,
	): Promise<void> {
		await this.#bot.helpers.deleteOwnReaction(
			BigInt(channelId),
			BigInt(messageId),
			emoji,
		);
	}

	async getParentChannelId(channelId: string): Promise<string | undefined> {
		const channel = await this.#bot.helpers.getChannel(BigInt(channelId));
		return channel?.parentId?.toString();
	}

	async createThread(
		channelId: string,
		name: string,
		isPrivate: boolean,
	): Promise<string> {
		const result = await this.#bot.helpers.startThreadWithoutMessage(
			BigInt(channelId),
			{
				name,
				autoArchiveDuration: 10080, // 1 week
				type: isPrivate
					? ChannelTypes.PrivateThread
					: ChannelTypes.PublicThread,
			},
		);
		return result.id.toString();
	}

	async getGuildId(channelId: string): Promise<string | undefined> {
		const channel = await this.#bot.helpers.getChannel(BigInt(channelId));
		return channel?.guildId?.toString();
	}

	async getMessage(
		channelId: string,
		messageId: string,
	): Promise<{ content: string } | undefined> {
		const msg = await this.#bot.helpers.getMessage(
			BigInt(channelId),
			BigInt(messageId),
		);
		return msg ? { content: msg.content ?? "" } : undefined;
	}
}
