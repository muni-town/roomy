import { createWorkerAccount } from "jazz-run/createWorkerAccount";

const account = await createWorkerAccount({
  name: "jazz-test",
  peer: `ws://127.0.0.1:4200/?key=${process.env.JAZZ_API_KEY}`,
});

console.log("Account created:", account);
