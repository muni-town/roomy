import { createProxyCache } from "dd-cache-proxy";
import { Bot, DesiredPropertiesBehavior } from "@discordeno/bot";
import { desiredProperties } from "./types.ts";

interface BotDesiredProperties extends Required<typeof desiredProperties> {}

/**
 * Concrete return type of getProxyCacheBot — a proxy-cached bot that
 * exposes `.cache.guilds.memory`, `.cache.channels.memory`, etc.
 * Used by slash-commands.ts for channel listing.
 */
export type DiscordBotWithCache = ReturnType<typeof getProxyCacheBot>;

export const getProxyCacheBot = (
	bot: Bot<BotDesiredProperties, DesiredPropertiesBehavior.RemoveKey>,
) =>
	createProxyCache(bot, {
		desiredProps: {
			guild: ["channels", "id"],
			user: ["avatar", "id", "username"],
		},
		cacheInMemory: {
			guild: true,
			channel: true,
			message: true,
			default: false,
		},
	});
