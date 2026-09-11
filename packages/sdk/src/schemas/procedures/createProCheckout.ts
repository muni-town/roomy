/**
 * Schema for `space.roomy.pro.createCheckout` (procedure).
 *
 * Creates a Polar checkout session for the caller bound to their Roomy DID
 * as the customer external ID (`external_customer_id`). On successful
 * payment Polar creates the customer with external_id = DID, which is how
 * the subscription-status endpoints (`getMembershipStatus`, bridge-token
 * grants) find the customer via `GET /customers/external/{did}/state`.
 *
 * Returns the Polar-hosted checkout URL the client should redirect the
 * browser to; Polar redirects back to the app's subscription page with
 * `?checkout={CHECKOUT_ID}` after payment.
 */
import { type } from "arktype";

export const NSID = "space.roomy.pro.createCheckout" as const;

/** No input body — the caller's DID comes from the auth context. */
export const Input = type({});

export const Output = type({
  /** URL of the Polar-hosted checkout page. Redirect the browser here. */
  checkoutUrl: "string",
});
