/**
 * User extensions for metadata like Discord profile origin tracking.
 */

import { type } from "arktype";
import { DiscordSnowflake } from "./room";

export const DiscordUserOrigin = type({
  $type: "'space.roomy.extension.discordUserOrigin.v0'",
  snowflake: DiscordSnowflake.describe("Discord user ID"),
  guildId: DiscordSnowflake.describe("Guild this profile sync is scoped to"),
  profileHash: type.string.describe("Hash of profile fields for change detection"),
  handle: type.string.describe("Discord username"),
}).describe(
  "Origin metadata for user profiles bridged from Discord. \
Used for backfill and change detection.",
);

export type DiscordUserOrigin = typeof DiscordUserOrigin.infer;
