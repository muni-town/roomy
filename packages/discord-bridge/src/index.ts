// WebSocket polyfill MUST be imported first (before Discordeno)
import "./discord/websocket-polyfill.js";
import "./httpProxy.js";
import "./otel.js";
import "dotenv/config";
// import { startRoomyWatcher } from "./roomy/from.js";
import { startApi } from "./api.js";
import { trace } from "@opentelemetry/api";
import { BridgeOrchestrator } from "./services/BridgeOrchestrator.js";

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

let bridgeOrchestrator;
try {
  bridgeOrchestrator = new BridgeOrchestrator();
} catch (e) {
  console.error("Failed to initialize bridge:", e);
  process.exit(1);
}

console.log("Starting HTTP API...");
startApi(bridgeOrchestrator);
