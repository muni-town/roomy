import type { Embed } from "$lib/types/embed-sdk";

export const getLinkEmbedData = async (url: string) => {
  try {
    const res = await fetch("https://embed.internal.weird.one?lang=en", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body: url,
    });

    if (res.ok) {
      const data = (await res.json()) as [Embed["ts"], Embed];
      return data[1];
    } else {
      console.error(
        `Embed server error: ${res.status} ${res.statusText}: for url ${url}`,
      );
    }
  } catch (err) {
    if (err instanceof TypeError) {
      return console.error(400, `${err.message}. ${err.cause}`);
    } else return console.error(400, err as unknown as string);
  }
};
