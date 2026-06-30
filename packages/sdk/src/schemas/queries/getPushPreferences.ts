/**
 * Schema for `space.roomy.push.getPushPreferences` (query).
 * Source of truth: packages/appserver/src/handlers/space.roomy.push.getPreferences.ts
 *
 * Returns the caller's notification preferences: a user-wide default level
 * plus any per-space overrides. Levels: silent | quiet | engaged | busy.
 */
import { type } from "arktype";

export const NSID = "space.roomy.push.getPushPreferences" as const;

/** Notification level enum shared across the push lexicons. */
export const Level = type("'silent' | 'quiet' | 'engaged' | 'busy'");

export const Params = type({});

export const PerSpacePreference = type({
  spaceId: "string",
  level: "'silent' | 'quiet' | 'engaged' | 'busy'",
});

export const Response = type({
  default: "'silent' | 'quiet' | 'engaged' | 'busy'",
  perSpace: PerSpacePreference.array(),
});