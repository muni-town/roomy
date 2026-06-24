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

export class FileDiscordSender implements DiscordSender {
	#nextId = 1;
	#sent: SentMessage[] = [];
	#edited: EditedMessage[] = [];
	#deleted: DeletedMessage[] = [];
	#reactionsAdded: AddedReaction[] = [];
	#reactionsRemoved: RemovedReaction[] = [];
	#parents = new Map<string, string>();

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

	async deleteMessage(channelId: string, messageId: string): Promise<void> {
		this.#deleted.push({ channelId, messageId });
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

	/** Register a parent channel ID for a thread (for tests). */
	setParentChannelId(threadId: string, parentId: string): void {
		this.#parents.set(threadId, parentId);
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

	reset(): void {
		this.#nextId = 1;
		this.#sent = [];
		this.#edited = [];
		this.#deleted = [];
		this.#reactionsAdded = [];
		this.#reactionsRemoved = [];
	}
}
