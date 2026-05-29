/**
 * Schema for `space.roomy.space.createSpace` (procedure).
 * Source of truth: packages/appserver/docs/plans/procedure-backlog.md
 *
 * Provisions a new Leaf stream, seeds it with the initial event set
 * (space metadata, creator added as admin/member, default room + sidebar),
 * and registers the space so `getSpaces` picks it up.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.createSpace" as const;

export const Input = type({
  name: "string",
  "description?": "string",
  "avatar?": "string",
});

export const Output = type({
  spaceId: "string",
});
