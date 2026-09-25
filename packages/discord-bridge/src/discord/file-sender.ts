/**
 * FileDiscordSender: in-memory mock of DiscordSender for tests.
 *
 * Records all sent messages, edits, deletes, and reactions so tests
 * can assert against them.
 */

import type { DiscordSender, SendMessageOptions } from "./sender.ts";

export interface SentMessage {
	channelId: string;
	content: string;
	messageId: string;
	options?: SendMessageOptions;
}

export interface EditedMessage {
	channelId: string;
	messageId: string;
	content: string;
}

export interface DeletedMessage {
	channelId: string;
	messageId: string;
	webhook?: { id: string; token: string };
}

export interface AddedReaction {
	channelId: string;
	messageId: string;
	emoji: string;
}

export interface RemovedReaction {
	channelId: string;
	messageId: string;
	emoji: string;
}

export interface CreatedThread {
	channelId: string;
	name: string;
	isPrivate: boolean;
	id: string;
}

export class FileDiscordSender implements DiscordSender {
	#nextId = 1;
	#sent: SentMessage[] = [];
	#edited: EditedMessage[] = [];
	#deleted: DeletedMessage[] = [];
	#reactionsAdded: AddedReaction[] = [];
	#reactionsRemoved: RemovedReaction[] = [];
	#parents = new Map<string, string>();
	#guilds = new Map<string, string>();
	#messages = new Map<string, { content: string; webhookId?: string }>();
	#threads: CreatedThread[] = [];
	#getMessageError: string | undefined;
	#botDeleteError: string | undefined;

	async sendMessage(
		channelId: string,
		content: string,
		options?: SendMessageOptions,
	): Promise<string> {
		const messageId = String(this.#nextId++);
		this.#sent.push({ channelId, content, messageId, options });
		return messageId;
	}

	async editMessage(
		channelId: string,
		messageId: string,
		content: string,
		_webhook?: { id: string; token: string },
	): Promise<void> {
		this.#edited.push({ channelId, messageId, content });
	}

	async deleteMessage(
		channelId: string,
		messageId: string,
		webhook?: { id: string; token: string },
	): Promise<void> {
		// The bot can only delete someone else's message with Manage Messages.
		if (this.#botDeleteError && !webhook) {
			throw new Error(this.#botDeleteError);
		}
		this.#deleted.push({ channelId, messageId, webhook });
	}

	async addReaction(
		channelId: string,
		messageId: string,
		emoji: string,
	): Promise<void> {
		this.#reactionsAdded.push({ channelId, messageId, emoji });
	}

	async removeReaction(
		channelId: string,
		messageId: string,
		emoji: string,
	): Promise<void> {
		this.#reactionsRemoved.push({ channelId, messageId, emoji });
	}

	async getParentChannelId(channelId: string): Promise<string | undefined> {
		return this.#parents.get(channelId);
	}

	async getGuildId(channelId: string): Promise<string | undefined> {
		return this.#guilds.get(channelId);
	}

	async getMessage(
		channelId: string,
		messageId: string,
	): Promise<{ content: string; webhookId?: string } | undefined> {
		// Models a Discord REST failure when the message is neither absent nor
		// fetchable — the caller must not read it as "nothing to delete".
		if (this.#getMessageError) throw new Error(this.#getMessageError);
		return this.#messages.get(`${channelId}:${messageId}`);
	}

	async createThread(
		channelId: string,
		name: string,
		isPrivate: boolean,
	): Promise<string> {
		const id = String(this.#nextId++);
		this.#threads.push({ channelId, name, isPrivate, id });
		return id;
	}

	/** Register a parent channel ID for a thread (for tests). */
	setParentChannelId(threadId: string, parentId: string): void {
		this.#parents.set(threadId, parentId);
	}

	/** Register a guild ID for a channel (for tests). */
	setGuildId(channelId: string, guildId: string): void {
		this.#guilds.set(channelId, guildId);
	}

	/**
	 * Register a message (for tests). `webhookId` models Discord's authorship
	 * marker: set it for messages the bridge posted via a webhook.
	 */
	setMessage(
		channelId: string,
		messageId: string,
		content: string,
		webhookId?: string,
	): void {
		this.#messages.set(`${channelId}:${messageId}`, { content, webhookId });
	}

	/**
	 * Make bot deletes (those without a webhook) reject — models the bot
	 * lacking Manage Messages on a message it doesn't own.
	 */
	setBotDeleteError(message: string): void {
		this.#botDeleteError = message;
	}

	/** Make message fetches reject — models a Discord REST failure (for tests). */
	setGetMessageError(message: string): void {
		this.#getMessageError = message;
	}

	// ── Test helpers ────────────────────────────────────────────

	get sent(): readonly SentMessage[] {
		return this.#sent;
	}

	get edited(): readonly EditedMessage[] {
		return this.#edited;
	}

	get deleted(): readonly DeletedMessage[] {
		return this.#deleted;
	}

	get reactionsAdded(): readonly AddedReaction[] {
		return this.#reactionsAdded;
	}

	get reactionsRemoved(): readonly RemovedReaction[] {
		return this.#reactionsRemoved;
	}

	get threads(): readonly CreatedThread[] {
		return this.#threads;
	}

	reset(): void {
		this.#nextId = 1;
		this.#sent = [];
		this.#edited = [];
		this.#deleted = [];
		this.#reactionsAdded = [];
		this.#reactionsRemoved = [];
		this.#threads = [];
	}
}
