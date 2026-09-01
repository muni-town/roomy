#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { authenticate } from "./auth.js";
import { createSpace, listSpaces } from "./spaces.js";
import { listRooms, findLobbyRoom } from "./rooms.js";
import { sendMessage, readMessages, buildMentionBlocks } from "./messages.js";
import { setProfile } from "./profile.js";
import { respond } from "./respond.js";

const program = new Command();
export { program };

program
  .name("roomy-cli")
  .description("CLI tool for Roomy - agent testing and space management")
  .version("0.2.0");

// ── spaces ────────────────────────────────────────────────────────────────

program
  .command("spaces")
  .description("List all spaces")
  .action(async () => {
    try {
      const config = loadConfig();
      const { xrpc } = await authenticate(config);
      const spaces = await listSpaces(xrpc);
      for (const s of spaces) {
        const name = s.name ?? "(unnamed)";
        const handle = s.handle ? ` @${s.handle}` : "";
        console.log(`${s.id}  ${name}${handle}  [${s.isAdmin ? "admin" : "member"}]  ${s.unreadCount} unread`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("create-space")
  .description("Create a new Roomy space")
  .requiredOption("--name <name>", "Space name")
  .option("--description <description>", "Space description")
  .action(async (options: { name: string; description?: string }) => {
    try {
      const config = loadConfig();
      const { xrpc } = await authenticate(config);
      const { spaceId } = await createSpace(xrpc, {
        name: options.name,
        description: options.description,
      });
      console.log(`Created space: ${spaceId}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ── join ───────────────────────────────────────────────────────────────────

program
  .command("join")
  .description("Join a space")
  .requiredOption("--space <id>", "Space ID")
  .option("--invite-token <token>", "Invite token for private spaces")
  .action(async (options: { space: string; inviteToken?: string }) => {
    try {
      const config = loadConfig();
      const { xrpc } = await authenticate(config);
      const { spaceId } = await xrpc.procedure("space.roomy.space.joinSpace", {
        spaceId: options.space,
        ...(options.inviteToken ? { inviteToken: options.inviteToken } : {}),
      });
      console.log(`Joined space: ${spaceId}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ── rooms ─────────────────────────────────────────────────────────────────

program
  .command("rooms")
  .description("List rooms in a space")
  .requiredOption("--space <id>", "Space ID")
  .action(async (options: { space: string }) => {
    try {
      const config = loadConfig();
      const { xrpc } = await authenticate(config);
      const { categories, orphans } = await listRooms(xrpc, options.space);
      for (const cat of categories) {
        console.log(`\n# ${cat.name}`);
        for (const ch of cat.channels) {
          const name = ch.name ?? "(unnamed)";
          console.log(`  ${ch.id}  ${name}  [${ch.unreadCount} unread]`);
        }
      }
      if (orphans.length > 0) {
        console.log("\n# (orphans)");
        for (const ch of orphans) {
          const name = ch.name ?? "(unnamed)";
          console.log(`  ${ch.id}  ${name}  [${ch.unreadCount} unread]`);
        }
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ── create-room ─────────────────────────────────────────────────────────────

program
  .command("create-room")
  .description("Create a room/channel in a space (requires space admin)")
  .requiredOption("--space <id>", "Space ID")
  .requiredOption("--name <name>", "Room name")
  .option("--kind <kind>", "Room kind: channel|category|thread|page (default channel)", "channel")
  .option("--description <description>", "Room description")
  .action(async (options: { space: string; name: string; kind: string; description?: string }) => {
    try {
      const config = loadConfig();
      const { xrpc } = await authenticate(config);
      const { createRoom } = await import("@roomy-space/sdk");
      const kind = `space.roomy.${options.kind}` as "space.roomy.channel" | "space.roomy.category" | "space.roomy.thread" | "space.roomy.page";
      const events = createRoom({ kind, name: options.name, description: options.description });
      await xrpc.procedure("space.roomy.space.sendEvents", { spaceId: options.space, events });
      const id = events[0]?.id;
      if (!id) throw new Error("createRoom returned no event");
      console.log(`Created room: ${id}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ── send ──────────────────────────────────────────────────────────────────

program
  .command("delete-room")
  .description("Delete (soft-delete) a room/channel (requires space admin)")
  .requiredOption("--space <id>", "Space ID")
  .requiredOption("--room <id>", "Room ID to delete")
  .action(async (options: { space: string; room: string }) => {
    try {
      const config = loadConfig();
      const { xrpc } = await authenticate(config);
      const { deleteRoom } = await import("@roomy-space/sdk");
      const events = deleteRoom({ roomId: options.room as never });
      await xrpc.procedure("space.roomy.space.sendEvents", { spaceId: options.space, events });
      const id = events[0]?.id;
      if (!id) throw new Error("deleteRoom returned no event");
      console.log(`Deleted room: ${options.room}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("send")
  .description("Send a message to a room (defaults to the lobby)")
  .requiredOption("--space <id>", "Space ID")
  .option("--room <id>", "Room ID (defaults to the lobby)")
  .option("--text <text>", "Message text")
  .option("--mention <did>", "Mention a user via a Roomy-native #didMention facet")
  .option("--mention-label <label>", "Display label for --mention (default: the mentioned DID)")
  .option(
    "--json <json>",
    "Send a JSON richtext document (blocks array) instead of plain text",
  )
  .option("--parent <id>", "Reply to a message id, creating a thread rooted at it")
  .action(async (options: { space: string; room?: string; text?: string; mention?: string; mentionLabel?: string; json?: string; parent?: string }) => {
    try {
      const config = loadConfig();
      const { xrpc } = await authenticate(config);
      let roomId = options.room;
      if (!roomId) {
        const lobby = await findLobbyRoom(xrpc, options.space);
        if (!lobby) throw new Error(`No rooms found in space ${options.space}`);
        roomId = lobby.id;
        console.error(`Using lobby room: ${lobby.name ?? "(unnamed)"} (${roomId})`);
      }
      let messageId: string;
      const sendOpts = { parent: options.parent };
      if (options.json) {
        const parsed = JSON.parse(options.json);
        const blocks = Array.isArray(parsed) ? parsed : parsed?.blocks;
        if (!Array.isArray(blocks)) {
          throw new Error("--json must be a blocks array or a { blocks: [...] } document");
        }
        ({ messageId } = await sendMessage(xrpc, options.space, roomId, "", { blocks, ...sendOpts }));
      } else {
        const text = options.text ?? await readStdin();
        const blocks = options.mention
          ? buildMentionBlocks(text, options.mention, options.mentionLabel ?? options.mention)
          : undefined;
        ({ messageId } = await sendMessage(xrpc, options.space, roomId, text, { blocks, ...sendOpts }));
      }
      console.error(`Message sent: ${messageId}`);
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ── read ──────────────────────────────────────────────────────────────────

program
  .command("read")
  .description("Read messages from a room (defaults to the lobby)")
  .option("--space <id>", "Space ID (required if --room is omitted)")
  .option("--room <id>", "Room ID (defaults to the lobby)")
  .option("--limit <n>", "Max messages", "20")
  .action(async (options: { space?: string; room?: string; limit: string }) => {
    try {
      const config = loadConfig();
      const { xrpc } = await authenticate(config);
      let roomId = options.room;
      if (!roomId) {
        if (!options.space) throw new Error("Provide --room or --space");
        const lobby = await findLobbyRoom(xrpc, options.space);
        if (!lobby) throw new Error(`No rooms found in space ${options.space}`);
        roomId = lobby.id;
      }
      const messages = await readMessages(xrpc, roomId, Number(options.limit));
      for (const m of messages) {
        const ts = formatTimestamp(m.timestamp);
        console.log(`[${ts}] ${m.authorName || m.authorDid}: ${m.content}`);
      }
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

/**
 * Format a message timestamp for display. System events (e.g. "joined the
 * space") carry an empty timestamp, so fall back gracefully instead of
 * throwing on `new Date("")`.
 */
function formatTimestamp(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toISOString();
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new Error("No input provided. Use --text or pipe content to stdin.");
  }
  const chunks: Buffer[] = [];
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  process.stdin.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
  });
  process.stdin.on("end", () => {
    const content = Buffer.concat(chunks).toString("utf-8").trim();
    if (!content) {
      reject(new Error("Empty input. Nothing to send."));
      return;
    }
    resolve(content);
  });
  process.stdin.on("error", (err: Error) => {
    reject(new Error(`Failed to read stdin: ${err.message}`));
  });
  return promise;
}


program
  .command("profile")
  .description("Set the caller's Roomy profile")
  .option("--display-name <name>", "Display name")
  .option("--description <desc>", "Profile description")
  .option("--pronouns <pronouns>", "Pronouns")
  .option("--website <url>", "Website URL")
  .action(async (options: { displayName?: string; description?: string; pronouns?: string; website?: string }) => {
    try {
      const config = loadConfig();
      const { agent } = await authenticate(config);
      await setProfile(agent, options);
      console.log("Profile updated");
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ── respond ─────────────────────────────────────────────────────────────

program
  .command("respond")
  .description("Read roomy-bridge mention events from stdin (NDJSON) and reply to each via omp")
  .option("--no-mention-only", "Respond to every message, not just mentions")
  .option("--include-self", "Also respond to the agent's own messages (testing)")
  .option("--cwd <dir>", "Working directory for the omp agent")
  .option("--model <model>", "omp model override (fuzzy match)")
  .option("--prefix <text>", "Extra context prepended to every prompt")
  .option("--omp-bin <path>", "Path to the omp binary (default: omp on PATH)")
  .option("--no-continuity", "Give each mention a fresh omp session (default: resume per-room)")
  .option("--session-file <path>", "Path for the room → omp session map (default ~/.roomy/omp-sessions.json)")
  .option("--no-thinking", "Don't post the agent's thinking trace, just the answer")
  .option("--no-stream-thinking", "Don't stream thinking chunks; bundle thinking with the final answer")
  .option("--thinking-chunk <n>", "Approx char threshold for each streamed thinking chunk (default 2000)", "2000")
  .option("--system-prompt-file <path>", "File appended to omp's system prompt (default: $OMP_SYSTEM_PROMPT_FILE)")
  .option("--recent <n>", "Recent room messages to load into context when mentioned (default 20; 0 disables)", "20")
  .action(async (options: {
    mentionOnly: boolean;
    includeSelf?: boolean;
    cwd?: string;
    model?: string;
    prefix?: string;
    ompBin?: string;
    continuity: boolean;
    sessionFile?: string;
    thinking: boolean;
    streamThinking: boolean;
    thinkingChunk: string;
    systemPromptFile?: string;
    recent: string;
  }) => {
    try {
      const config = loadConfig();
      const auth = await authenticate(config);
      await respond(auth.xrpc, auth.agent, {
        mentionOnly: options.mentionOnly,
        includeSelf: options.includeSelf,
        cwd: options.cwd,
        model: options.model,
        prefix: options.prefix,
        ompBin: options.ompBin,
        continuity: options.continuity,
        sessionFile: options.sessionFile,
        thinking: options.thinking,
        streamThinking: options.streamThinking,
        thinkingChunkSize: Number(options.thinkingChunk),
        systemPromptFile: options.systemPromptFile ?? process.env.OMP_SYSTEM_PROMPT_FILE,
        recent: Number(options.recent),
      });
    } catch (error) {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

// ── parse ─────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((error: Error) => {
  console.error(`Fatal error: ${error.message}`);
  process.exit(2);
});
