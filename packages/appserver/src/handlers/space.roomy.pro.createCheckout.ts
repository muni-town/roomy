/**
 * XRPC: space.roomy.pro.createCheckout (procedure).
 *
 * Creates a Polar checkout session for the caller's Roomy Pro purchase,
 * bound to their Roomy DID as the Polar customer external ID.
 *
 * Why this exists: the appserver checks subscription status via
 * `GET /customers/external/{external_id}/state` with external_id = user DID
 * (see billing/polar.ts). Polar only sets that external ID when the
 * checkout session is created with `external_customer_id` — a static
 * Checkout Link cannot carry it. So every checkout must be minted here,
 * server-side, with the authenticated caller's DID.
 *
 * On successful payment Polar creates the customer with external_id = DID;
 * the success_url redirects back to the app's subscription page with
 * `?checkout={CHECKOUT_ID}` (Polar substitutes the session id), which the
 * existing page passes to `getMembershipStatus` to force a fresh read.
 *
 * Returns the Polar-hosted checkout URL; the client redirects the browser
 * there. Polar disabled (no POLAR_ACCESS_TOKEN) → 503.
 */

import {
  createCheckoutSession,
  getPolar,
  PolarUnavailableError,
} from "../billing/polar.ts";
import { parseUserDid } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";

interface CreateProCheckoutResult {
  checkoutUrl: string;
}

export const createProCheckoutHandler: ProcedureHandler<
  Record<string, unknown>,
  CreateProCheckoutResult
> = async (_params: QueryParams, auth: AuthCtx, _body: Record<string, unknown>) => {
  const userDid = parseUserDid(auth);
  if (userDid === null) {
    throw new XrpcError(401, "AuthRequired", "Authentication required");
  }

  const config = getPolar();
  if (!config) {
    throw new XrpcError(
      503,
      "ServiceUnavailable",
      "Polar billing is not configured",
    );
  }

  const successUrl =
    `${config.appOrigin}/user/settings/subscription?checkout={CHECKOUT_ID}`;

  let session;
  try {
    session = await createCheckoutSession(config, {
      externalCustomerId: userDid,
      successUrl,
    });
  } catch (err) {
    // A checkout session cannot be minted without Polar — the user simply
    // cannot subscribe right now. Surface as a service outage (503), not an
    // internal error (500); matches the capacity path's Polar-outage code.
    if (err instanceof PolarUnavailableError) {
      throw new XrpcError(
        503,
        "ServiceUnavailable",
        "Polar is unavailable — checkout could not be started",
      );
    }
    throw err;
  }

  return { checkoutUrl: session.url };
};
