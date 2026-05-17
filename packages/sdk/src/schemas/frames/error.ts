/**
 * Schema for the `#error` WS frame body.
 * Sent server → client when the connection is being closed due to an error.
 * Source of truth: packages/appserver/src/xrpc/frame.ts (errorFrame).
 *
 * Header is `{ op: -1, t: "#error" }`.
 */
import { type } from "arktype";

export const T = "#error" as const;

export const Body = type({
  error: "string",
  message: "string",
});
export type Body = typeof Body.infer;
