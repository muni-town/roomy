/**
 * Schema for `space.roomy.message.getMessage` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.message.getMessage.ts
 *
 * Returns a single MessageDto at the top level (not wrapped).
 */
import { type } from "arktype";
import { Message } from "./_message";

export const NSID = "space.roomy.message.getMessage" as const;

export const Params = type({ messageId: "string" });

export const Response = Message;
