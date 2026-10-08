import { expect } from "bun:test";
import type { Event } from "@roomy-space/sdk";

/** Assert that a value is defined (NonNullable) — narrows the type for TypeScript. */
export function expectToBeDefined<T>(
	value: T,
): asserts value is NonNullable<T> {
	expect(value).toBeDefined();
}

export function expectToBe<T, V extends T>(
	value: T,
	toBe: V,
): asserts value is V {
	expect(value).toBe(toBe);
}

/** Decode a base64 `$bytes` body into a UTF-8 string (handles multibyte). */
export function decodeBodyString(body: { data: { $bytes: string } }): string {
	const binary = atob(body.data.$bytes);
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/** An event is anything with a string `id`; the rest is opaque here. */
export function isEventLike(value: unknown): value is Event {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string"
	);
}

/** The events a `failed_sends` payload holds. */
export function queuedEvents(eventJson: string): Event[] {
	const parsed: unknown = JSON.parse(eventJson);
	if (!Array.isArray(parsed) || !parsed.every(isEventLike)) {
		throw new Error(`queued entry carries no events: ${eventJson}`);
	}
	return parsed;
}

/** Summary of a rich text body for assertions. */
export interface RichTextSummary {
	text: string;
	didMentions: string[];
	roomRefs: { spaceId: string; roomId?: string }[];
	links: string[];
}

/**
 * Decode a `application/vnd.roomy.richtext+json` event body and summarise its
 * text + facet features (mentions, room refs, links).
 */
export function decodeRichText(body: {
	mimeType: string;
	data: { $bytes: string };
}): RichTextSummary {
	const doc: {
		blocks?: {
			text?: string;
			facets?: {
				index: { byteStart: number; byteEnd: number };
				features: {
					$type: string;
					did?: string;
					spaceId?: string;
					roomId?: string;
					uri?: string;
				}[];
			}[];
		}[];
	} = JSON.parse(decodeBodyString(body));
	const didMentions: string[] = [];
	const roomRefs: { spaceId: string; roomId?: string }[] = [];
	const links: string[] = [];
	const text = (doc.blocks ?? []).map((b) => b.text ?? "").join("");
	for (const block of doc.blocks ?? []) {
		for (const facet of block.facets ?? []) {
			for (const feat of facet.features) {
				if (feat.$type === "space.roomy.richtext.facet#didMention") {
					didMentions.push(feat.did ?? "");
				} else if (feat.$type === "space.roomy.richtext.facet#roomRef") {
					roomRefs.push({ spaceId: feat.spaceId ?? "", roomId: feat.roomId });
				} else if (feat.$type === "space.roomy.richtext.facet#link") {
					links.push(feat.uri ?? "");
				}
			}
		}
	}
	return { text, didMentions, roomRefs, links };
}
