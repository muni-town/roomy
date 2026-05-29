/**
 * Validated XRPC wrappers over an atproto `Agent`.
 *
 *   - `agentQuery(agent, nsid, params)`  — GET-style call, parses response.
 *   - `agentProcedure(agent, nsid, input)` — POST-style call, parses output.
 *
 * Both look up the arktype schema for `nsid` in the registry and throw a
 * typed `XrpcResponseValidationError` if the payload doesn't match. Void
 * procedure outputs (modelled as the empty object in the schema) work the
 * same way — the empty parse succeeds and `{}` is returned.
 *
 * The caller is responsible for handing in an `Agent` already configured to
 * reach the appserver (e.g. via `makeProxiedAgent` from
 * `@roomy-space/sdk/browser`). The transport layer itself has no opinion on
 * proxying or auth.
 */
import type { Agent } from "@atproto/api";
import { type } from "arktype";
import {
  QUERY_SCHEMAS,
  PROCEDURE_SCHEMAS,
  type QueryNsid,
  type QueryParams,
  type QueryResponse,
  type ProcedureNsid,
  type ProcedureInput,
  type ProcedureOutput,
} from "./registry";
import { XrpcResponseValidationError } from "./errors";



export async function agentQuery<N extends QueryNsid>(
  agent: Agent,
  nsid: N,
  params: QueryParams<N>,
): Promise<QueryResponse<N>> {
  const entry = QUERY_SCHEMAS[nsid];
  // params validation is informational here; the appserver re-validates.
  // Stringify all values for XRPC query string semantics.
  const stringParams = stringifyParams(params as Record<string, unknown>);
  let response;
  response = await agent.call(nsid, stringParams);
  const parsed = entry.response(response.data);
  if (parsed instanceof type.errors) {
    throw new XrpcResponseValidationError(nsid, parsed);
  }
  return parsed as QueryResponse<N>;
}

export async function agentProcedure<N extends ProcedureNsid>(
  agent: Agent,
  nsid: N,
  input: ProcedureInput<N>,
): Promise<ProcedureOutput<N>> {
  const entry = PROCEDURE_SCHEMAS[nsid];
  let response;
  response = await agent.call(nsid, {}, input as Record<string, unknown>);
  // Void outputs: appserver short-circuits to empty body. Treat `undefined`
  // or `null` as `{}` so the empty-object schema parses cleanly.
  const data =
    response.data === undefined || response.data === null
      ? {}
      : response.data;
  const parsed = entry.output(data);
  if (parsed instanceof type.errors) {
    throw new XrpcResponseValidationError(nsid, parsed);
  }
  return parsed as ProcedureOutput<N>;
}

function stringifyParams(
  params: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}
