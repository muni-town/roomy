/**
 * LiveWebhookManager: creates and manages Discord webhooks via the
 * Discordeno bot, persisting webhook tokens in the bridge repository.
 */

import type { BridgeRepository } from "../db/repository.ts";
import { createLogger } from "../logger.ts";
import type { DiscordBot } from "./types.ts";
import type { WebhookInfo, WebhookManager } from "./webhook-manager.ts";

const log = createLogger("live-webhook");

export class LiveWebhookManager implements WebhookManager {
	#bot: DiscordBot;
	#repo: BridgeRepository;

	constructor(bot: DiscordBot, repo: BridgeRepository) {
		this.#bot = bot;
		this.#repo = repo;
	}

	async ensureWebhook(channelId: string): Promise<WebhookInfo> {
		// Check for an existing webhook
		const existing = this.#repo.getWebhookToken(channelId);
		if (existing) {
			return { id: existing.webhookId, token: existing.token };
		}

		// Create a new webhook
		try {
			const webhook = await this.#bot.helpers.createWebhook(BigInt(channelId), {
				name: "Roomy Bridge",
			});

			if (!webhook.token) {
				// Discord sometimes returns webhooks without a token (e.g. for
				// application-owned webhooks). Delete the unusable webhook and
				// throw so callers know this channel can't be bridged via webhook.
				try {
					await this.#bot.helpers.deleteWebhook(BigInt(webhook.id));
				} catch (deleteErr) {
					log.warn(
						`Failed to delete tokenless webhook ${webhook.id} for channel ${channelId}`,
						deleteErr,
					);
				}
				throw new Error(
					`Discord returned a webhook with no token for channel ${channelId}`,
				);
			}

			const info: WebhookInfo = {
				id: webhook.id.toString(),
				token: webhook.token,
			};
			this.#repo.setWebhookToken(channelId, info.id, info.token);
			log.info(`Created webhook for channel ${channelId}`);
			return info;
		} catch (err) {
			log.error(`Failed to create webhook for channel ${channelId}`, err);
			throw err;
		}
	}

	async removeWebhook(channelId: string): Promise<void> {
		const existing = this.#repo.getWebhookToken(channelId);
		if (!existing) return;

		try {
			await this.#bot.helpers.deleteWebhook(BigInt(existing.webhookId));
		} catch (err) {
			log.warn(
				`Failed to delete webhook for channel ${channelId}; keeping token so we can retry later`,
				err,
			);
			// Don't delete the repo row — the token may still be valid and we
			// want removeWebhook to be retryable.
			return;
		}

		this.#repo.deleteWebhookToken(channelId);
		log.info(`Removed webhook for channel ${channelId}`);
	}
}
