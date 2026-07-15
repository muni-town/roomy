/**
 * Arktype schema for space.roomy.getFlags.
 *
 * Returns the set of feature flag keys that are enabled for the calling user.
 * All flags default to false.
 */

import { type } from "arktype";

export const NSID = "space.roomy.getFlags";

export const Params = type({});

export const Response = type({
  flags: "string[]",
});
