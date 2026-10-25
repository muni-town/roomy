/**
 * User events: metadata overrides (for bridged accounts) and read tracking
 */

import { decodeTime } from "ulidx";
import { SqlStatement } from "../../types";
import { sql } from "../../utils";
import { BasicInfoUpdate, Did, StreamDid, type, Ulid } from "../primitives";
import { defineEvent, ensureEntity } from "./utils";

const SetUserProfileSchema = type({
  $type: "'space.roomy.user.updateProfile.v0'",
  did: Did.describe("The DID of the user to set the profile for."),
  // isn't specifying the did a bit of an edge case, only really for bridging or weird admin actions?
  // in which case it seems better to be an extension...
  "extensions?": type.Record(type.string, type.unknown),
})
  .and(BasicInfoUpdate)
  .describe(
    "Set a user profile. \
This can be used to update the profile info of bridged accounts. \
It can also be used by a user to set a space-specific profile.",
  );

export const SetUserProfile = defineEvent(
  SetUserProfileSchema,
  ({ streamId, event, decidedAt }) => {
    const at = decidedAt ?? Date.now();
    const updates = [
      { key: "name", value: event.name },
      { key: "avatar", value: event.avatar },
      { key: "description", value: event.description },
    ];
    const setUpdates = updates.filter((x) => x.value !== undefined);

    const statements: (SqlStatement | undefined)[] = [
      ensureEntity(streamId, event.did, undefined, at),
      setUpdates.length > 0
        ? {
            sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")}, created_at, updated_at)
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)}, :at, :at)
            on conflict do update set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
            params: Object.fromEntries([
              [":entity", event.did],
              [":at", at],
              ...setUpdates.map((x) => [
                ":" + x.key,
                "value" in x ? x.value : undefined,
              ]),
            ]),
          }
        : undefined,
    ];

    // Extract handle from Discord extension if present
    const discordOrigin = event.extensions?.[
      "space.roomy.extension.discordUserOrigin.v0"
    ] as { handle?: string } | undefined;
    if (discordOrigin?.handle) {
      statements.push(
        sql`
          INSERT INTO comp_user (did, handle, created_at, updated_at)
          VALUES (${event.did}, ${discordOrigin.handle}, ${at}, ${at})
          ON CONFLICT(did) DO UPDATE SET handle = ${discordOrigin.handle}
        `,
      );
    }

    return statements.filter((x) => !!x);
  },
);

// All user events
export const UserEventVariant = type.or(SetUserProfileSchema);