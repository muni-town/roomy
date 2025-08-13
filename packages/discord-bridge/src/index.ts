import "./httpProxy";
import "./otel";
import "dotenv/config";
import { startBot } from "./discordBot";
import { startApi } from "./api";
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
await startBot();
