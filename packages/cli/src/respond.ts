import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { transport, createThread, type Ulid } from "@roomy-space/sdk";
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

/** Room kinds that keep thinking traces in the room itself (threads). */
const IN_ROOM_TRACE_KINDS: Record<string, true> = {
  "space.roomy.thread": true,
};

/** URL prefix for linking a trace thread from the answer in the channel. */
const ROOMY_APP_URL = "https://roomy.space";

/**
 * One mention event as emitted by the roomy bridge (`roomy-bridge`, a
 * standalone repo) over stdout, one NDJSON line per event. The shape is the
 * bridge's contract; this module only consumes it.
 */
export interface MentionEvent {
  /** "mention" = the message carried a #didMention facet / @-text for the
   *  agent → NEW session. "reply" = depth-1 reply to a message the agent
   *  authored (stage-1 `kind` on #mention ops) → CONTINUATION of that
   *  conversation. */
  kind: "mention" | "reply";
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
    /** Target message id of a reply attachment, when the message is a reply. */
    replyTo?: string;
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
  /** How many recent messages in the room to fetch for the chain walk
   *  (conversation context + session root resolution). Default 100. 0
   *  disables room context (sessions then key on the triggering msg id). */
  recent?: number;
  /** Give each conversation chain its own omp session so replies resume it.
   *  Default true. */
  continuity?: boolean;
  /** Where to persist conversation-root → omp session id mappings.
   *  Defaults to ~/.roomy/omp-sessions.json. */
  sessionFile?: string;
  /** Post the agent's thinking trace alongside its answer. Default true. */
  thinking?: boolean;
  /** Stream the thinking trace to the room in message-sized chunks as it's
   *  produced (instead of bundling it with the final answer). Default true. */
  streamThinking?: boolean;
  /** Route thinking traces to a dedicated 💭 thread room when the triggering
   *  message landed in a channel (not a thread). Default true. */
  traceThreads?: boolean;
  /** Approx char threshold for each streamed thinking chunk. Default 2000. */
  thinkingChunkSize?: number;
  /** Path to a file whose contents are appended to omp's system prompt on every
   *  run (unified workflow context for each new session). */
  systemPromptFile?: string;
  /** Logger; defaults to stderr. */
  log?: (msg: string) => void;
}

interface ChainWalk {
  /** Conversation root id the session is keyed on (see walkChain). */
  rootId: string;
  /** Message the reply should be threaded under (the triggering message's
   *  reply target, or the triggering message itself). */
  parent: string;
  /** Chain-message context (oldest first, excluding the triggering message,
   *  the agent's own messages, and thinking traces). */
  context: string;
  /** Name of the room the agent was prompted in (best-effort). */
  roomName?: string;
}

/** A fetched message row (the server-side MessageDto surface we read). */
interface MessageDto {
  id: string;
  replyTo?: string;
  authorDid: string;
  authorName?: string;
  content: string;
  mimeType?: string;
}

interface StoredSession {
  sessionId: string;
  /** Id of the 💭 trace-thread room for channel-initiated sessions
   *  (undefined for thread-initiated sessions — traces stay in-room). */
  traceThreadId?: string;
}

