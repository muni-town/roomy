/**
 * Space provisioning through the arbiter.
 *
 * When the arbiter is configured, new spaces are provisioned as real ATProto
 * accounts instead of self-generated did:plc DIDs. The flow:
 *
 *   1. `createArbiter` — the arbiter creates a real account on the Roomy PDS
 *      and returns its DID.
 *   2. `resetPolicy` — install the default policy (owner = the appserver) so
 *      the appserver may act on the space DID.
 *   3. `proxy` — write the `space.roomy.service/self` record under the new
 *      account, marking it as a Roomy space hosted by the appserver.
 */

import { createArbiter, proxy, resetPolicy } from "./client.ts";
import type { ArbiterConfig } from "./config.ts";
import { DEFAULT_ARBITER_POLICY } from "./policy.ts";
import { StreamDid } from "@roomy-space/sdk";

/** The default policy for a newly-provisioned space, with placeholders filled in. */
export function defaultPolicyFor(
  ownDid: string,
): string {
  return DEFAULT_ARBITER_POLICY.replaceAll("${owner}", ownDid);
}

const SERVICE_COLLECTION = "space.roomy.service";
const SERVICE_RKEY = "self";

/**
 * Provision a new space through the arbiter.
 *
 * Returns the new space DID. Throws `ArbiterError` on any arbiter failure.
 */
export async function provisionSpace(
  config: ArbiterConfig,
  ownDid: string,
): Promise<StreamDid> {
  // 1. Create the stewarded account.
  const spaceDid = await createArbiter(config, ownDid);

  // 2. Install the latest policy (owner = the appserver).
  await resetPolicy(config, ownDid, spaceDid, defaultPolicyFor(ownDid));

  // 3. Write the space.roomy.service/self record under the new account,
  //    proxied through the arbiter as the space DID.
  await proxy(
    config,
    ownDid,
    spaceDid,
    `${spaceDid}#atproto_pds`,
    "POST",
    "com.atproto.repo.putRecord",
    undefined,
    {
      repo: spaceDid,
      collection: SERVICE_COLLECTION,
      rkey: SERVICE_RKEY,
      record: {
        $type: SERVICE_COLLECTION,
        did: ownDid,
      },
    },
  );

  return StreamDid.assert(spaceDid);
}
