/**
 * Schema for `space.roomy.space.getUserAccess` (query).
 *
 * Space-restricted endpoint that reports a user's standing in a space:
 * whether they are an admin and which role IDs they hold. Used by the
 * arbiter's Rego policy engine to make access decisions.
 *
 * Authorisation: the caller must be the space's own DID (the arbiter
 * proxies policy-approved requests under the stewarded space's account).
 * Returns fail-closed empty (`{ isAdmin: false, roleIds: [] }`) for unknown
 * spaces or non-members — a policy engine must not be able to distinguish
 * "no data" from "no access".
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getUserAccess" as const;

export const Params = type({
  spaceId: "string",
  userDid: "string",
});

export const Response = type({
  isAdmin: "boolean",
  /** Role ULIDs assigned to the user in the space. */
  roleIds: "string[]",
});
