import { LeafClient } from "@muni-town/leaf-client";
import type { Agent } from "@atproto/api";
import { context } from "@opentelemetry/api";
import { tracer } from "../otel";

export interface LeafConfig {
  leafUrl: string;
  leafDid: string;
}

/**
 * Authentication strategy for the Leaf client.
 *
 * - `atproto`: mint short-lived ATProto service-auth JWTs from a logged-in
 *   user's `Agent` (the standard end-user flow).
 * - `static`: present a static token directly. Intended for trusted
 *   service-to-service scenarios where the Leaf server is configured with
 *   `UNSAFE_AUTH_TOKEN`. The token authenticates the connection as the Leaf
 *   server's own DID; never expose it to untrusted callers.
 */
export type LeafAuth =
  | { type: "atproto"; agent: Agent }
  | { type: "static"; token: string };

/**
 * Create a LeafClient using the provided auth strategy.
 *
 * For ATProto auth, the agent handles token refresh automatically. For static
 * tokens, the same value is returned on each (re)connect.
 */
export function createLeafClient(
  auth: LeafAuth,
  config: LeafConfig,
): LeafClient {
  if (auth.type === "static") {
    const { token } = auth;
    return new LeafClient(config.leafUrl, async () => token);
  }

  const { agent } = auth;
  const ctx = context.active();
  return new LeafClient(config.leafUrl, async () => {
    const resp = await tracer.startActiveSpan(
      "Authenticate Leaf Client",
      {},
      ctx,
      async (span) => {
        const resp = await agent.com.atproto.server.getServiceAuth(
          {
            aud: config.leafDid,
            lxm: "town.muni.leaf.authenticate",
          },
          {
            headers: {
              "atproto-proxy": `${agent.assertDid}#atproto_pds`,
            },
          },
        );
        span.end();
        return resp;
      },
    );
    return resp.data.token;
  });
}
