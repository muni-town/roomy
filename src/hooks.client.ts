import type { HandleClientError } from "@sveltejs/kit";
import posthog from "posthog-js";

// We're handling this in ThemeSelector.svelte
// export const handle: Handle = async ({ event, resolve }) => {
//   const theme = event.cookies.get("theme");
//   if (!theme || !Object.keys(themes).includes("data-theme=${theme}")) {
//     event.cookies.set("theme", "synthwave", { path: "/" });
//     return await resolve(event);
//   }

//   return await resolve(event, {
//     transformPageChunk: ({ html }) => {
//       return html.replace('data-theme=""', `data-theme="${theme}"`);
//     },
//   });
// };

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
