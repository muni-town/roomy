import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { utf8ByteLength } from "@roomy-space/sdk";
import { decodeMessageText, type MessageInfo } from "./messages.js";

/** Result of running omp: the model's thinking trace and final answer. */
export interface OmpReply {
  thinking?: string;
  answer: string;
  /** omp session id for this run — new on the first turn, stable across resumes. */
  sessionId?: string;
}

export interface OmpOptions {
  /** Working directory for the omp agent. */
  cwd?: string;
  /** omp model override (fuzzy match). */
  model?: string;
  /** Extra context prepended to every prompt. */
  prefix?: string;
  /** Path to the omp binary. Defaults to `omp` on PATH. */
  ompBin?: string;
  /** Resume a prior omp session by id, giving this run conversation continuity. */
  resume?: string;
  /** Approx char threshold at which a streaming thinking chunk is flushed. Default 2000. */
  thinkingChunkSize?: number;
  /** Cap (UTF-16 units) on the raw stdout/stderr tail retained for the
   *  last-resort fallback reply. Defaults to 64 KiB. */
  maxRawTail?: number;
  /** Path to a file whose contents are appended to omp's system prompt on every
   *  run (unified workflow context for each new session). */
  systemPromptFile?: string;
}

/** Callbacks invoked while omp streams. */
export interface OmpCallbacks {
  /** Fired with a message-sized chunk of the thinking trace as it streams. */
  onThinking?: (chunk: string) => void | Promise<void>;
}

/**
 * A string buffer that never exceeds `cap` UTF-16 units: appending keeps only
 * the most recent `cap` characters, so an arbitrarily long stream cannot grow
 * the retained tail (or the process) without bound.
 */
export class BoundedTail {
  #text = "";
  constructor(readonly cap: number) {}
  append(chunk: string): void {
    if (chunk.length >= this.cap) {
      this.#text = chunk.slice(chunk.length - this.cap);
      return;
    }
    // Both operands are < cap, so the concatenation is < 2*cap before the trim.
    const combined = this.#text + chunk;
    this.#text =
      combined.length <= this.cap ? combined : combined.slice(combined.length - this.cap);
  }
  get text(): string {
    return this.#text;
  }
}

/** Incremental NDJSON accumulator: consume omp's events as they stream. */
export interface OmpEventSink {
  push(evt: OmpJsonEvent): void;
  result(): OmpReply;
}

/**
 * Reduce omp's NDJSON events to exactly what `parseOmpJson` returns for the
 * whole stream — the last assistant `message_end` content and the last session
 * id — without retaining the raw stream.
 *
 * A long-running job can emit far more stdout than V8's maximum string length.
 * An accumulator that crosses that limit throws `RangeError: Invalid string
 * length` from the stdout `data` handler — an uncaught exception in a stream
 * callback, so it kills the responder process mid-job rather than failing the
 * one job. Reducing per event makes retained memory O(largest single message),
 * independent of run length.
 */
export function createOmpEventSink(): OmpEventSink {
  let thinking: string | undefined;
  let answer = "";
  let sessionId: string | undefined;
  return {
    push(evt: OmpJsonEvent): void {
      if (evt.type === "session" && evt.id) sessionId = evt.id;
      if (evt.type === "message_end" && evt.message?.role === "assistant") {
        const thinkingParts: string[] = [];
        const answerParts: string[] = [];
        for (const block of evt.message.content ?? []) {
          if (block.type === "thinking") {
            if (block.thinking) thinkingParts.push(block.thinking);
          } else if (block.type === "text") {
            if (block.text) answerParts.push(block.text);
          }
        }
        thinking = thinkingParts.length ? thinkingParts.join("\n\n") : undefined;
        answer = answerParts.join("\n");
      }
    },
    result(): OmpReply {
      return { thinking, answer, sessionId };
    },
  };
}

/**
 * Run omp non-interactively (`omp -p`) in JSON mode and extract both the final
 * answer and the model's thinking trace.
 *
 * omp emits NDJSON events on stdout (one JSON object per line); the assistant
 * content is streamed as `text_delta`/`thinking_delta` updates and finalised in
 * `message_end`. We keep the last assistant `message_end` and read its content
 * blocks: `thinking` blocks carry the reasoning trace, `text` blocks the answer.
 *
 * When `opts.resume` is set we pass `--resume <id>` so the run continues an
 * existing omp session (conversation continuity); otherwise a fresh session is
 * created. Either way the run's session id is parsed from the `session` event
 * and returned so callers can persist it for later resumes.
 */