/**
 * Read mention events from stdin (NDJSON, one line per event) and respond to
 * each: fetch room context, run omp, post the reply. Runs until stdin closes
 * (EOF), which terminates the pipe cleanly when the bridge exits.
 *
 * Session model (stages 2–4): a "mention" starts a new session keyed on the
 * conversation chain's root; a "reply" continues the chain's session. Thinking
 * traces for channel-initiated sessions stream into a dedicated 💭 thread room
 * (created per fresh session); thread-initiated sessions keep traces in-room.
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

  // Serialize omp runs per conversation chain so simultaneous events in the
  // same chain can't race on the same resumed omp session (each turn appends
  // to the session file in order). Room-level serialization is insufficient
  // once sessions are keyed per chain (a room holds many chains). The chain
  // key is resolved (walkChain) before enqueueing, so concurrent events on
  // the same chain always land on the same queue entry.
  const chainQueues = new Map<string, Promise<unknown>>();
  const enqueue = (chainKey: string, task: () => Promise<unknown>) => {
    const prev = chainQueues.get(chainKey) ?? Promise.resolve();
    const next = prev.then(task, task);
    // Log task failures instead of swallowing them: a rejected handler
    // previously vanished silently, making the agent quietly ignore mentions.
    chainQueues.set(chainKey, next.catch((e) => log(`[task error] ${e instanceof Error ? e.stack ?? e.message : String(e)}`)));
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
    if (evt.kind !== "mention" && evt.kind !== "reply") {
      log(`skipping unknown event kind: ${String(evt.kind)}`);
      return;
    }
    if (!evt.spaceId || !evt.roomId) {
      log(`skipping event without space/room: ${JSON.stringify(evt).slice(0, 120)}`);
      return;
    }
    if (evt.message.authorDid === agentDid && !opts.includeSelf) return;
    // Fire-and-forget into the per-chain queue (see enqueue above): the chain
    // root is resolved before the task runs, then serialized by chain key.
    void handleEvent(xrpc, agentDid, evt, opts, sessions, log, enqueue);
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
  enqueue: (chainKey: string, task: () => Promise<unknown>) => void,
): Promise<void> {
  const { spaceId, roomId, kind } = evt;
  const msg = evt.message;
  const message: MessageInfo = {
    id: msg.id,
    authorDid: msg.authorDid,
    authorName: msg.authorName,
    content: msg.content,
    timestamp: msg.timestamp,
    mimeType: msg.mimeType,
  };

  const recent = opts.recent ?? 100;
  const chain = await walkChain(xrpc, roomId, agentDid, msg.id, recent);
  const chainKey = `${spaceId}:${chain.rootId}`;

  enqueue(chainKey, async () => {
    const prompt = buildPrompt(message, roomId, agentDid, opts.prefix, chain.context, chain.roomName);
    const parent = chain.parent;
    const isContinuation = kind === "reply";
    const prior = isContinuation ? sessions?.get(chainKey) : undefined;
    const resume = prior?.sessionId;
    if (resume) log(`continuing omp session ${resume} (chain ${chain.rootId})`);
    else if (isContinuation) log(`reply with no stored session — starting fresh (chain ${chain.rootId})`);
    log(`${kind} from ${msg.authorName || msg.authorDid}: ${truncate(plaintextOf(message), 80)}`);

    try {
      // Trace placement: fresh mentions in channels get a dedicated 💭 thread
      // room; everything else (thread-room mentions, and all continuations)
      // streams traces into the conversation itself.
      let traceRoomId: string | undefined = prior?.traceThreadId;
      if (kind === "mention" && !traceRoomId && (opts.traceThreads ?? true)) {
        traceRoomId = (await ensureTraceThread(xrpc, spaceId, roomId, msg)) ?? undefined;
      }

      const streamThinking = opts.streamThinking ?? true;
      // Serialize streamed thinking-chunk posts so they land in order, and so
      // the final answer is posted only after every chunk has been sent.
      // Chunks posted to a trace room chain under the room's first chunk.
      let thinkingChain: Promise<unknown> = Promise.resolve();
      let streamedThinking = false;
      let lastTraceChunkId: string | undefined;
      const reply = await runOmp(prompt, { ...opts, resume }, {
        onThinking: (chunk) => {
          streamedThinking = true;
          // Each sendReply is chained onto thinkingChain, which is later
          // awaited at `await thinkingChain`. But onThinking fires
          // synchronously while runOmp is still streaming, so a rejected
          // sendReply (e.g. a transient 5xx) would leave this link with no
          // rejection handler in that window — an unhandled rejection that
          // crashed the responder and, via the broken pipe, killed the bridge.
          // Attach a handler immediately so rejections are handled here.
          thinkingChain = thinkingChain
            .then(async () => {
              if (traceRoomId) {
                const { messageId } = await sendReply(xrpc, spaceId, traceRoomId, chunk, buildThinkingBlocks(chunk), lastTraceChunkId);
                lastTraceChunkId = messageId;
              } else {
                await sendReply(xrpc, spaceId, roomId, chunk, buildThinkingBlocks(chunk), parent);
              }
            })
            .catch((e) => {
              log(`thinking-chunk post failed: ${e instanceof Error ? e.message : String(e)}`);
              return Promise.reject(e);
            });
        },
      });
      if (reply.sessionId) {
        sessions?.set(chainKey, { sessionId: reply.sessionId, traceThreadId: traceRoomId });
      }
      if (!reply || !reply.answer.trim()) {
        log("empty reply — not posting");
        return;
      }
      await thinkingChain;

      const traceLink = traceRoomId ? `\n\n---\n💭 trace: ${ROOMY_APP_URL}/${spaceId}/${traceRoomId}` : "";
      if (streamThinking && streamedThinking) {
        const { messageId } = await sendReply(xrpc, spaceId, roomId, `${reply.answer}${traceLink}`, undefined, parent);
        log(`replied ${messageId} (answer; thinking ${traceRoomId ? `in trace thread ${traceRoomId}` : "streamed in room"})`);
        return;
      }

      const thinking = reply.thinking?.trim();
      const postThinking = (opts.thinking ?? true) && !!thinking;
      if (postThinking && traceRoomId) {
        // Traces go to the trace room even when not streamed: post the trace
        // there and the clean answer (with a link) in the channel.
        await sendReply(xrpc, spaceId, traceRoomId, thinking, buildThinkingBlocks(thinking));
        const { messageId } = await sendReply(xrpc, spaceId, roomId, `${reply.answer}${traceLink}`, undefined, parent);
        log(`replied ${messageId} (answer; thinking in trace thread ${traceRoomId})`);
        return;
      }
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
    } catch (error) {
      log(`error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/**
 * Fetch a recent-message window in a room, walk the triggering message's
 * reply chain to its root, and build (a) the conversation root id the omp
 * session is keyed on, (b) the threading parent, and (c) a context string
 * limited to the chain's own messages (oldest first) — plus the room name,
 * so the prompt explicitly states where the agent was prompted in.
 *
 * Root resolution: walk `replyTo` upward through the fetched window. The
 * root is the first message with no replyTo inside the window, OR the first
 * replyTo target that falls outside the window (a stable boundary id —
 * every message in the same chain walks to the same boundary). This keeps
 * session keys deterministic with a single bounded fetch.
 */
