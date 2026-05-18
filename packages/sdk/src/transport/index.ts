/**
 * `@roomy-space/sdk` transport module (Slice 3).
 *
 * Typed XRPC wrappers that validate every response through the same arktype
 * schemas used by the appserver, plus the registry mapping NSIDs to schemas.
 */
export { agentQuery, agentProcedure } from "./xrpc";
export { resolveAppserverWsOrigin } from "./did-resolve";
export { XrpcResponseValidationError } from "./errors";
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