export function runOmp(
  prompt: string,
  opts: OmpOptions,
  callbacks?: OmpCallbacks,
): Promise<OmpReply> {
  const bin = opts.ompBin ?? "omp";
  const chunkSize = opts.thinkingChunkSize ?? 2000;
  const args = ["-p", prompt, "--cwd", opts.cwd ?? process.cwd(), "--mode=json", "--print-thoughts"];
  if (opts.model) args.push("--model", opts.model);
  if (opts.resume) args.push("--resume", opts.resume);
  if (opts.systemPromptFile) args.push("--append-system-prompt", opts.systemPromptFile);

  const { promise, resolve, reject } = Promise.withResolvers<OmpReply>();
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  // Only bounded tails of raw stdout/stderr are retained, for the last-resort
  // fallback reply; the structured result is reduced event by event through the
  // sink. See createOmpEventSink for why unbounded accumulation crashes here.
  const tailCap = opts.maxRawTail ?? 64 * 1024;
  const outTail = new BoundedTail(tailCap);
  const errTail = new BoundedTail(tailCap);
  const sink = createOmpEventSink();
  child.stdout.on("data", (d) => {
    outTail.append(d.toString());
  });
  child.stderr.on("data", (d) => {
    errTail.append(d.toString());
  });

  // Streaming state: buffer thinking deltas and flush them in message-sized
  // chunks via the onThinking callback as they arrive (omp streams these as
  // message_update events live over the pipe).
  let thinkingBuf = "";
  const flushThinking = () => {
    const chunk = thinkingBuf;
    thinkingBuf = "";
    if (chunk.trim()) callbacks?.onThinking?.(chunk);
  };

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let evt: OmpJsonEvent;
    try {
      evt = JSON.parse(line) as OmpJsonEvent;
    } catch {
      return;
    }
    sink.push(evt);
    if (evt.type === "message_update") {
      const u = evt.assistantMessageEvent;
      if (!u) return;
      if (u.type === "thinking_delta" && typeof u.delta === "string") {
        thinkingBuf += u.delta;
        if (utf8ByteLength(thinkingBuf) >= chunkSize) flushThinking();
      } else if (u.type === "thinking_end") {
        flushThinking();
      }
    }
  });

  child.on("error", (e) => reject(new Error(`Failed to spawn ${bin}: ${e.message}`)));
  child.on("close", (code) => {
    rl.close();
    if (code !== 0) {
      reject(new Error(`omp exited ${code}: ${errTail.text.slice(-500)}`));
      return;
    }
    const reply = sink.result();
    if (!reply.answer.trim()) {
      // Nothing in the structured output; fall back to the raw output tail (and
      // stderr tail) so the user isn't left with a silent failure.
      const fallback = (outTail.text.trim() || errTail.text.trim() || "").slice(-2000);
      resolve({ answer: fallback, sessionId: reply.sessionId });
      return;
    }
    resolve(reply);
  });
  return promise;
}

interface OmpJsonEvent {
  type?: string;
  id?: string;
  message?: {
    role?: string;
    content?: { type?: string; text?: string; thinking?: string }[];
  };
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
  };
}

/** Parse omp's NDJSON output into { thinking, answer, sessionId }. */
export function parseOmpJson(raw: string): OmpReply {
  const sink = createOmpEventSink();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let evt: OmpJsonEvent;
    try {
      evt = JSON.parse(line) as OmpJsonEvent;
    } catch {
      continue;
    }
    sink.push(evt);
  }
  return sink.result();
}

/** Build the prompt sent to omp from an incoming message. */
export function buildPrompt(
  msg: MessageInfo,
  roomId: string,
  agentDid: string,
  prefix?: string,
  context?: string,
  roomName?: string,
): string {
  const from = msg.authorName || msg.authorDid;
  const body = decodeMessageText(msg.content, msg.mimeType);
  const parts: string[] = [];
  if (prefix) parts.push(prefix);
  // Recent conversation context for the room, so the agent sees what has been
  // said (loaded when the agent is mentioned) rather than only the mention.
  if (context) parts.push(context);
  // Explicit room context: the room the agent was prompted in, by name when
  // resolvable, so the agent can fetch preceding messages if necessary.
  const room = roomName && roomName !== roomId ? `${roomName} (${roomId})` : roomId;
  parts.push(
    `[Message from ${from} in Roomy room ${room}]\n\n${body}`,
  );
  return parts.join("\n\n");
}
