/**
 * LiveDiscordSender: sends messages, edits, deletes, and reactions
 * to Discord via the Discordeno bot and Discord webhook API.
 *
 * Uses webhooks for message creation (to set custom username/avatar)
 * and bot helpers for edits, deletes, and reactions.
 */

import { ChannelTypes, DiscordMessageReferenceType } from "@discordeno/bot";
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
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${ms}ms`));
		}, ms);
		Promise.resolve(promise).then(
			(v) => { clearTimeout(timer); resolve(v); },
			(e) => { clearTimeout(timer); reject(e); },
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

		const result = await withTimeout(
			this.#bot.rest.post<{ id: string }>(url, {
				body,
				unauthorized: true,
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
			const url = `/webhooks/${webhook.id}/${webhook.token}/messages/${messageId}`;
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

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
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

	async forwardMessage(
		targetChannelId: string,
		messageId: string,
		sourceChannelId?: string,
	): Promise<string> {
		// Discord forwards are created by sending a message with a Forward
		// message reference. Both messages must be in the same guild.
		const result = await this.#bot.helpers.sendMessage(
			BigInt(targetChannelId),
			{
				messageReference: {
					type: DiscordMessageReferenceType.Forward,
					messageId: BigInt(messageId),
					...(sourceChannelId ? { channelId: BigInt(sourceChannelId) } : {}),
					failIfNotExists: false,
				},
			},
		);
		return result.id.toString();
	}
}
