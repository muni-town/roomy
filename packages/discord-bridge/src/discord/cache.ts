import { createProxyCache } from "dd-cache-proxy";
import { Bot, DesiredPropertiesBehavior } from "@discordeno/bot";
import { desiredProperties } from "./types.ts";

interface BotDesiredProperties extends Required<typeof desiredProperties> {}

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
