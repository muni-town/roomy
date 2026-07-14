/**
 * Schema for `space.roomy.push.setPushPreferences` (procedure).
 * Source of truth: packages/appserver/src/handlers/space.roomy.push.setPreferences.ts
 *
 * Sets the user-wide default notification level and/or a per-space override.
 *   - `spaceId` omitted → set the user-wide default.
 *   - `spaceId` present  → set/override the per-space level.
 * `level` is one of silent | quiet | engaged | busy.
 * At least one of `default` / `level` must be provided.
 */
import { type } from "arktype";

export const NSID = "space.roomy.push.setPushPreferences" as const;

export const Input = type({
  "default?": "'silent' | 'quiet' | 'engaged' | 'busy'",
  "spaceId?": "string",
  "level?": "'silent' | 'quiet' | 'engaged' | 'busy'",
});

/** Void: handler returns nothing. The wire payload is empty. */
export const Output = type({});