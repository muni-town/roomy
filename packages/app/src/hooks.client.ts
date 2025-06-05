import type { HandleClientError } from "@sveltejs/kit";
import posthog from "posthog-js";

export const handleError: HandleClientError = async ({
  error,
  event,
  status,
  message,
}) => {
  if (status !== 404) {
    console.error(error,status,event,message)
    posthog.captureException(error, { status, event, message });
  }
};
