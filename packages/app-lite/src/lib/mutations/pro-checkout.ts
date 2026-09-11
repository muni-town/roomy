import { px } from "$lib/auth.svelte";

/**
 * Mint a Polar checkout session for the caller's Roomy Pro subscription and
 * return the URL to redirect the browser to.
 *
 * The session is bound to the caller's DID as the Polar customer external
 * ID (set server-side), so on successful payment Polar creates the customer
 * with external_id = DID and the appserver's status checks resolve it.
 */
export async function createProCheckout(): Promise<string> {
  const res = await px().procedure("space.roomy.pro.createCheckout", {});
  return res.checkoutUrl;
}
