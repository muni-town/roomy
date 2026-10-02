/**
 * Unit tests for the Discord → bridge normalizers.
 *
 * Covers: the message fields the bridge consumes, driven through the real
 * discordeno transformer with the bridge's own `desiredProperties`.
 *
 * Why the real transformer: discordeno only copies the fields
 * `desiredProperties.message` requests, so a hand-built `MessageProperties`
 * fixture keeps passing after a field is removed from that object. Feeding a
 * raw gateway payload is the only input that catches a payload field the
 * bridge silently stops receiving.
 */

import { describe, expect, test } from "bun:test";
import { createBot, Intents } from "@discordeno/bot";
import { normalizeMessage } from "../normalizers.ts";
import { desiredProperties } from "../types.ts";

// discordeno reads the bot id out of the token's first segment, so the token
// must be base64(snowflake) + ".<segment>.<segment>".
const BOT_TOKEN = "MTQ3MzQ3NjE3MzM1MzcxMzc0NA.fake.fake";

const bot = createBot({
	token: BOT_TOKEN,
	intents: Intents.Guilds | Intents.GuildMessages | Intents.MessageContent,
	desiredProperties,
});

/** Transform a raw MESSAGE_CREATE payload the way the gateway does. */
function transformGatewayMessage(payload: Record<string, unknown>) {
	return bot.transformers.message(bot, { message: payload } as never);
}

const RAW_MESSAGE = {
	id: "1400000000000000001",
	channel_id: "1400000000000000002",
	guild_id: "1400000000000000003",
	content: "",
	timestamp: "2026-09-30T07:00:00.000Z",
	author: { id: "1400000000000000004", username: "bot", discriminator: "0" },
	attachments: [],
	mentions: [],
	mention_roles: [],
};

describe("normalizeMessage", () => {
	test("carries the embed a service posted", () => {
		const message = normalizeMessage(
			transformGatewayMessage({
				...RAW_MESSAGE,
				embeds: [
					{
						type: "rich",
						url: "https://example.com/article",
						title: "An article",
						description: "What it says",
						color: 5814783,
					},
				],
			}),
		);

		expect(message.content).toBe("");
		expect(message.embeds).toEqual([
			{
				title: "An article",
				url: "https://example.com/article",
				description: "What it says",
				color: 5814783,
			},
		]);
	});

	test("normalizes a message without embeds to an empty array", () => {
		const message = normalizeMessage(transformGatewayMessage(RAW_MESSAGE));

		expect(message.embeds).toEqual([]);
	});
});
