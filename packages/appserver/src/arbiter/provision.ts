/**
 * Space provisioning through the arbiter.
 *
 * When the arbiter is configured, new spaces are provisioned as real ATProto
 * accounts instead of self-generated did:plc DIDs. The flow:
 *
 *   1. `createArbiter` — the arbiter creates a real account on the Roomy PDS
 *      and returns its DID. It writes the account's service + recovery
 *      records (the recovery record names the appserver) but NO config: the
 *      arbiter stays offline (fail-closed) until configured.
 *   2. `resetConfig` — bootstrap the reference arbiter config via the
 *      recovery-admin-only hatch (the appserver is the recovery admin).
 *      Writes `town.muni.arbiter.config/self` and re-onboards the arbiter.
 *   3. `proxy` — write the `space.roomy.service/self` record under the new
 *      account, marking it as a Roomy space hosted by the appserver.
 */

import { createArbiter, proxy, resetConfig } from "./client.ts";
import type { ArbiterConfig } from "./config.ts";
import { StreamDid } from "@roomy-space/sdk";

/**
 * The reference arbiter config applied to every Roomy space — at provisioning
 * time and via the `space.roomy.space.updatePolicy` repair procedure.
 *
 * Must stay in sync with `scripts/migrate-arbiter-configs.ts`, which
 * bootstraps the same config onto spaces provisioned before this constant
 * existed.
 */
export const REFERENCE_ARBITER_CONFIG: {
  trustedScopes: string[];
  policyLayers: string[];
} = {
  trustedScopes: ["space.roomy.authComplete"],
  policyLayers: ["at://did:plc:cyqufxsezk33hqulcilckna6/town.muni.arbiter.policy/default"],
};

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

  // 2. Bootstrap the reference arbiter config. The appserver is the recovery
  //    admin for every stewarded account, so resetConfig is authorized even
  //    while the account is still offline. Throws ArbiterError on failure.
  await resetConfig(config, ownDid, spaceDid, REFERENCE_ARBITER_CONFIG);

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
