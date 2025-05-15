import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import {
  PUBLIC_DISCORD_BRIDGE_URL,
  PUBLIC_DISCORD_BRIDGE_PORT,
} from "$env/static/public";

export const POST: RequestHandler = async ({ request }) => {
  try {
    const { token, guildId } = await request.json();

    if (!token || !guildId) {
      return json({ error: "Missing token or guild ID" }, { status: 400 });
    }

    const bridgeUrl = PUBLIC_DISCORD_BRIDGE_URL || "http://localhost";
    const bridgePort = PUBLIC_DISCORD_BRIDGE_PORT || "3000";
    const bridgeServerUrl = `${bridgeUrl}:${bridgePort}`;

    // Forward request to the bridge server
    const response = await fetch(`${bridgeServerUrl}/api/discord-channels`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token, guildId }),
    });

    const data = await response.json();

    if (!response.ok) {
      return json({ error: data.error }, { status: response.status });
    }

    return json(data);
  } catch (error) {
    console.error("Error in Discord channels API:", error);
    return json({ error: "Internal server error" }, { status: 500 });
  }
};
