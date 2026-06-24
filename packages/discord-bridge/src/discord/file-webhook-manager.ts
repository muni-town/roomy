/**
 * FileWebhookManager: in-memory mock of WebhookManager for tests.
 *
 * Returns canned webhook data and records created/removed webhooks.
 */

import type { WebhookInfo, WebhookManager } from "./webhook-manager.ts";

export class FileWebhookManager implements WebhookManager {
	#webhooks = new Map<string, WebhookInfo>();
	#removed: string[] = [];

	async ensureWebhook(channelId: string): Promise<WebhookInfo> {
		const existing = this.#webhooks.get(channelId);
		if (existing) return existing;

		const info: WebhookInfo = {
			id: `wh_${channelId}`,
			token: `tok_${channelId}`,
		};
		this.#webhooks.set(channelId, info);
		return info;
	}

	async removeWebhook(channelId: string): Promise<void> {
		this.#webhooks.delete(channelId);
		this.#removed.push(channelId);
	}

	// ── Test helpers ────────────────────────────────────────────

	get webhooks(): ReadonlyMap<string, WebhookInfo> {
		return this.#webhooks;
	}

	get removed(): readonly string[] {
		return this.#removed;
	}

	reset(): void {
		this.#webhooks.clear();
		this.#removed = [];
	}
}
