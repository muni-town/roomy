/**
 * Schema for `space.roomy.space.updatePolicy` (procedure).
 *
 * Reinstalls the appserver's latest arbiter policy on a space's stewarded
 * account. Requires admin access on the space. The appserver, as the arbiter
 * recovery admin, calls `town.muni.arbiter.resetPolicy` with the current
 * default policy (which allows the space's Roomy admins to act under the
 * space's account).
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.updatePolicy" as const;

export const Input = type({
  spaceId: "string",
});

/** Void procedure — the appserver responds 200 with an empty body. */
export const Output = type({});
