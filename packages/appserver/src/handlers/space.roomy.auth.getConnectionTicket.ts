import { issueTicket } from "../xrpc/auth.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

export const getConnectionTicketHandler: QueryHandler<QueryParams, { ticket: string }> = async (
  _params: QueryParams,
  auth: AuthCtx,
) => {
  return { ticket: issueTicket(auth.did) };
};
