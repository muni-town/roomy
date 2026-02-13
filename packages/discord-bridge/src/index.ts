// WebSocket polyfill MUST be imported first (before Discordeno)
import "./discord/websocket-polyfill.js";
import "./httpProxy.js";
import "./otel.js";
import "dotenv/config";
// import { startRoomyWatcher } from "./roomy/from.js";
import { startApi } from "./api.js";
import { trace } from "@opentelemetry/api";
import { BridgeOrchestrator } from "./BridgeOrchestrator.js";
import { closeDB } from "./repositories/LevelDBBridgeRepository.js";

const tracer = trace.getTracer("index");

// Graceful shutdown
async function shutdown() {
  console.log("\n🛑 Shutting down gracefully...");
  await tracer.startActiveSpan("shutdown", async (span) => {
    // Close database first to avoid lock issues on restart
    await closeDB();
    span.end();
  });
  process.exit(0);
}

// Convert signal events to async shutdown
const handleShutdown = () => {
  shutdown().catch((error) => {
    console.error("Error during shutdown:", error);
    process.exit(1);
  });
};

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);

let bridgeOrchestrator;
try {
  bridgeOrchestrator = new BridgeOrchestrator();
} catch (e) {
  console.error("Failed to initialize bridge:", e);
  process.exit(1);
}

console.log("Starting HTTP API...");
startApi(bridgeOrchestrator);
