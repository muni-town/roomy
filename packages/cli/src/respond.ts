import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { transport, createThread, type Ulid } from "@roomy-space/sdk";
import { buildPrompt, runOmp, type OmpOptions, type OmpReply } from "./omp.js";
import {
  THINKING_MARKER,
  buildReplyBlocks,
  buildThinkingBlocks,
  plaintextOf,
  readMessages,
  sendReply,
  type MessageInfo,
} from "./messages.js";
import { FileLock, QueueStore, bootHeal, type QueueJob } from "./queue.js";
import { PostChain, errorText } from "./postChain.js";

type DirectXrpcClient = InstanceType<typeof transport.DirectXrpcClient>;

/** Room kinds that keep thinking traces in the room itself (threads). */
const IN_ROOM_TRACE_KINDS: Record<string, true> = {
  "space.roomy.thread": true,
};

/** URL prefix for linking a trace thread from the answer in the channel. */
const ROOMY_APP_URL = "https://roomy.space";

/**
 * Marks a posted notice that the agent's turn FAILED, so it is not mistaken for
 * an answer. Without this the two are indistinguishable in the room: an agent
 * whose model provider refused the turn would simply say nothing, which reads
 * exactly like "nothing to report" (TASK-88's class).
 */
const FAILURE_MARKER = "⚠️";

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
  /** Path to the durable job queue file. Defaults to ~/.roomy/queue.json. */
  queueFile?: string;
  /** Path to the lock file guarding queue processing. Defaults to
   *  `<queueFile>.lock`. */
  lockFile?: string;
  /** How long a lock may go without a heartbeat before it is considered
   *  stale and taken over (ms). Default 120000. */
  lockTtlMs?: number;
  /** How often the drain timer polls the queue for work left by other
   *  processes, including a stranded `active` job behind a stale lock (ms).
   *  Default 5000. Test-only overridable seam; production uses 5s. */
  drainIntervalMs?: number;
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
 *
 * Concurrency: every event is appended to a durable queue file and processed
 * by a single global worker loop, one job at a time, under a file-based lock.
 * Two responder processes on the same machine (duplicate bridge pipelines)
 * therefore cannot run omp concurrently, and a future cron job can append to
 * the same queue (state visible on disk) instead of racing the responder.
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

  const queueFile = opts.queueFile ?? path.join(os.homedir(), ".roomy", "queue.json");
  const lockFile = opts.lockFile ?? `${queueFile}.lock`;
  const queue = new QueueStore(queueFile);
  const lock = new FileLock(lockFile, opts.lockTtlMs);

  // Lock holder identity is the PROCESS, not the agent DID: duplicate bridge
  // pipelines on one machine run under the SAME account and must still
  // exclude each other. Restarts get a new pid (and the stale-takeover after
  // the heartbeat TTL reclaims a dead holder's lock).
  const holder = `${os.hostname()}:${process.pid}`;
  const pid = process.pid;
  const heartbeat = () => { lock.heartbeat(holder, pid); };
  /**
   * Acquire the processing lock, healing the queue on takeover: if a
   * previous process died mid-job (stale lock / absent lock), its `active`
   * job goes back to the queue head so it is retried exactly once.
   * `requeueStaleActive` is a no-op when no job is stuck active, so the heal
   * is safe to run on every acquisition.
   */
  const acquire = (): boolean => {
    const info = lock.info();
    if (info && info.holder !== holder) {
      if (!info.stale) {
        log(`another responder holds the lock (${info.holder}) — waiting for it to release`);
        return false;
      }
      // Foreign but stale (holder died): take over and heal its orphaned
      // `active` job back to the queue head so it is retried exactly once.
      lock.tryAcquire(holder, pid);
      queue.requeueStaleActive(true);
      return true;
    }
    // Free, or our own lock (re-entrant) — (re)acquire refreshes the
    // heartbeat. The heal is a no-op when nothing is stuck active.
    lock.tryAcquire(holder, pid);
    queue.requeueStaleActive(true);
    return true;
  };
  // Startup heal, then RELEASE. The pump takes the lock per job and releases
  // it after each, so mutual exclusion between duplicate pipelines is
  // unchanged; holding it while idle would make lock freshness (the "job in
  // flight" signal for self-check.sh, `cli queue status`, and the cron
  // only-if-idle contract) read as permanently busy. See bootHeal.
  const heldOnBoot = bootHeal(queue, lock, holder, pid);
  if (heldOnBoot) {
    log(`another responder holds the lock (${heldOnBoot.holder}) — waiting for it to release`);
  }

  // Drain the queue: claim the head job under the lock, run it to
  // completion (or failure), release, and continue — one job at a time.
  //
  // `pump()` is invoked fire-and-forget (`void pump()`) from the stdin
  // handler and the drain timer, so it MUST never reject: an error escaping
  // the loop (e.g. a lock/queue file write failure: EACCES, ENOSPC) would be
  // an unhandled rejection that kills the responder and, through the broken
  // pipe, the whole bridge pipeline. Per-job errors are already contained
  // below; this outer catch contains everything else.
  let running = false;
  const pump = async () => {
    if (running) return;
    running = true;
    try {
      for (;;) {
        if (!acquire()) break;
        const job = queue.peek();
        if (!job) break;
        const active = queue.claim(job.id);
        if (!active) continue;
        log(`run job ${active.id} (${active.kind}, ${queue.status().enqueued.length} queued)`);
        try {
          if (active.kind === "mention") {
            await runMentionJob(xrpc, agentDid, active, opts, sessions, log);
          } else {
            await runCronJob(xrpc, active, log);
          }
          queue.finish(active.id, "done");
        } catch (error) {
          const message = error instanceof Error ? error.stack ?? error.message : String(error);
          log(`job ${active.id} failed: ${message}`);
          try {
            queue.finish(active.id, "failed", message);
          } catch (finishError) {
            log(`could not record job ${active.id} failure: ${errorText(finishError)}`);
          }
        }
        heartbeat();
        lock.release(holder);
      }
    } catch (error) {
      // Never let the pump reject into a `void pump()` call site.
      log(`queue pump error: ${errorText(error)}`);
    } finally {
      lock.release(holder);
      running = false;
    }
  };
  const heartbeatTimer = setInterval(heartbeat, Math.floor((opts.lockTtlMs ?? 120_000) / 3));
  heartbeatTimer.unref();
  // Drain work enqueued by other processes (cron `queue push`): without
  // this, a job pushed while the responder is idle would sit until the next
  // stdin event. 5s poll keeps lock churn negligible (peek is one tiny read).
  //
  // A job stranded in `active` by a dead holder is not in `enqueued`, so the
  // `enqueued > 0` check alone would never trigger a pump here — and if the
  // holder died while its lock was still within TTL (the lock has not yet gone
  // stale), the boot heal is also a no-op. The orphan would then sit forever
  // with no external stdin event to reclaim it. Extend the predicate to pump
  // whenever a foreign-dead holder's `active` job remains outstanding; the
  // pump's `acquire()` then takes over the stale lock and `requeueStaleActive`
  // heals the job back to the queue head. `lock.info()` is one tiny read, so
  // the extra check keeps the 5s poll's lock churn negligible.
  const drainIntervalMs = opts.drainIntervalMs ?? 5_000;
  const drainTimer = setInterval(() => {
    const state = queue.status();
    if (state.enqueued.length > 0) {
      void pump();
      return;
    }
    const lockInfo = lock.info();
    if (state.active && lockInfo && lockInfo.stale) void pump();
  }, drainIntervalMs);
  drainTimer.unref();

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
    // Self-authored events are only emitted by the bridge with --include-self,
    // and only for an explicit #didMention facet of the agent (the bridge's
    // isTrigger guard), so the agent's own reports cannot re-trigger it. This
    // filter is the second gate for a responder running without that flag.
    if (evt.message.authorDid === agentDid && !opts.includeSelf) return;
    // Persist the event as a job, then let the pump process it in FIFO order.
    queue.enqueue("mention", { kind: "mention", evt });
    void pump();
  });
  rl.on("close", resolve);
  await promise;
  clearInterval(heartbeatTimer);
  clearInterval(drainTimer);
  lock.release(holder);
}

