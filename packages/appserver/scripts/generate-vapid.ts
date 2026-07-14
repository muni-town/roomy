/**
 * Generate a VAPID keypair for web push.
 *
 *   bun run scripts/generate-vapid.ts
 *
 * Prints the base64url public + private keys. Store them as environment
 * variables (e.g. in `.env` / your secret manager) and set `VAPID_SUBJECT`
 * (a `mailto:` or URL contact). The public key is handed to browsers so
 * they can create a `PushSubscription`; the private key stays on the
 * appserver and signs the VAPID JWT used for delivery.
 *
 * Run once per environment. Rotating keys invalidates existing
 * subscriptions (browsers must re-subscribe with the new public key).
 */
import { generateVAPIDKeys } from "web-push";

const keys = generateVAPIDKeys();

console.log("VAPID keypair generated.\n");
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);
console.log(
  "\nSet VAPID_SUBJECT (mailto: or URL) in your environment, e.g. " +
    "VAPID_SUBJECT=mailto:you@example.com",
);