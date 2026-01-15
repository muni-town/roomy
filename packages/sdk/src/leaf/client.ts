import { LeafClient } from "@muni-town/leaf-client";
import type { Agent } from "@atproto/api";
import { context } from "@opentelemetry/api";
import { tracer } from "../otel";

export interface LeafConfig {
  leafUrl: string;
  leafDid: string;
}

/**
 * Create a LeafClient authenticated via ATProto service auth.
 * The agent handles token refresh automatically.
 */
export function createLeafClient(agent: Agent, config: LeafConfig): LeafClient {
  const ctx = context.active();
  return new LeafClient(config.leafUrl, async () => {
    const resp = await tracer.startActiveSpan(
      "Authenticate Leaf Client",
      {},
      ctx,
      async (span) => {
        const resp = await agent.com.atproto.server.getServiceAuth({
          aud: config.leafDid,
          lxm: "town.muni.leaf.authenticate",
        });
        span.end();
        return resp;
      },
    );
    return resp.data.token;
  });
}
