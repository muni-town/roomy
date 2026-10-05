/**
 * RoomyGateway: abstraction over sending events to Roomy spaces
 * and subscribing to events from Roomy spaces.
 *
 * Decouples service logic from the SpaceManager's concrete network I/O,
 * enabling tests to use an in-memory mock.
 */

import type { Event } from "@roomy-space/sdk";

export type RoomyEventCallback = (
	event: Event,
	meta: { spaceDid: string; isBackfill: boolean; userDid: string },
) => Promise<void>;

/**
 * The space's sidebar structure as the appserver reports it: categories in
 * render order, each with its children (room ids) in render order. `id` is
 * absent for categories written before `updateSidebar.v1` (the deprecated v0
 * had no stable category ids).
 */
export interface BridgeSidebarCategory {
	id?: string;
	name: string;
	children: string[];
}

export interface BridgeSidebar {
	categories: BridgeSidebarCategory[];
}
/** A media attachment on a room-history message. */
export interface RoomyRoomMessageMedia {
	/** Attachment URI: `atblob://…` (resolve via the appserver blob proxy) or http(s). */
	url: string;
	/** MIME type, e.g. `image/png`. */
	type: string;
	/** Original filename, when the sender supplied one. */
	name?: string;
}

/** Where a forwarded message came from, plus the original itself. */
export interface RoomyForwardedFrom {
	/** Roomy message id of the forwarded original. */
	messageId: string;
	/** Roomy room id the original lives in. */
	roomId: string;
	/** Name of the source room at forward time. */
	name: string;
	/** The denormalised original, absent when it was deleted or unreadable. */
	message?: RoomyRoomMessage;
}

/**
 * A message from a room's history, as `space.roomy.room.getMessages` returns
 * it: the message body (raw text or base64 richtext, per `mimeType`), the
 * author, and the reply/forward/media attachments already resolved into
 * fields. `RoomyEventRouter` renders these into Discord the same way it
 * renders the equivalent `createMessage` event.
 */
export interface RoomyRoomMessage {
	id: string;
	content: string;
	/** Absent for legacy bodies, which are `text/markdown`. */
	mimeType?: string;
	authorDid: string;
	authorName: string;
	authorHandle?: string;
	authorAvatar?: string;
	/** The space authored this message itself (join notices etc.). */
	system?: boolean;
	/** ISO 8601. */
	timestamp: string;
	/** Roomy message id this message replies to. */
	replyTo?: string;
	forwardedFrom?: RoomyForwardedFrom;
	media: RoomyRoomMessageMedia[];
}

/** One page of a room's history, newest message first. */
export interface RoomyRoomMessagePage {
	messages: RoomyRoomMessage[];
	/**
	 * Cursor continuing the walk strictly older than the last message
	 * returned. Absent when the room's history is exhausted.
	 */
	cursor?: string;
}

export interface RoomyGateway {

	/** Send a single event to a space. */
	sendEvent(spaceDid: string, event: Event): Promise<void>;

	/** Send multiple events atomically to a space. */
	sendEvents(spaceDid: string, events: Event[]): Promise<void>;

	/**
	 * Read the space's current sidebar structure (categories + ordered
	 * children). Used by the one-shot initial structure sync to merge Discord
	 * categories into the sidebar instead of overwriting it.
	 */
	getSidebar(spaceDid: string): Promise<BridgeSidebar>;

	/**
	 * Read one page of a room's message history, newest first
	 * (`space.roomy.room.getMessages`). `cursor` continues past the oldest
	 * message of the previous page; the returned `cursor` is absent once the
	 * history is exhausted. Used to replay history into Discord for messages
	 * the live subscription never delivered (e.g. a room bridged after the
	 * messages were written).
	 */
	getRoomMessages(
		roomId: string,
		opts?: { limit?: number; cursor?: string },
	): Promise<RoomyRoomMessagePage>;

	/** Subscribe to events from a space. Callback receives decoded events. */
	subscribe(spaceDid: string, callback: RoomyEventCallback): Promise<void>;

	/** Unsubscribe from a space. */
	unsubscribe(spaceDid: string): Promise<void>;

	/** Disconnect from all connected spaces. */
	disconnectAll(): Promise<void>;
}
