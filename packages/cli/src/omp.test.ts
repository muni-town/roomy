import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BoundedTail, createOmpEventSink, parseOmpJson, runOmp } from "./omp.js";

/**
 * Coverage for the responder surviving long omp runs.
 *
 * A run streams NDJSON events for its whole duration; accumulating them in the
 * stdout `data` handler and parsing at exit throws `RangeError: Invalid string
 * length` once the stream crosses V8's maximum string length — an uncaught
 * exception inside a stream callback, so it kills the responder process mid-job
 * rather than failing the one job. A dead responder breaks the pipeline's pipe,
 * and omp exits with its own `EPIPE: broken pipe, write` unhandled rejections.
 *
 * `runOmp` keeps raw stdout/stderr only as bounded tails (BoundedTail) for the
 * last-resort fallback reply and reduces the structured result event by event
 * (createOmpEventSink), so retained memory is O(largest single message),
 * independent of run length.
 */

const messageEnd = (text: string) =>
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

describe("BoundedTail", () => {
  test("retains only the most recent cap characters", () => {
    const tail = new BoundedTail(10);
    tail.append("abcde");
    tail.append("fghij");
    tail.append("klmno");
    expect(tail.text).toBe("fghijklmno");
    expect(tail.text.length).toBe(10);
  });

  test("a single chunk larger than the cap is trimmed to the cap", () => {
    const tail = new BoundedTail(4);
    tail.append("0123456789");
    expect(tail.text).toBe("6789");
  });

  test("an arbitrarily long stream never exceeds the cap", () => {
    const tail = new BoundedTail(1024);
    const chunk = "x".repeat(4096);
    for (let i = 0; i < 10_000; i++) tail.append(chunk);
    expect(tail.text.length).toBeLessThanOrEqual(1024);
  });
});

describe("createOmpEventSink", () => {
  test("reduces a stream to the same result parseOmpJson returns", () => {
    const raw = [
      '{"type":"session","id":"sess-1"}',
      '{"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta":"hm"}}',
      messageEnd("first"),
      messageEnd("final answer"),
      "",
    ].join("\n");
    const sink = createOmpEventSink();
    for (const line of raw.split("\n")) {
      if (line.trim()) sink.push(JSON.parse(line) as never);
    }
    expect(sink.result()).toEqual(parseOmpJson(raw));
    expect(sink.result().answer).toBe("final answer");
    expect(sink.result().sessionId).toBe("sess-1");
  });

  test("keeps only the last assistant message, like the whole-stream parser", () => {
    const raw = [messageEnd("first"), messageEnd("second")].join("\n");
    expect(parseOmpJson(raw).answer).toBe("second");
  });
});

/** Write an executable stub `omp` that emits NDJSON events then exits. */
function writeStubOmp(dir: string, eventCount: number): string {
  const stub = path.join(dir, "omp-stub");
  fs.writeFileSync(
    stub,
    `#!${process.execPath}
const n = ${eventCount};
process.stdout.write(JSON.stringify({ type: "session", id: "stub-session" }) + "\\n");
for (let i = 0; i < n; i++) {
  process.stdout.write(JSON.stringify({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "thinking chunk " + i + "\\n" },
  }) + "\\n");
}
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "stub answer" }] },
}) + "\\n");
`,
  );
  fs.chmodSync(stub, 0o755);
  return stub;
}

describe("runOmp", () => {
  test("a long stream does not crash and still yields the answer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "roomy-omp-"));
    const stub = writeStubOmp(dir, 200_000);
    // maxRawTail far below the stream size: the answer must come from the
    // event sink, not from the retained raw output.
    const reply = await runOmp("prompt", { ompBin: stub, cwd: dir, maxRawTail: 1024 });
    expect(reply.answer).toBe("stub answer");
    expect(reply.sessionId).toBe("stub-session");
  }, 60_000);
});
