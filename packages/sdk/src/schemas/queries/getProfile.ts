/**
 * Schema for `space.roomy.user.getProfile` (query).
 *
 * Returns a user's profile from the appserver's materialized data
 * (comp_info/comp_user), which is sourced Roomy-first (PDS record) with
 * Bluesky fallback.
 */
import { type } from "arktype";

export const NSID = "space.roomy.user.getProfile" as const;

export const Params = type({
  /** DID or handle of the user to fetch the profile for. */
  actor: "string",
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

export const Response = Profile;