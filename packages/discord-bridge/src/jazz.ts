import { Account, co, z } from "jazz-tools";
import { startWorker as startJazzWorker } from "jazz-tools/worker";
import { JAZZ_ACCOUNT_ID, JAZZ_ACCOUNT_SECRET, JAZZ_EMAIL } from "./env";

export const WorkerProfile = co.profile({
  name: z.string(),
  imageUrl: z.string().optional(),
  description: z.string().optional(),
});

export const WorkerAccountSchema = co.account({
  profile: WorkerProfile,
  root: co.map({}),
});

export async function startWorker(): Promise<{
  worker: Account;
}> {
  const syncServer = `ws://127.0.0.1:4200/?key=${JAZZ_EMAIL}`;

  const { worker } = await startJazzWorker({
    AccountSchema: WorkerAccountSchema,
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
