/**
 * Schema for `space.roomy.federation.getRequests` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.federation.getRequests.ts
 *
 * Returns the pending federation requests addressed to a space (A), visible
 * to that space's admins for approval/rejection.
 */
import { type } from "arktype";

export const NSID = "space.roomy.federation.getRequests" as const;

export const Params = type({ spaceId: "string" });

export const FederationRequest = type({
  federatingSpaceDid: "string",
  "federatingSpaceName?": "string",
  requestedByDid: "string",
  "requestedByName?": "string",
  "requestedByHandle?": "string",
  requestedAt: "number",
  "message?": "string",
});

export const Response = type({
  requests: FederationRequest.array(),
});
