import { dev } from "$app/environment";
import type { HandleClientError } from "@sveltejs/kit";
import posthog from "posthog-js";

if (dev && window.location.hostname == "localhost")
  window.location.hostname = "127.0.0.1";

// For now, unregister the service worker, in case it might be causing problems.
window.navigator.serviceWorker.getRegistrations().then(registrations => {
  let hadRegistration = false;
  for (const registration of registrations) {
    hadRegistration = true;
    registration.unregister()
  }
  // Reload the page just to make sure things are totally reset.
  if (hadRegistration) window.location.reload();
})

export const handleError: HandleClientError = async ({
  error,
  event,
  status,
  message,
}) => {
  if (status !== 404) {
    console.error(error, status, event, message);
    posthog.captureException(error, { status, event, message });
  }
};
