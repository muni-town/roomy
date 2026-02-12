import { type } from "arktype";
import { DiscordSnowflake } from "./room";
import { unionToMap } from "../primitives";

export const DiscordSidebarOrigin = type({
  $type: "'space.roomy.extension.discordSidebarOrigin.v0'",
  sidebarHash: "string",
  guildId: DiscordSnowflake.describe(
    "The Discord guild (server) snowflake ID.",
  ),
}).describe(
  "Origin metadata for sidebar bridged from Discord. \
  Uses hash of normalised sidebar for idempotency checks and linking back to Discord.",
);

export const sidebarExtension = type.or(DiscordSidebarOrigin);

export const SidebarExtensionsMap = unionToMap(sidebarExtension);
