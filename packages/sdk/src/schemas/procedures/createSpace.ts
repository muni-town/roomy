/**
 * Schema for `space.roomy.space.createSpace` (procedure).
 * Source of truth: packages/appserver/docs/plans/procedure-backlog.md
 *
 * Provisions a new space, seeds it with the initial event set
 * (space metadata, creator added as admin/member, default room + sidebar),
 * and registers the space so `getSpaces` picks it up.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.createSpace" as const;

export const Input = type({
  name: "string",
  "description?": "string",
  "avatar?": "string",
  /**
   * Whether the new space may be suggested to other users. A new space is
   * created through a flow that asks this, so the creator's answer is stored
   * explicitly; omitted leaves it unanswered (which reads as yes).
   */
  "suggestToOthers?": "boolean",
});

export const Output = type({
  spaceId: "string",
});
