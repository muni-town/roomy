import { dev } from "$app/environment";
import type { HandleClientError } from "@sveltejs/kit";
import posthog from "posthog-js";

if (dev && window.location.hostname == "localhost")
  window.location.hostname = "127.0.0.1";

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
