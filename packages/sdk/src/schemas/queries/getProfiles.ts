/**
 * Schema for `space.roomy.user.getProfiles` (query).
 *
 * Batch-fetch Roomy profile records from a HappyView index service.
 * Returns profiles for DIDs that have a `space.roomy.user.profile` record.
 * DIDs without a Roomy profile are omitted — callers fall back to Bluesky.
 *
 * Mirrors `app.bsky.actor.getProfiles` semantics: `actors` is a repeated
 * query string param (one per DID, max 25), response is `{ profiles: [...] }`.
 */
import { type } from "arktype";

export const NSID = "space.roomy.user.getProfiles" as const;

export const Params = type({
  /** DID to look up. Repeated param — one per DID, max 25 per request. */
  actors: "string",
});

export const Profile = type({
  did: "string",
  "handle?": "string",
  "displayName?": "string",
  "description?": "string",
  "pronouns?": "string",
  "website?": "string",
  "avatar?": "string",
  "banner?": "string",
});

export const Response = type({
  profiles: Profile.array(),
});