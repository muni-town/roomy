import "./httpProxy.js";
import "./otel.js";
import "dotenv/config";
import { startBot } from "./discord/bot.js";
// import { startRoomyWatcher } from "./roomy/from.js";
import { startApi } from "./api.js";
import {
  initRoomyClient,
  subscribeToConnectedSpaces,
} from "./roomy/client.js";
import { trace } from "@opentelemetry/api";

const tracer = trace.getTracer("index");

// Graceful shutdown
function shutdown() {
  tracer.startActiveSpan("shutdown", (span) => {
    span.end();
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log("Starting HTTP API...");
startApi();

console.log("Connecting to Roomy...");
let roomyClient: Awaited<ReturnType<typeof initRoomyClient>>;
try {
  roomyClient = await initRoomyClient();
} catch (e) {
  console.error("Failed to initialize Roomy client:", e);
  if ((e as Error).message?.includes("Stream does not exist")) {
    console.error(
      "\nThe personal stream record exists on PDS but the stream doesn't exist on the Leaf server.\n" +
        "This may happen after a Leaf server reset or data migration.\n" +
        "To fix, you may need to manually delete the stale PDS record:\n" +
        "  1. Find the record at: space.roomy.space.personal (rkey = schema version)\n" +
        "  2. Delete it via your PDS or ATPROTO tools\n" +
        "  3. Restart the bridge to create a new stream\n",
    );
  }
  process.exit(1);
}

console.log("Subscribing to connected spaces...");
try {
  await subscribeToConnectedSpaces();
} catch (e) {
  console.error("Failed to subscribe to connected spaces:", e);
  // Continue anyway - some spaces may have failed but we can still run the bot
}

console.log("Connecting to Discord...");
const discordBot = await startBot();

console.log("Discord bridge ready");
