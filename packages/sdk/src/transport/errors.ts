/**
 * Typed error raised when an XRPC response (or request input) fails to parse
 * against its arktype schema. Carries the NSID and the underlying arktype
 * error so callers can surface contract drift between client and appserver.
 */
import type { type } from "arktype";

export class XrpcResponseValidationError extends Error {
  readonly nsid: string;
  readonly arktypeError: type.errors;

  constructor(nsid: string, arktypeError: type.errors) {
    super(`XRPC response failed validation for ${nsid}: ${arktypeError.summary}`);
    this.name = "XrpcResponseValidationError";
    this.nsid = nsid;
    this.arktypeError = arktypeError;
  }
}
