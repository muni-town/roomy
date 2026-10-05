import * as path from "node:path";
import * as os from "node:os";

const ROOMY_DIR = path.join(os.homedir(), ".roomy");

export interface Config {
  /** Appserver URL (e.g. http://localhost:8080) */
  appserverUrl: string;
  /** Appserver DID (e.g. did:web:api.roomy.space) */
  appserverDid: string;
  /** ATProto identifier (handle or DID) */
  identifier: string;
  /** ATProto app password */
  appPassword: string;
  /** Path to session cache file */
  sessionFile: string;
  /** Path to the room map file */
  roomMapFile: string;
  /** Root directory of the message cache (one directory per space). */
  cacheDir: string;
}

export function loadConfig(): Config {
  const appserverUrl =
    process.env.APPSERVER_URL ||
    process.env.VITE_APPSERVER_WS_ORIGIN?.replace(/^ws(s?):\/\//, "http$1://") ||
    "http://localhost:8080";
  const appserverDid =
    process.env.APPSERVER_DID || "did:web:api.roomy.space";
  const identifier = process.env.ATPROTO_IDENTIFIER || "";
  const appPassword = process.env.ATPROTO_APP_PASSWORD || "";
  const roomyDir = process.env.ROOMY_DIR || ROOMY_DIR;

  return {
    appserverUrl,
    appserverDid,
    identifier,
    appPassword,
    sessionFile: process.env.ROOMY_SESSION_FILE || path.join(roomyDir, "session.json"),
    roomMapFile: process.env.ROOMY_ROOM_MAP_FILE || path.join(roomyDir, "rooms.json"),
    cacheDir: process.env.ROOMY_CACHE_DIR || path.join(roomyDir, "cache"),
  };
}
