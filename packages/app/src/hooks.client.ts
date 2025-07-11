import { dev } from "$app/environment";
import type { HandleClientError } from "@sveltejs/kit";
import posthog from "posthog-js";

if (dev) {
  const jazz = await import("jazz-tools");
  (globalThis as any).jazz = jazz;
}

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
