import { createLogger } from "./logger.ts";
import { BRIDGE_DATA_DIR } from "./env.ts";
import { mkdir } from "node:fs/promises";

const log = createLogger("bridge");

async function main() {
  log.info("bridge starting");
  await mkdir(BRIDGE_DATA_DIR, { recursive: true });
  log.info(`data dir ready at ${BRIDGE_DATA_DIR}`);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    // future: close DB, disconnect gateway
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  log.info("bridge idle (no gateway listener wired up yet — see #111)");
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
