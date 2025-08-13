import { createWorkerAccount } from "jazz-run/createWorkerAccount";

const account = await createWorkerAccount({
  name: "jazz-test",
  peer: `wss://cloud.jazz.tools/?key=${process.env.JAZZ_API_KEY}`,
});

console.log("Account created:", account);
