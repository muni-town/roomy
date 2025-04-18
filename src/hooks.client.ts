import { themes } from "$lib/themes";
import type { Handle, HandleClientError } from "@sveltejs/kit";
import posthog from "posthog-js";

export const handle: Handle = async ({ event, resolve }) => {
  const theme = event.cookies.get("theme");
  if (!theme || !themes.includes(theme)) {
    event.cookies.set("theme", "retro", { path: "/" });
    return await resolve(event);
  }

  return await resolve(event, {
    transformPageChunk: ({ html }) => {
      return html.replace('data-theme=""', `data-theme="${theme}"`);
    },
  });
};

export const handleError: HandleClientError = async ({
  error,
  event,
  status,
  message,
}) => {
  if (status !== 404) {
    posthog.captureException(error, { status, event, message });
  }
};
