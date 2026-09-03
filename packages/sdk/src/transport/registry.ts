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
  "space.roomy.space.getSpaceSummary": {
    params: queries.getSpaceSummary.Params,
    response: queries.getSpaceSummary.Response,
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
  "space.roomy.room.getRoomSummary": {
    params: queries.getRoomSummary.Params,
    response: queries.getRoomSummary.Response,
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
  "space.roomy.message.getReactions": {
    params: queries.getReactions.Params,
    response: queries.getReactions.Response,
  },
  "space.roomy.space.getActivityFeed": {
    params: queries.getActivityFeed.Params,
    response: queries.getActivityFeed.Response,
  },
  "space.roomy.sync.getEvents": {
    params: queries.getEvents.Params,
    response: queries.getEvents.Response,
  },
  "space.roomy.push.getVapidPublicKey": {
    params: queries.getVapidPublicKey.Params,
    response: queries.getVapidPublicKey.Response,
  },
  "space.roomy.push.getPreferences": {
    params: queries.getPreferences.Params,
    response: queries.getPreferences.Response,
  },
  "space.roomy.getFlags": {
    params: queries.getFlags.Params,
    response: queries.getFlags.Response,
  },
  "space.roomy.user.getProfile": {
    params: queries.getProfile.Params,
    response: queries.getProfile.Response,
  },
  "space.roomy.user.getProfiles": {
    params: queries.getProfiles.Params,
    response: queries.getProfiles.Response,
  },
  "space.roomy.mention.getMentions": {
    params: queries.getMentions.Params,
    response: queries.getMentions.Response,
  },
  "space.roomy.search.messages": {
    params: queries.searchMessages.Params,
    response: queries.searchMessages.Response,
  },
  "space.roomy.search.rooms": {
    params: queries.searchRooms.Params,
    response: queries.searchRooms.Response,
  },
  "space.roomy.embed.getLinkMetadata": {
    params: queries.getLinkMetadata.Params,
    response: queries.getLinkMetadata.Response,
  },
  "space.roomy.federation.getRequests": {
    params: queries.getFederationRequests.Params,
    response: queries.getFederationRequests.Response,
  },
  "space.roomy.federation.getIncoming": {
    params: queries.getFederationIncoming.Params,
    response: queries.getFederationIncoming.Response,
  },
  "space.roomy.federation.getOutgoing": {
    params: queries.getFederationOutgoing.Params,
    response: queries.getFederationOutgoing.Response,
  },
  "space.roomy.federation.getGrants": {
    params: queries.getFederationGrants.Params,
    response: queries.getFederationGrants.Response,
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
  "space.roomy.space.reorderSpaces": {
    input: procedures.reorderSpaces.Input,
    output: procedures.reorderSpaces.Output,
  },
  "space.roomy.space.setHandle": {
    input: procedures.setHandle.Input,
    output: procedures.setHandle.Output,
  },
  "space.roomy.space.updatePolicy": {
    input: procedures.updatePolicy.Input,
    output: procedures.updatePolicy.Output,
  },
  "space.roomy.push.registerSubscription": {
    input: procedures.registerPushSubscription.Input,
    output: procedures.registerPushSubscription.Output,
  },
  "space.roomy.push.unregisterSubscription": {
    input: procedures.unregisterPushSubscription.Input,
    output: procedures.unregisterPushSubscription.Output,
  },
  "space.roomy.push.setPreferences": {
    input: procedures.setPreferences.Input,
    output: procedures.setPreferences.Output,
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
