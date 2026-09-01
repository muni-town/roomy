import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { transport } from "@roomy-space/sdk";
import { buildPrompt, runOmp, type OmpOptions } from "./omp.js";
import {
  THINKING_MARKER,
  buildReplyBlocks,
  buildThinkingBlocks,
  plaintextOf,
  sendReply,
  type MessageInfo,
} from "./messages.js";

type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;

/**
 * One mention event as emitted by the roomy bridge (`roomy-bridge`, a
 * standalone repo) over stdout, one NDJSON line per event. The shape is the
 * bridge's contract; this module only consumes it.
 */
export interface MentionEvent {
  kind: "mention";
  spaceId: string;
  roomId: string;
  message: {
    id: string;
    roomId: string;
    authorDid: string;
    authorName: string;
    content: string;
    mimeType?: string;
    timestamp: string;
  };
  explicit?: boolean;
}

export interface RespondOptions extends Omit<OmpOptions, "resume"> {
  /** Only respond when the agent is mentioned/tagged. Default true. */
  mentionOnly?: boolean;
  /** omp model override (fuzzy match). */
  model?: string;
  /** Extra context prepended to every prompt. */
  prefix?: string;
  /** Also respond to the agent's own messages (testing). Default false. */
  includeSelf?: boolean;
  /** How many recent messages in the room to load into the prompt when the
   *  agent is mentioned (conversation context). Default 20. 0 disables. */
  recent?: number;
  /** Give each room its own omp session so repeated mentions keep context. Default true. */
  continuity?: boolean;
  /** Where to persist room → omp session id mappings. Defaults to ~/.roomy/omp-sessions.json. */
  sessionFile?: string;
  /** Post the agent's thinking trace alongside its answer. Default true. */
  thinking?: boolean;
  /** Stream the thinking trace to the room in message-sized chunks as it's
   *  produced (instead of bundling it with the final answer). Default true. */
  streamThinking?: boolean;
  /** Approx char threshold for each streamed thinking chunk. Default 2000. */
  thinkingChunkSize?: number;
  /** Path to a file whose contents are appended to omp's system prompt on every
   *  run (unified workflow context for each new session). */
  systemPromptFile?: string;
  /** Logger; defaults to stderr. */
  log?: (msg: string) => void;
}

/**
 * Read mention events from stdin (NDJSON, one line per event) and respond to
 * each: fetch room context, run omp, post the reply. Runs until stdin closes
 * (EOF), which terminates the pipe cleanly when the bridge exits.
 */
export async function respond(
  xrpc: DirectXrpcClient,
  agent: { did?: string },
  opts: RespondOptions,
): Promise<void> {
  const log = opts.log ?? ((m: string) => console.error(`[respond] ${m}`));
  if (process.stdin.isTTY) {
    throw new Error("No input provided. Pipe roomy-bridge output into me: roomy-bridge | roomy-cli respond");
  }
  const agentDid = agent.did ?? "";
  const continuity = opts.continuity ?? true;
  const sessionFile = opts.sessionFile ?? path.join(os.homedir(), ".roomy", "omp-sessions.json");
  const sessions = continuity ? new SessionStore(sessionFile) : undefined;

  // Serialize omp runs per room so a burst of mentions can't race on the same
  // resumed omp session (each turn appends to the session file in order).
  const roomQueues = new Map<string, Promise<unknown>>();
  const enqueue = (roomId: string, task: () => Promise<unknown>) => {
    const prev = roomQueues.get(roomId) ?? Promise.resolve();
    const next = prev.then(task, task);
    // Log task failures instead of swallowing them: a rejected handler
    // previously vanished silently, making the agent quietly ignore mentions.
    roomQueues.set(roomId, next.catch((e) => log(`[task error] ${e instanceof Error ? e.stack ?? e.message : String(e)}`)));
  };

  const rl = createInterface({ input: process.stdin });
  const { promise, resolve } = Promise.withResolvers<void>();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let evt: MentionEvent;
    try {
      evt = JSON.parse(line) as MentionEvent;
    } catch {
      log(`skipping malformed event line: ${line.slice(0, 120)}`);
      return;
    }
    if (evt.kind !== "mention" || !evt.spaceId || !evt.roomId) {
      log(`skipping unknown event: ${evt.kind}`);
      return;
    }
    if (evt.message.authorDid === agentDid && !opts.includeSelf) return;
    enqueue(evt.roomId, () => handleEvent(xrpc, agentDid, evt, opts, sessions, log));
  });
  rl.on("close", resolve);
  await promise;
}