async function walkChain(
  xrpc: DirectXrpcClient,
  roomId: string,
  agentDid: string,
  msgId: string,
  limit: number,
): Promise<ChainWalk> {
  if (limit <= 0) {
    return { rootId: msgId, parent: msgId, context: "" };
  }
  try {
    const res = await xrpc.query("space.roomy.room.getMessages", {
      roomId,
      limit: String(limit),
    });
    const byId = new Map<string, MessageDto>();
    for (const m of res.messages) byId.set(m.id, m);
    const meta = await xrpc.query("space.roomy.room.getMetadata", { roomId });

    // Walk the chain: triggering message → its replyTo → … → root.
    const chain: MessageDto[] = [];
    let cur: MessageDto | undefined = byId.get(msgId);
    let rootId = msgId;
    while (cur) {
      chain.push(cur);
      const nextId = cur.replyTo;
      if (!nextId) {
        rootId = cur.id; // true root (inside the window)
        break;
      }
      const next = byId.get(nextId);
      if (!next) {
        rootId = nextId; // stable boundary: target outside the window
        break;
      }
      cur = next;
    }

    // Chain-only context (oldest first), excluding the triggering message,
    // the agent's own replies (the resumed omp session carries those), and
    // thinking traces.
    const lines: string[] = [];
    for (const m of chain.slice(1).reverse()) {
      if (m.authorDid === agentDid) continue;
      const from = m.authorName ?? m.authorDid ?? "?";
      const content = plaintextOf(m);
      if (!content) continue;
      if (content.startsWith(THINKING_MARKER)) continue;
      lines.push(`[${from}]: ${content}`);
    }
    const context = lines.length
      ? `Conversation chain (oldest first):\n${lines.join("\n")}`
      : "";

    return {
      rootId,
      parent: chain[0]?.replyTo ?? msgId,
      context,
      roomName: typeof meta?.name === "string" ? meta.name : undefined,
    };
  } catch {
    return { rootId: msgId, parent: msgId, context: "" };
  }
}

/**
 * Create (and return the id of) a dedicated 💭 trace-thread room for a fresh
 * channel mention, linked under the channel the agent was prompted in.
 * Returns undefined when the room is a thread (traces stay in-room) or when
 * creation fails (fall back to in-room traces).
 */
async function ensureTraceThread(
  xrpc: DirectXrpcClient,
  spaceId: string,
  roomId: string,
  msg: MentionEvent["message"],
): Promise<string | undefined> {
  try {
    const meta = await xrpc.query("space.roomy.room.getMetadata", { roomId });
    if (IN_ROOM_TRACE_KINDS[meta.kind]) return undefined;

    const body = plaintextOf({ content: msg.content, mimeType: msg.mimeType });
    const words = body.replace(/\s+/g, " ").trim().slice(0, 40);
    const when = new Date(msg.timestamp).toISOString().slice(0, 16).replace("T", " ");
    const name = `💭 ${when}${words ? ` — ${words}` : ""}`;
    const events = createThread({ linkToRoom: roomId as Ulid, name });
    const threadId = events[0]!.id;
    await xrpc.procedure("space.roomy.space.sendEvents", { spaceId, events });
    return threadId;
  } catch (error) {
    try {
      // eslint-disable-next-line no-console
      console.error(`[respond] trace-thread create failed: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // logger unavailable — swallow
    }
    return undefined;
  }
}

/**
 * Persist a per-conversation-chain omp session id so repeated replies in the
 * same chain resume the same omp session (conversation continuity) across
 * events and across responder restarts. Keyed by `${spaceId}:${chainRootId}`.
 */
class SessionStore {
  #data = new Map<string, StoredSession>();
  #file?: string;

  constructor(file?: string) {
    this.#file = file;
    if (!file) return;
    try {
      const raw = fs.readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") {
          // Pre-chain-keying entries: room-keyed plain session ids. They no
          // longer match any chain key, so they are dropped (fresh sessions).
          continue;
        }
        const s = v as StoredSession;
        if (s && typeof s.sessionId === "string") {
          this.#data.set(k, { sessionId: s.sessionId, traceThreadId: s.traceThreadId });
        }
      }
    } catch {
      // missing or corrupt file → start empty
    }
  }

  get(chainKey: string): StoredSession | undefined {
    return this.#data.get(chainKey);
  }

  set(chainKey: string, session: StoredSession): void {
    this.#data.set(chainKey, session);
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
