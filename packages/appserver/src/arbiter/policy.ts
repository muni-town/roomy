/**
 * Default Rego policy installed on newly-created space arbiters.
 *
 * The policy gates what the arbiter will proxy under the space's account.
 * It allows the space itself and the appserver (the recovery admin / owner)
 * unconditionally, and allows any Roomy space admin to act under the space's
 * account. Admin status is decided by the appserver's
 * `space.roomy.space.getUserAccess` endpoint, called through the arbiter's
 * `xrpc` host function.
 *
 * `${owner}` is substituted with the appserver's own DID at install time.
 * The getUserAccess admin-check call targets the appserver's DID + its
 * `#space_roomy_appserver` service (declared in the appserver's DID doc,
 * pointing at its XRPC origin); the arbiter routes to it via the atproto
 * proxy header.
 */
export const DEFAULT_ARBITER_POLICY = `package arbiter

import rego.v1

# By default we deny every request.
default result := {"ok": false, "error": {"status": 403, "error": "ErrPermissionDenied"}}

# Allowed requests are proxied to the steward's PDS as the stewarded account.
result := xrpc({
   "did": concat("#", [input.arbiterDid, "atproto_pds"]),
   "method": input.method,
   "nsid": input.nsid,
   "parameters": input.parameters,
   "body": input.body,
   "encoding": input.encoding,
}) if allow

# The stewarded account itself is always allowed.
allow if input.callerDid == input.arbiterDid

# The owner (the appserver) is always allowed.
allow if input.callerDid == "\${owner}"

# Any Roomy space admin is allowed. Admin status is decided by the appserver
# through getUserAccess, proxied as the space's own account (so the appserver
# sees did = space DID, not the human caller — the caller's DID is passed in
# the params and bound to input.callerDid here).
allow if is_admin(input.callerDid)

is_admin(caller) := resp.output.isAdmin if {
   resp := xrpc({
      "did": "\${owner}#space_roomy_appserver",
      "method": "GET",
      "nsid": "space.roomy.space.getUserAccess",
      "parameters": {"spaceId": input.arbiterDid, "userDid": caller},
   })
}

default is_admin(_) := false

default allow := false
`;
