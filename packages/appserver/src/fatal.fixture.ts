/**
 * Child-process fixture for `fatal.test.ts`.
 *
 * Not a test file (the `.fixture.ts` suffix keeps `bun test` from collecting
 * it): the fatal handler's whole job is to terminate the process, so it can
 * only be exercised for real in a process that is allowed to die. The test
 * spawns this file with `FATAL_FIXTURE_KIND` set and asserts on the exit code
 * and the captured output.
 *
 * Kinds: `uncaught` | `rejection` | `rejection-non-error` | `metrics`.
 *
 * `metrics` is the boot probe: it stamps the boot, writes the `/metrics` body
 * to stdout, and exits before the control timer below can fire. Spawning it
 * twice gives two boots' scrapes to compare, which is how the boot timestamp's
 * per-process value is asserted — an in-process test cannot produce a second
 * boot to diff against.
 *
 * The trailing 500ms timer is the control: it prints only if the process is
 * still running after the event that must have killed it, so a handler that
 * swallowed the crash instead of exiting turns into a visible failing
 * assertion rather than a slow-passing test.
 */

import { installFatalHandlers, recordProcessStart } from "./fatal.ts";
import { metrics } from "./metrics.ts";

installFatalHandlers();
recordProcessStart();

switch (process.env.FATAL_FIXTURE_KIND) {
  case "uncaught":
    setTimeout(() => {
      throw new Error("fixture uncaught");
    }, 0);
    break;
  case "rejection":
    setTimeout(() => {
      void Promise.reject(new Error("fixture rejection"));
    }, 0);
    break;
  case "rejection-non-error":
    // Rejections are not required to be Errors — the record must still carry
    // the reason rather than `[object Object]`.
    setTimeout(() => {
      void Promise.reject({ code: 503, detail: "polar unavailable" });
    }, 0);
    break;
  case "metrics":
    // `render()` is exactly what the /metrics handler returns.
    process.stdout.write(metrics.render());
    process.exit(0);
    break;
  default:
    throw new Error(`unknown FATAL_FIXTURE_KIND: ${process.env.FATAL_FIXTURE_KIND}`);
}

setTimeout(() => {
  console.log("FIXTURE STILL ALIVE");
}, 500);
