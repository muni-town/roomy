import { Account, co, z } from "jazz-tools";
import { startWorker as startJazzWorker } from "jazz-tools/worker";
import { JAZZ_ACCOUNT_ID, JAZZ_ACCOUNT_SECRET, JAZZ_EMAIL } from "./env";

export const WorkerProfile = co.profile({
  name: z.string(),
  imageUrl: z.string().optional(),
  description: z.string().optional(),

  // requests: DiscordBridgeRequestList,
});

export const WorkerAccountSchema = co.account({
  profile: WorkerProfile,
  root: co.map({}),
});

export async function startWorker(): Promise<{
  worker: Account;
}> {
  const syncServer = `wss://cloud.jazz.tools/?key=${JAZZ_EMAIL}`;

  const { worker } = await startJazzWorker({
    AccountSchema: WorkerAccountSchema,
    accountID: JAZZ_ACCOUNT_ID,
    accountSecret: JAZZ_ACCOUNT_SECRET,
    syncServer,
  });

  // // load profile as WorkerProfile
  // const profile = await WorkerProfile.load(worker.profile.id, {
  //   loadAs: worker,
  //   resolve: {
  //     requests: {
  //       $each: true,
  //       $onError: null,
  //     },
  //   },
  // });

  // if (!profile?.requests) {
  //   if (!profile) throw new Error("Profile does not exist.");

  //   // create requests lists
  //   console.log("Creating requests lists...");
  //   profile.requests = createRequestsList(worker);
  // } else {
  //   console.log("Requests lists already exist");
  // }

  console.log(
    "Jazz worker initialized successfully with account:",
    JAZZ_ACCOUNT_ID,
  );

  return { worker };
}

export const { worker: jazz } = await startWorker();
