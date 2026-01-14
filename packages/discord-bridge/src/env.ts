export const DISCORD_TOKEN = process.env.DISCORD_TOKEN as string;
if (!DISCORD_TOKEN)
  throw new Error("DISCORD_TOKEN environment variable not provided.");

export const PORT = parseInt(process.env.PORT || "3301");
