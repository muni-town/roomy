import { createProxyCache } from "dd-cache-proxy";
import { Bot, DesiredPropertiesBehavior } from "@discordeno/bot";
import { desiredProperties } from "./types";

interface BotDesiredProperties extends Required<typeof desiredProperties> {}

export const getProxyCacheBot = (
  bot: Bot<BotDesiredProperties, DesiredPropertiesBehavior.RemoveKey>,
) =>
  createProxyCache(bot, {
    // Define what properties of individual cache you wish to cache. This property must also be in your discordeno's desired properties.
    // Caches all props from discordeno's desired props by default. Or you can use the `undesiredProps` prop to reverse the behavior of `desiredProps`.
    desiredProps: {
      guild: ["channels", "id"],
      user: ["avatar", "id", "username"],
    },
    cacheInMemory: {
      guild: true,
      channel: true,
      message: true,
      // member: true,
      default: false,
    },
  });
