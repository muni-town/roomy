/**
 * LiveDiscordSender: sends messages, edits, deletes, and reactions
 * to Discord via the Discordeno bot and Discord webhook API.
 *
 * Uses webhooks for message creation (to set custom username/avatar)
 * and bot helpers for edits, deletes, and reactions.
 */

import type { DiscordSender, SendMessageOptions } from "./sender.ts";
import type { DiscordBot } from "./types.ts";

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
		const result = await this.#bot.helpers.sendMessage(BigInt(channelId), {
			content,
		});
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

		const result = await this.#bot.rest.post<{ id: string }>(url, {
			body,
			unauthorized: true,
		});

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
}
