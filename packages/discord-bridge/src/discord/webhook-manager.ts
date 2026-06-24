/**
 * WebhookManager: manages Discord webhooks for bridged channels.
 *
 * Webhooks allow the bridge to set custom username and avatar when
 * sending Roomy messages to Discord.
 */

export interface WebhookInfo {
	id: string;
	token: string;
}

export interface WebhookManager {
	/** Get or create a webhook for the given channel. */
	ensureWebhook(channelId: string): Promise<WebhookInfo>;

	/** Delete the webhook for a channel (e.g., on unbridge). */
	removeWebhook(channelId: string): Promise<void>;
}
