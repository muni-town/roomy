export const DISCORD_TOKEN = process.env.DISCORD_TOKEN as string;
if (!DISCORD_TOKEN)
  throw new Error("DISCORD_TOKEN environment variable not provided.");

export const PORT = parseInt(process.env.PORT || "3301");

// export const JAZZ_ACCOUNT_ID = process.env.JAZZ_WORKER_ACCOUNT as string;
// export const JAZZ_ACCOUNT_SECRET = process.env.JAZZ_WORKER_SECRET as string;
// export const JAZZ_EMAIL = process.env.JAZZ_EMAIL as string;
// if (!JAZZ_ACCOUNT_ID || !JAZZ_ACCOUNT_SECRET || !JAZZ_EMAIL)
//   throw new Error(
//     "Missing JAZZ_WORKER_ACCOUNT, JAZZ_EMAIL, or JAZZ_WORKER_SECRET env vars",
//   );
