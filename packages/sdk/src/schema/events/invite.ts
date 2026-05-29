/**
 * Invite link events: create and revoke invite tokens for private spaces
 */

import { sql } from "../../utils";
import { type } from "../primitives";
import { defineEvent } from "./utils";

const CreateInviteSchema = type({
  $type: "'space.roomy.space.createInvite.v0'",
  token: "string",
}).describe(
  "Create an invite link for this space. \
The token is a client-generated random string that can be shared to allow others to join.",
);

export const CreateInvite = defineEvent(
  CreateInviteSchema,
  ({ streamId, event, user }) => {
    return [
      sql`
        insert or ignore into comp_invite (entity, token, created_by_did, event_ulid)
        values (${streamId}, ${event.token}, ${user}, ${event.id})
      `,
    ];
  },
);

const RevokeInviteSchema = type({
  $type: "'space.roomy.space.revokeInvite.v0'",
  token: "string",
}).describe(
  "Revoke an existing invite link for this space. \
The token must match a previously created invite.",
);

export const RevokeInvite = defineEvent(
  RevokeInviteSchema,
  ({ streamId, event }) => {
    return [
      sql`
        delete from comp_invite
        where entity = ${streamId} and token = ${event.token}
      `,
    ];
  },
);

export const InviteEventVariant = type.or(
  CreateInviteSchema,
  RevokeInviteSchema,
);
