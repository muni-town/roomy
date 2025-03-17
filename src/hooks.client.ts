import { themes } from "$lib/themes";
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  const theme = event.cookies.get("theme");
  if (!theme || !themes.includes(theme)) {
    event.cookies.set("theme", "retro", { path: "/" });
    return await resolve(event);
  }
  
  return await resolve(event, {
    transformPageChunk: ({ html }) => {
      return html.replace('data-theme=""', `data-theme="${theme}"`);
    }
  });
}