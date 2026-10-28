import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AtpAgent } from "@atproto/api";
import { RoomyClient } from "@roomy-space/sdk";
import {
	ATPROTO_BRIDGE_APP_PASSWORD,
	ATPROTO_BRIDGE_DID,
	BRIDGE_DATA_DIR,
	STREAM_HANDLE_NSID,
	STREAM_NSID,
} from "../env.ts";
import { createLogger } from "../logger.ts";
import { loginBridgeAccount, resolveLoginService } from "./atproto-login.ts";

const log = createLogger("roomy");

const SESSION_FILE = () => join(BRIDGE_DATA_DIR(), "session.json");

function loadSessionFile() {
	try {
		const data = readFileSync(SESSION_FILE(), "utf-8");
		return JSON.parse(data);
	} catch (err) {
		if (
			err !== null &&
			typeof err === "object" &&
			"code" in err &&
			err.code !== "ENOENT"
		) {
			log.warn("Failed to read session file", err);
		}
		return undefined;
	}
}

function saveSessionFile(session: unknown) {
	try {
		writeFileSync(SESSION_FILE(), JSON.stringify(session, null, 2), "utf-8");
	} catch (err) {
		log.error("Failed to write session file", err);
	}
}

function deleteSessionFile() {
	try {
		unlinkSync(SESSION_FILE());
	} catch (err) {
		if (
			err !== null &&
			typeof err === "object" &&
			"code" in err &&
			err.code !== "ENOENT"
		) {
			log.warn("Failed to delete session file", err);
		}
	}
}

export async function initRoomyClient(): Promise<RoomyClient> {
	log.info("Initializing ATProto agent...");

	const existingSession = loadSessionFile();
	const identifier = ATPROTO_BRIDGE_DID();

	const atpAgent = new AtpAgent({
		service: await resolveLoginService(identifier),
		persistSession: (evt, session) => {
			log.info(`Session event: ${evt}`);
			if (evt === "create" || evt === "update") {
				saveSessionFile(session);
			} else if (evt === "expired") {
				deleteSessionFile();
			}
		},
	});

	if (existingSession) {
		try {
			log.info("Restoring session from session.json...");
			await atpAgent.resumeSession(existingSession);
			log.info(`Session restored as ${atpAgent.did}`);
		} catch (err) {
			log.warn("Session restore failed, re-authenticating...", err);
			deleteSessionFile();
			log.info("Authenticating with ATProto...");
			await loginBridgeAccount(
				atpAgent,
				identifier,
				ATPROTO_BRIDGE_APP_PASSWORD(),
			);
		}
	} else {
		log.info("Authenticating with ATProto...");
		await loginBridgeAccount(
			atpAgent,
			identifier,
			ATPROTO_BRIDGE_APP_PASSWORD(),
		);
	}

	if (!atpAgent.did) {
		throw new Error("Failed to authenticate with app password - no DID");
	}

	log.info("Creating Roomy client...");

	const roomyClient = new RoomyClient({
		agent: atpAgent,
		profileSpaceNsid: STREAM_HANDLE_NSID(),
		spaceNsid: STREAM_NSID(),
	});

	log.info("Roomy client initialized successfully");
	return roomyClient;
}
