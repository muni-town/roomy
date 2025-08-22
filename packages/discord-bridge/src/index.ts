import "./httpProxy.js";
import "./otel.js";
import "dotenv/config";
import { startBot } from "./discordBot.js";
import { startRoomyWatcher } from "./roomy.js";
import { startApi } from "./api.js";
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

console.log("Connecting to Discord...");
const discordBot = await startBot();

console.log("Starting Roomy Syncer");
startRoomyWatcher(discordBot);
