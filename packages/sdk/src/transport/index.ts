/**
 * `@roomy-space/sdk` transport module (Slice 3).
 *
 * Typed XRPC wrappers that validate every response through the same arktype
 * schemas used by the appserver, plus the registry mapping NSIDs to schemas.
 *
 * Two transport modes:
 * - `agentQuery`/`agentProcedure` — proxied through the PDS via `atproto-proxy`
 * - `DirectXrpcClient` — direct HTTP to the appserver with service auth tokens
 */
export { agentQuery, agentProcedure } from "./xrpc";
export { resolveAppserverWsOrigin, resolveAppserverHttpOrigin } from "./did-resolve";
export { XrpcResponseValidationError, RateLimitError, isRateLimitError, getRetryAfterMs } from "./errors";
export {
  QUERY_SCHEMAS,
  PROCEDURE_SCHEMAS,
  type QueryNsid,
  type ProcedureNsid,
  type QueryParams,
  type QueryResponse,
  type ProcedureInput,
  type ProcedureOutput,
} from "./registry";
export { ServiceAuthClient, type CachedToken } from "./service-auth";
export { DirectXrpcClient } from "./direct-xrpc";
