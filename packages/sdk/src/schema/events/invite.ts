/**
 * Invite link events: create and revoke invite tokens for private spaces
 */

import { type } from "../primitives";
import { defineEvent } from "./utils";

const CreateInviteSchema = type({
  $type: "'space.roomy.space.createInvite.v0'",
  token: "string",
}).describe(
  "Create an invite link for this space. \
The token is a client-generated random string that can be shared to allow others to join.",
);

export const CreateInvite = defineEvent(CreateInviteSchema, () => []);

const RevokeInviteSchema = type({
  $type: "'space.roomy.space.revokeInvite.v0'",
  token: "string",
}).describe(
  "Revoke an existing invite link for this space. \
The token must match a previously created invite.",
);

export const RevokeInvite = defineEvent(RevokeInviteSchema, () => []);

export const InviteEventVariant = type.or(
  CreateInviteSchema,
  RevokeInviteSchema,
);
