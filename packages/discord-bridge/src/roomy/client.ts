/**
 * Roomy client for the Discord bridge.
 *
 * Authenticates using app password and creates a RoomyClient instance
 * for interacting with ATProto and Leaf.
 */

import { AtpAgent } from "@atproto/api";
import { RoomyClient } from "@roomy/sdk";
import {
  ATPROTO_BRIDGE_DID,
  ATPROTO_BRIDGE_APP_PASSWORD,
  LEAF_URL,
  LEAF_SERVER_DID,
  STREAM_HANDLE_NSID,
  STREAM_NSID,
} from "../env.js";
import { STREAM_SCHEMA_VERSION } from "../constants.js";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Session file path (dev only)
const SESSION_FILE = join(__dirname, "../../session.json");

/**
 * Load session from file, returns undefined if not found
 */
function loadSessionFile() {
  try {
    const data = readFileSync(SESSION_FILE, "utf-8");
    return JSON.parse(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Failed to read session file:", err);
    }
    return undefined;
  }
}

/**
 * Save session to file
 */
function saveSessionFile(session: unknown) {
  try {
    writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2), "utf-8");
  } catch (err) {
    console.error("Failed to write session file:", err);
  }
}

/**
 * Delete session file
 */
function deleteSessionFile() {
  try {
    unlinkSync(SESSION_FILE);
  } catch (err) {
    // Ignore if file doesn't exist
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("Failed to delete session file:", err);
    }
  }
}

/**
 * Initialize the Roomy client using app password authentication.
 * This should be called once at startup.
 */
export async function initRoomyClient(): Promise<RoomyClient> {
  console.log("Initializing ATProto agent...");

  // Try to load existing session
  const existingSession = loadSessionFile();

  // Create agent with persistSession handler
  const atpAgent = new AtpAgent({
    service: "https://bsky.social",
    persistSession: (evt, session) => {
      console.log(`Session event: ${evt}`);
      if (evt === "create" || evt === "update") {
        saveSessionFile(session);
      } else if (evt === "expired") {
        deleteSessionFile();
      }
    },
  });

  // Try to resume existing session or login fresh
  if (existingSession) {
    try {
      console.log("Restoring session from session.json...");
      await atpAgent.resumeSession(existingSession);
      console.log(`Session restored as ${atpAgent.did}`);
    } catch (err) {
      console.warn("Session restore failed, re-authenticating...", err);
      deleteSessionFile();
      await atpAgent.login({
        identifier: ATPROTO_BRIDGE_DID,
        password: ATPROTO_BRIDGE_APP_PASSWORD,
      });
      console.log(`Authenticated as ${atpAgent.did}`);
    }
  } else {
    console.log("Authenticating with ATProto...");
    await atpAgent.login({
      identifier: ATPROTO_BRIDGE_DID,
      password: ATPROTO_BRIDGE_APP_PASSWORD,
    });
    console.log(`Authenticated as ${atpAgent.did}`);
  }

  if (!atpAgent.did) {
    throw new Error("Failed to authenticate with app password - no DID");
  }

  console.log("Connecting to Leaf server...");

  const roomyClient = await RoomyClient.create({
    agent: atpAgent,
    leafUrl: LEAF_URL,
    leafDid: LEAF_SERVER_DID,
    profileSpaceNsid: STREAM_HANDLE_NSID,
    spaceNsid: STREAM_NSID,
  });

  console.log("Roomy client initialized successfully");
  return roomyClient;
}
