/**
 * Central NSID → arktype schema registry.
 *
 * Each entry pairs a request schema (`params` for queries, `input` for
 * procedures) with a response schema (`response` / `output`). The wrappers in
 * `./xrpc.ts` look up entries by NSID and parse the wire payload through the
 * response schema.
 *
 * The registry is the single source of truth tying NSIDs to schemas; it is
 * used to derive the typed maps `QueryResponses` and `ProcedureOutputs` so
 * `agentQuery(agent, nsid, params)` is fully typed at the call site.
 */
import { queries, procedures } from "../schemas/index";

export const QUERY_SCHEMAS = {
  "space.roomy.space.getSpaces": {
    params: queries.getSpaces.Params,
    response: queries.getSpaces.Response,
  },
  "space.roomy.space.getMetadata": {
    params: queries.getSpaceMetadata.Params,
    response: queries.getSpaceMetadata.Response,
  },
  "space.roomy.space.getThreads": {
    params: queries.getSpaceThreads.Params,
    response: queries.getSpaceThreads.Response,
  },
  "space.roomy.space.getRoles": {
    params: queries.getRoles.Params,
    response: queries.getRoles.Response,
  },
  "space.roomy.space.getMembers": {
    params: queries.getMembers.Params,
    response: queries.getMembers.Response,
  },
  "space.roomy.space.getInvites": {
    params: queries.getInvites.Params,
    response: queries.getInvites.Response,
  },
  "space.roomy.room.getMetadata": {
    params: queries.getRoomMetadata.Params,
    response: queries.getRoomMetadata.Response,
  },
  "space.roomy.room.getThreads": {
    params: queries.getRoomThreads.Params,
    response: queries.getRoomThreads.Response,
  },
  "space.roomy.room.getMessages": {
    params: queries.getMessages.Params,
    response: queries.getMessages.Response,
  },
  "space.roomy.message.getMessage": {
    params: queries.getMessage.Params,
    response: queries.getMessage.Response,
  },
} as const;

export const PROCEDURE_SCHEMAS = {
  "space.roomy.auth.getConnectionTicket": {
    input: procedures.getConnectionTicket.Input,
    output: procedures.getConnectionTicket.Output,
  },
  "space.roomy.room.updateSeen": {
    input: procedures.updateSeen.Input,
    output: procedures.updateSeen.Output,
  },
  "space.roomy.space.sendEvents": {
    input: procedures.sendEvents.Input,
    output: procedures.sendEvents.Output,
  },
  "space.roomy.space.createSpace": {
    input: procedures.createSpace.Input,
    output: procedures.createSpace.Output,
  },
  "space.roomy.space.joinSpace": {
    input: procedures.joinSpace.Input,
    output: procedures.joinSpace.Output,
  },
  "space.roomy.space.leaveSpace": {
    input: procedures.leaveSpace.Input,
    output: procedures.leaveSpace.Output,
  },
} as const;

export type QueryNsid = keyof typeof QUERY_SCHEMAS;
export type ProcedureNsid = keyof typeof PROCEDURE_SCHEMAS;

export type QueryParams<N extends QueryNsid> =
  (typeof QUERY_SCHEMAS)[N]["params"] extends { infer: infer T } ? T : never;
export type QueryResponse<N extends QueryNsid> =
  (typeof QUERY_SCHEMAS)[N]["response"] extends { infer: infer T } ? T : never;

export type ProcedureInput<N extends ProcedureNsid> =
  (typeof PROCEDURE_SCHEMAS)[N]["input"] extends { infer: infer T } ? T : never;
export type ProcedureOutput<N extends ProcedureNsid> =
  (typeof PROCEDURE_SCHEMAS)[N]["output"] extends { infer: infer T } ? T : never;
