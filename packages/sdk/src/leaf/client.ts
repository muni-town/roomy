import { LeafClient } from "@muni-town/leaf-client";
import type { Agent } from "@atproto/api";

export interface LeafConfig {
  leafUrl: string;
  leafDid: string;
}

/**
 * Create a LeafClient authenticated via ATProto service auth.
 * The agent handles token refresh automatically.
 */
export function createLeafClient(agent: Agent, config: LeafConfig): LeafClient {
  return new LeafClient(config.leafUrl, async () => {
    const resp = await agent.com.atproto.server.getServiceAuth({
      aud: config.leafDid,
      lxm: "town.muni.leaf.authenticate",
    });
    return resp.data.token;
  });
}
