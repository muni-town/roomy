/**
 * Room extensions for metadata like bridge origin tracking.
 */

import { type } from "arktype";
import { unionToMap } from "../primitives";

/**
 * Discord snowflake as a string (too large for JS number).
 * Snowflakes are 64-bit integers encoding timestamp + worker + sequence.
 */
export const DiscordSnowflake = type.string
  .narrow((v, ctx) =>
    /^\d{17,20}$/.test(v) ? true : ctx.mustBe("a valid Discord snowflake"),
  )
  .describe("A Discord snowflake ID (17-20 digit string).");

export const DiscordOrigin = type({
  $type: "'space.roomy.extension.discordOrigin.v0'",
  snowflake: DiscordSnowflake.describe(
    "The Discord channel/category snowflake ID.",
  ),
  guildId: DiscordSnowflake.describe(
    "The Discord guild (server) snowflake ID.",
  ),
}).describe(
  "Origin metadata for rooms bridged from Discord. \
Used for idempotency checks and linking back to Discord.",
);

/**
 * A Matrix room ID (`!opaque:server`). Matrix IDs are opaque, so this is a
 * plain string rather than a structural check.
 */
export const MatrixRoomId = type.string.describe(
  "A Matrix room ID, like `!abc123:matrix.org`.",
);

export const MatrixOrigin = type({
  $type: "'space.roomy.extension.matrixOrigin.v0'",
  roomId: MatrixRoomId.describe("The Matrix room ID this room is bridged to."),
  "eventId?": type.string.describe(
    "The Matrix event ID that created or last bound this room.",
  ),
  "originServerTs?": type("number.integer").describe(
    "The origin server timestamp of that Matrix event, in milliseconds since the unix epoch.",
  ),
}).describe(
  "Origin metadata for rooms bridged from Matrix. \
Used for idempotency checks and linking back to Matrix.",
);

export const roomExtension = type.or(DiscordOrigin, MatrixOrigin);

export type RoomExtension = typeof roomExtension.infer;
export const RoomExtensionMap = unionToMap(roomExtension).describe(
  "A mapping of extensions to add to a room. Each extension is optional.",
);
export type RoomExtensionMap = typeof RoomExtensionMap.infer;
