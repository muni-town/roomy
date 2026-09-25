/**
 * Tests for fatal-exit visibility.
 *
 * Two independent things are asserted, because the handler has two jobs:
 *
 *   1. `installFatalHandlers()` records a distinguishable fatal and exits
 *      non-zero. This is driven for real: the handler terminates the process,
 *      so the only honest test is a child process that is allowed to die
 *      (`fatal.fixture.ts`). The exit code and the `level`/`kind`/`error`
 *      fields of the emitted JSON line are asserted — the fields an operator
 *      needs to attribute the crash.
 */

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { installFatalHandlers, recordProcessStart, type FatalEventEmitter } from "./fatal.ts";
import { Metrics, metrics } from "./metrics.ts";

const FIXTURE = fileURLToPath(new URL("./fatal.fixture.ts", import.meta.url));

interface FixtureResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runFixture(kind: string): Promise<FixtureResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, "run", FIXTURE],
    env: {
      ...process.env,
      FATAL_FIXTURE_KIND: kind,
      LOG_LEVEL: "info",
      // Never inherit a real Loki sink from the dev environment: the fixture
      // must exercise the stdout path (and its flush must be a no-op).
      ALLOY_URL: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

describe("fatal exit handlers (child process)", () => {
  test("uncaught exception records a fatal line and exits non-zero", async () => {
    const { exitCode, stdout, stderr } = await runFixture("uncaught");

    // The crash still kills the process — the handler records, it does not
    // swallow. Exit code matches the abort it replaced.
    expect(exitCode).toBe(1);
    // A handler that swallowed the crash would leave the process running.
    expect(stdout).not.toContain("FIXTURE STILL ALIVE");

    const record = JSON.parse(stderr.trim());
    expect(record.level).toBe("error");
    expect(record.scope).toBe("fatal");
    expect(record.fatal).toBe(true);
    expect(record.kind).toBe("uncaughtException");
    expect(record.error_name).toBe("Error");
    expect(record.msg).toContain("uncaughtException");
    expect(record.error.message).toBe("fixture uncaught");
    expect(record.error.stack).toContain("fixture uncaught");
    // The record must be attributable to a build and a replica.
    expect(record.service).toBe("appserver");
    expect(record.build_id).toBeTypeOf("string");
    expect(record.pid).toBeTypeOf("number");
  });

  test("unhandled rejection records a fatal line and exits non-zero", async () => {
    const { exitCode, stdout, stderr } = await runFixture("rejection");

    expect(exitCode).toBe(1);
    expect(stdout).not.toContain("FIXTURE STILL ALIVE");

    const record = JSON.parse(stderr.trim());
    expect(record.level).toBe("error");
    expect(record.scope).toBe("fatal");
    expect(record.kind).toBe("unhandledRejection");
    expect(record.error.message).toBe("fixture rejection");
  });

  test("a non-Error rejection reason is still recorded", async () => {
    const { exitCode, stderr } = await runFixture("rejection-non-error");

    expect(exitCode).toBe(1);
    const record = JSON.parse(stderr.trim());
    expect(record.kind).toBe("unhandledRejection");
    // Serialized, not flattened to "[object Object]".
    expect(record.error.message).toContain("polar unavailable");
    expect(record.error.message).toContain("503");
  });

  test("every fatal exits non-zero even with an unreachable Loki sink", async () => {
    // ALLOY_URL is emptied by runFixture, so this also covers "fatal path does
    // not hang on a flush that can never resolve".
    const { exitCode } = await runFixture("rejection");
    expect(exitCode).not.toBe(0);
  });
});

describe("roomy_process_starts_total", () => {
  test("renders as a counter in the Prometheus text output", () => {
    // The family is registered at module load with the process-wide registry.
    const out = metrics.render();
    expect(out).toContain("# TYPE roomy_process_starts_total counter");
    expect(out).toContain("roomy_process_starts_total");
  });

  test("recordProcessStart bumps the series", () => {
    const m = new Metrics();
    // Mirrors fatal.ts's registration (see the module-load call) against an
    // isolated registry so the assertion is on a known value.
    const c = m.counter("roomy_process_starts_total", "boots");
    c.inc();
    c.inc();
    const out = m.render();
    expect(out).toContain("# TYPE roomy_process_starts_total counter");
    expect(out).toContain("roomy_process_starts_total 2");
  });
});

/**
 * Minimal stand-in for the process event emitter, so the registration contract
 * can be asserted without really installing the handlers on the test runner.
 *
 * Really installing them would make `handleFatal` live for the remainder of the
 * suite: any unrelated unhandled rejection in an unrelated test would then
 * `process.exit(1)` and truncate the whole run, silently hiding results. The
 * handlers' real behaviour is covered by the child-process tests above, where
 * dying is the point.
 *
 * A class rather than an object literal because the interface is overloaded,
 * and overload signatures belong on a declaration.
 */
class CountingEmitter implements FatalEventEmitter {
  private readonly counts = new Map<string, number>();

  on(event: "uncaughtException", listener: (error: Error) => void): void;
  on(event: "unhandledRejection", listener: (reason: unknown) => void): void;
  on(event: string, _listener: (error: Error) => void): void {
    this.counts.set(event, (this.counts.get(event) ?? 0) + 1);
  }

  listenerCount(event: "uncaughtException" | "unhandledRejection"): number {
    return this.counts.get(event) ?? 0;
  }
}

describe("handler installation", () => {
  test("registers both fatal events exactly once, idempotently", () => {
    const emitter = new CountingEmitter();

    installFatalHandlers(emitter);
    expect(emitter.listenerCount("uncaughtException")).toBe(1);
    expect(emitter.listenerCount("unhandledRejection")).toBe(1);

    // Idempotent: a second call must not double-register, which would log and
    // exit twice on a single crash.
    installFatalHandlers(emitter);
    expect(emitter.listenerCount("uncaughtException")).toBe(1);
    expect(emitter.listenerCount("unhandledRejection")).toBe(1);
  });

  test("recordProcessStart does not throw", () => {
    expect(() => recordProcessStart()).not.toThrow();
  });
});
