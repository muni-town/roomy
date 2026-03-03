import { dev } from "$app/environment";
import type { Embed } from "$lib/types/embed-sdk";

export const cache = new Map<string, Embed | null>();

export const getLinkEmbedData = (url: string) => {
  let data = cache.get(url);
  if (data !== undefined) return data;

  return fetch(dev ? "/api/og" : "https://embed.internal.weird.one?lang=en", {
    method: "POST",
    headers: {
      "Content-Type": "text/plain",
    },
    body: url,
  })
    .then(async (res) => {
      if (res.ok) {
        const data = (await res.json()) as [Embed["ts"], Embed];
        cache.set(url, data[1]);
        return data[1];
      } else {
        console.error(
          `${res.status} Error finding data for url ${url}:  ${res.statusText}`,
        );
        // Embed server has no data for the given url.
        // Unlikely to be any data in the future
        cache.set(url, null);
        return null
      }
    })
    .catch((err) => {
      if (err instanceof TypeError) {
        console.error(`${err.message} caused by '${err.cause}'`);
        // Avoid retrying urls with Network Errors until next refresh
        // Might have data later.
      }
      console.error(err)
      return undefined
    });
};
