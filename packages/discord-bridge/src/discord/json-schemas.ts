/**
 * JSON validation parsers for Discord data types.
 *
 * Uses the arktype schemas defined in data.ts so the return types
 * match exactly — no casts needed.
 */

import { type } from "arktype";
import {
	DiscordGuildData,
	DiscordChannelData,
	DiscordMessageData,
} from "./data.ts";

/**
 * Parse a JSON string into validated DiscordMessageData[].
 */
export function parseDiscordMessageList(raw: string): DiscordMessageData[] {
	const parsed: unknown = JSON.parse(raw);
	const result = type("unknown[]").pipe(DiscordMessageData.array())(parsed);
	if (result instanceof type.errors) {
		throw new TypeError(`Invalid DiscordMessageData list: ${result.summary}`);
	}
	return result;
}

/**
 * Parse a JSON string into validated DiscordChannelData[].
 */
export function parseDiscordChannelList(raw: string): DiscordChannelData[] {
	const parsed: unknown = JSON.parse(raw);
	const result = DiscordChannelData.array()(parsed);
	if (result instanceof type.errors) {
		throw new TypeError(`Invalid DiscordChannelData list: ${result.summary}`);
	}
	return result;
}

/**
 * Parse a JSON string into a validated DiscordGuildData.
 */
export function parseDiscordGuildData(raw: string): DiscordGuildData {
	const parsed: unknown = JSON.parse(raw);
	const result = DiscordGuildData(parsed);
	if (result instanceof type.errors) {
		throw new TypeError(`Invalid DiscordGuildData: ${result.summary}`);
	}
	return result;
}