async function handleEvent(
  xrpc: DirectXrpcClient,
  agentDid: string,
  evt: MentionEvent,
  opts: RespondOptions,
  sessions: SessionStore | undefined,
  log: (m: string) => void,
): Promise<void> {
  const { spaceId, roomId } = evt;
  const msg = evt.message;
  const message: MessageInfo = {
    id: msg.id,
    authorDid: msg.authorDid,
    authorName: msg.authorName,
    content: msg.content,
    timestamp: msg.timestamp,
    mimeType: msg.mimeType,
  };

  const recent = opts.recent ?? 20;
  const ctx = await fetchRecentContext(xrpc, roomId, agentDid, msg.id, recent);
  const prompt = buildPrompt(message, roomId, agentDid, opts.prefix, ctx.context);
  const parent = ctx.parent ?? msg.id;
  const resume = sessions?.get(spaceId, roomId);
  if (resume) log(`continuing omp session ${resume}`);
  log(`mention from ${msg.authorName || msg.authorDid}: ${truncate(plaintextOf(message), 80)}`);

  try {
    const streamThinking = opts.streamThinking ?? true;
    // Serialize streamed thinking-chunk posts so they land in order, and so the
    // final answer is posted only after every chunk has been sent.
    let thinkingChain: Promise<unknown> = Promise.resolve();
    let streamedThinking = false;
    const reply = await runOmp(prompt, { ...opts, resume }, {
      onThinking: (chunk) => {
        streamedThinking = true;
        thinkingChain = thinkingChain.then(() =>
          sendReply(xrpc, spaceId, roomId, chunk, buildThinkingBlocks(chunk), parent),
        );
      },
    });
    if (reply.sessionId) sessions?.set(spaceId, roomId, reply.sessionId);
    if (!reply || !reply.answer.trim()) {
      log("empty reply — not posting");
      return;
    }
    await thinkingChain;
    if (streamThinking && streamedThinking) {
      // Thinking was already streamed to the room as messages; post the answer.
      const { messageId } = await sendReply(xrpc, spaceId, roomId, reply.answer, undefined, parent);
      log(`replied ${messageId} (answer; thinking streamed)`);
    } else {
      const thinking = reply.thinking?.trim();
      const postThinking = (opts.thinking ?? true) && !!thinking;
      const blocks = buildReplyBlocks(reply.answer, postThinking ? thinking : undefined);
      const { messageId } = await sendReply(
        xrpc,
        spaceId,
        roomId,
        reply.answer,
        blocks.length > 0 ? blocks : undefined,
        parent,
      );
      log(`replied ${messageId}${postThinking ? " (with thinking)" : ""}`);
    }
  } catch (error) {
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Fetch recent messages in a room, build a compact conversation-context string
 * (oldest-first, excluding the agent's own replies and the triggering message),
 * and surface the thread parent of the triggering message so the reply can be
 * threaded into the same conversation.
 */
async function fetchRecentContext(
  xrpc: DirectXrpcClient,
  roomId: string,
  agentDid: string,
  msgId: string,
  limit: number,
): Promise<{ context: string; parent?: string }> {
  if (limit <= 0) return { context: "" };
  try {
    const res = await xrpc.query("space.roomy.room.getMessages", {
      roomId,
      limit: String(limit),
    });
    const lines: string[] = [];
    let parent: string | undefined;
    const recent = res.messages;
    for (const m of recent) {
      if (m.id === msgId) {
        parent = m.replyTo ?? parent;
        continue;
      }
      if (m.authorDid === agentDid) continue; // skip our own replies
      const from = m.authorName ?? m.authorDid ?? "?";
      const content = plaintextOf(m);
      if (!content) continue;
      // Skip thinking-trace messages (marked with 💭) — high noise, low signal;
      // they pollute the context and aren't part of the real conversation.
      if (content.startsWith(THINKING_MARKER)) continue;
      lines.push(`[${from}]: ${content}`);
    }
    const context = lines.length
      ? `Recent conversation in this room (oldest first):\n${lines.reverse().join("\n")}`
      : "";
    return { context, parent };
  } catch {
    return { context: "", parent: undefined };
  }
}

/**
 * Persist a per-room omp session id so repeated mentions in the same room
 * resume the same omp session (conversation continuity) across mentions and
 * across responder restarts. Keyed by `${spaceId}:${roomId}`.
 */
class SessionStore {
  #data = new Map<string, string>();
  #file?: string;

  constructor(file?: string) {
    this.#file = file;
    if (!file) return;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) this.#data.set(k, v);
    } catch {
      // missing or corrupt file → start empty
    }
  }

  get(spaceId: string, roomId: string): string | undefined {
    return this.#data.get(`${spaceId}:${roomId}`);
  }

  set(spaceId: string, roomId: string, sessionId: string): void {
    this.#data.set(`${spaceId}:${roomId}`, sessionId);
    if (!this.#file) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(
        this.#file,
        JSON.stringify(Object.fromEntries(this.#data), null, 2),
      );
    } catch {
      // persistence is best-effort
    }
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
