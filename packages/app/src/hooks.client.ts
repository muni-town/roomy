import { dev } from "$app/environment";
import { initializeFaro } from "$lib/otel";
import type { HandleClientError } from "@sveltejs/kit";

if (dev && window.location.hostname == "localhost")
  window.location.hostname = "127.0.0.1";

initializeFaro({ worker: "main" });

tracer.startActiveSpan("Roomy Init", (span) => {
  (globalThis as any).globalInitSpan = span;
});

// For now, unregister the service worker, in case it might be causing problems.
window.navigator.serviceWorker.getRegistrations().then((registrations) => {
  let hadRegistration = false;
  for (const registration of registrations) {
    hadRegistration = true;
    registration.unregister();
  }
  // Reload the page just to make sure things are totally reset.
  if (hadRegistration) window.location.reload();
});

export const handleError: HandleClientError = async ({
  error,
  event,
  status,
  message,
}) => {
  faro.api.pushError({
    message: `message=${message} status=${status} ${Object.entries(event.params)
      .map(([k, v]) => `params.${k}=${v}`)
      .join(" ")} url=${event.url} route.id=${event.route.id}`,
    name: "Svelte client error",
  });

  if (status !== 404) {
    console.error(error, status, event, message);
  }
};
