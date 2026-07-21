/**
 * Schema for `space.roomy.space.getSpaceSummary` (query).
 *
 * Lightweight read of a space's display fields (name, avatar) only — no
 * sidebar tree, no threads, no read positions, no membership hydration
 * beyond the single ban check. Intended for link-badge enrichment where a
 * rendered message references a space by DID and the client only needs
 * enough to render an avatar + label.
 *
 * Source of truth: packages/appserver/src/handlers/space.roomy.space.getSpaceSummary.ts
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.getSpaceSummary" as const;

export const Params = type({ spaceId: "string" });

export const Response = type({
  "name?": "string",
  "avatar?": "string",
});