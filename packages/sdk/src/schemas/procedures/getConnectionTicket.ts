/**
 * Schema for `space.roomy.auth.getConnectionTicket` (procedure).
 * Source of truth: packages/appserver/src/handlers/space.roomy.auth.getConnectionTicket.ts
 *
 * Note: appserver's index.ts registers this as a `procedure`, and the playground's
 * lexicon also declares it as `type: "procedure"`. The handler signature happens
 * to take no body (the input is empty), but the wire method is POST.
 */
import { type } from "arktype";

export const NSID = "space.roomy.auth.getConnectionTicket" as const;

/** No input body. */
export const Input = type({});

export const Output = type({
  ticket: "string",
});
