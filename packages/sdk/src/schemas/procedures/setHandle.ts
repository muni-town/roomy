/**
 * Schema for `space.roomy.space.setHandle` (procedure).
 *
 * Sets the Leaf-level handle for a space (updates the DID document with a
 * `leaf://` alias), or removes an existing alias when handle is null.
 *
 * This is the DNS-based handle approach — it requires the user to create a
 * DNS TXT record for their domain pointing to the space DID. The appserver
 * validates admin access and proxies the call to Leaf.
 */
import { type } from "arktype";

export const NSID = "space.roomy.space.setHandle" as const;

export const Input = type({
  spaceId: "string",
  "handle?": "string | null",
});

/** Void procedure — the appserver responds 200 with an empty body. */
export const Output = type({});
