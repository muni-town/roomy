import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ url }) => {
  const body = url.searchParams.get("url");

  try {
    const res = await fetch("https://embed.internal.weird.one?lang=en", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain",
      },
      body,
    });

    if (res.ok) {
      const data = await res.json();
      return json(data);
    } else {
      console.error(
        `Embed server error: ${res.status} ${res.statusText}: for url ${body}`,
      );
      return error(
        res.status,
        `Embed server error: ${res.status} ${res.statusText}: for url ${body}`,
      );
    }
  } catch (err) {
    if (err instanceof TypeError) {
      return error(400, `${err.message}. ${err.cause}`);
    } else return error(400, err as unknown as string);
  }
};