/**
 * One queued mention/reply job: run omp and post the reply exactly like the
 * pre-queue responder. The job was enqueued before the chain walk, so the
 * walk happens here (under the running-job window) — fine, it just extends
 * the job duration slightly.
 */
async function runMentionJob(
  xrpc: DirectXrpcClient,
  agentDid: string,
  job: QueueJob,
  opts: RespondOptions,
  sessions: SessionStore | undefined,
  log: (m: string) => void,
): Promise<void> {
  if (job.payload.kind !== "mention") return;
  const evt = job.payload.evt;
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
  const prompt = buildPrompt(message, roomId, agentDid, opts.prefix, chain.context, chain.roomName);
  const parent = chain.parent;
  const isContinuation = kind === "reply";
  const prior = isContinuation ? sessions?.get(chainKey) : undefined;
  const resume = prior?.sessionId;
  if (resume) log(`continuing omp session ${resume} (chain ${chain.rootId})`);
  else if (isContinuation) log(`reply with no stored session — starting fresh (chain ${chain.rootId})`);
  log(`${kind} from ${msg.authorName || msg.authorDid}: ${truncate(plaintextOf(message), 80)}`);

  // Trace placement: a session in a CHANNEL gets a dedicated 💭 thread room and
  // streams its thinking there; a session already in a thread room keeps its
  // traces in that room. `ensureTraceThread` returns undefined for thread rooms,
  // so the same call handles both.
  //
  // Continuations need this as much as fresh mentions do. A chain whose root was
  // a self-triggered tick has no stored 💭 room — self-triggers persist no
  // session (so `prior.traceThreadId` is absent) — and a reply to it would
  // otherwise stream its thinking straight into the channel, which is exactly
  // the clutter a trace thread exists to prevent.
  //
  // Self-triggered sessions (the scheduled self-check posts a facet mention of
  // the agent itself) are exempt entirely: they fire on a timer, so a 💭 room
  // and streamed thinking chunks per tick would be pure clutter for an
  // unattended check. Their answer is the whole deliverable.
  const selfTriggered = msg.authorDid === agentDid;
  let traceRoomId: string | undefined = selfTriggered ? undefined : prior?.traceThreadId;
  if (!selfTriggered && !traceRoomId && (opts.traceThreads ?? true)) {
    traceRoomId = (await ensureTraceThread(xrpc, spaceId, roomId, msg)) ?? undefined;
  }

  const streamThinking = !selfTriggered && (opts.streamThinking ?? true);
  // Serialize streamed thinking-chunk posts so they land in order, and so
  // the final answer is posted only after every chunk has been sent.
  // PostChain contains per-chunk failures (logged + counted, chain carries
  // on) rather than leaving a rejected link unhandled — see postChain.ts.
  // Chunks posted to a trace room chain under the room's first chunk.
  const thinkingPosts = new PostChain((m) => log(`thinking-chunk ${m}`));
  let streamedThinking = false;
  let lastTraceChunkId: string | undefined;
  let reply: OmpReply;
  try {
    reply = await runOmp(prompt, { ...opts, resume }, {
      onThinking: (chunk) => {
        // Self-triggered ticks post no thinking at all: dropping the callback
        // here (not just the flags below) is what prevents the chunks, since
        // omp streams them regardless of the streamThinking/postThinking flags.
        if (selfTriggered) return;
        streamedThinking = true;
        thinkingPosts.push(async () => {
          if (traceRoomId) {
            const { messageId } = await sendReply(xrpc, spaceId, traceRoomId, chunk, buildThinkingBlocks(chunk), lastTraceChunkId);
            lastTraceChunkId = messageId;
          } else {
            await sendReply(xrpc, spaceId, roomId, chunk, buildThinkingBlocks(chunk), parent);
          }
        });
      },
    });
  } catch (error) {
    // The turn failed (provider 429/quota, auth, transport). `runOmp` refuses
    // to invent an answer, so nothing would be posted and the job would fail
    // with only a log line — an absence the room cannot distinguish from "no
    // report" (TASK-88's class: the failure mode that reads as a quiet day).
    // Post a SHORT, readable notice, then rethrow so the queue records the job
    // as failed with the real cause.
    const note = `${FAILURE_MARKER} ${kind} job failed: no answer produced.\n\n\`${truncate(errorText(error), 300)}\``;
    try {
      await sendReply(xrpc, spaceId, roomId, note, undefined, parent);
      log("posted failure notice to the room");
    } catch (postError) {
      log(`could not post failure notice: ${errorText(postError)}`);
    }
    throw error;
  }
  // Self-triggered ticks are independent (each is a fresh root id), so
  // persisting an entry per tick would only grow the session file forever.
  if (reply.sessionId && !selfTriggered) {
    sessions?.set(chainKey, { sessionId: reply.sessionId, traceThreadId: traceRoomId });
  }
  // `runOmp` rejects on a failed turn, so reaching here means a successful turn
  // that produced no text. Do not post an empty message.
  if (!reply.answer.trim()) {
    log("empty reply — not posting");
    return;
  }
  // Every chunk post has settled by here. Failures were logged and counted by
  // PostChain (so the trace may be incomplete), but the answer itself is still
  // worth posting — warn and continue rather than aborting the whole reply.
  await thinkingPosts.drain();
  if (thinkingPosts.failureCount() > 0) {
    log(
      `warning: ${thinkingPosts.failureCount()} thinking chunk(s) failed to post` +
        ` (first: ${errorText(thinkingPosts.firstError())}) — posting the answer anyway`,
    );
  }

  const traceLink = traceRoomId ? `\n\n---\n💭 trace: ${ROOMY_APP_URL}/${spaceId}/${traceRoomId}` : "";
  if (streamThinking && streamedThinking) {
    const { messageId } = await sendReply(xrpc, spaceId, roomId, `${reply.answer}${traceLink}`, undefined, parent);
    log(`replied ${messageId} (answer; thinking ${traceRoomId ? `in trace thread ${traceRoomId}` : "streamed in room"})`);
    return;
  }
  const thinking = reply.thinking?.trim();
  const postThinking = !selfTriggered && (opts.thinking ?? true) && !!thinking;
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
}

/** One queued cron job: post the prompt text to the room (threaded under
 *  `parent` when set). This is the seam a future scheduler drives. */
async function runCronJob(xrpc: DirectXrpcClient, job: QueueJob, log: (m: string) => void): Promise<void> {
  if (job.payload.kind !== "cron") return;
  const { spaceId, roomId, text, parent } = job.payload.cron;
  const { messageId } = await sendReply(xrpc, spaceId, roomId, text, undefined, parent);
  log(`cron job ${job.id} posted ${messageId}`);
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
    // `limit` is user-controlled (`--recent`) and the server caps a single
    // request at 100; the paged reader walks the cursor so a larger window is
    // several bounded requests instead of a 400.
    const { messages } = await readMessages(xrpc, roomId, { limit });
    const byId = new Map<string, MessageInfo>();
    for (const m of messages) byId.set(m.id, m);
    const meta = await xrpc.query("space.roomy.room.getMetadata", { roomId });

    // Walk the chain: triggering message → its replyTo → … → root.
    const chain: MessageInfo[] = [];
    let cur: MessageInfo | undefined = byId.get(msgId);
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
      // `readMessages` already decoded the body to plaintext.
      const content = m.content;
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
