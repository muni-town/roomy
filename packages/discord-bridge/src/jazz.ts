import { Account } from "jazz-tools";
import { startWorker as startJazzWorker } from "jazz-tools/worker";
import { JAZZ_ACCOUNT_ID, JAZZ_ACCOUNT_SECRET, JAZZ_EMAIL } from "./env.js";
import { RoomyAccount } from "@roomy-chat/sdk";

export async function startWorker(): Promise<{
  worker: Account;
}> {
  const syncServer = `wss://cloud.jazz.tools/?key=${JAZZ_EMAIL}`;

  const { worker } = await startJazzWorker({
    AccountSchema: RoomyAccount,
    accountID: JAZZ_ACCOUNT_ID,
    accountSecret: JAZZ_ACCOUNT_SECRET,
    syncServer,
  });

  console.log(
    "Jazz worker initialized successfully with account:",
    JAZZ_ACCOUNT_ID,
  );

  return { worker };
}

export const { worker: jazz } = await startWorker();
