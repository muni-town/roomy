/**
 * Room extensions for metadata like Discord bridge origin tracking.
 */

import { type } from "arktype";
import { unionToMap } from "../primitives";

/**
 * Discord snowflake as a string (too large for JS number).
 * Snowflakes are 64-bit integers encoding timestamp + worker + sequence.
 */
export const DiscordSnowflake = type.string
  .narrow((v, ctx) => (/^\d{17,20}$/.test(v) ? true : ctx.mustBe("a valid Discord snowflake")))
  .describe("A Discord snowflake ID (17-20 digit string).");

export const DiscordOrigin = type({
  $type: "'space.roomy.extension.discordOrigin.v0'",
  snowflake: DiscordSnowflake.describe("The Discord channel/category snowflake ID."),
  guildId: DiscordSnowflake.describe("The Discord guild (server) snowflake ID."),
}).describe(
  "Origin metadata for rooms bridged from Discord. \
Used for idempotency checks and linking back to Discord.",
);

export const roomExtension = type.or(DiscordOrigin);

export type RoomExtension = typeof roomExtension.infer;
export const RoomExtensionMap = unionToMap(roomExtension).describe(
  "A mapping of extensions to add to a room. Each extension is optional.",
);
export type RoomExtensionMap = typeof RoomExtensionMap.infer;
