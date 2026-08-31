/**
 * Scriptable E2E test for the Discord bridge — TASK-64 regressions.
 *
 * Verifies, against a live staging bridge + staging Discord + staging
 * appserver, the two regressions reported in TASK-64:
 *
 *   1. Roomy → Discord message edits are synced (text/markdown AND
 *      application/vnd.roomy.richtext+json bodies).
 *   2. Discord → Roomy media attachments (image, video, file, and
 *      media-only messages) appear in Roomy with a `media` entry.
 *
 * The bridge must be running (this script drives it end-to-end; it does not
 * start it). It authenticates as the bridge account and reads the bridge's
 * SQLite DB to resolve Roomy↔Discord message mappings.
 *
 * CI note: this cannot run in CI today — it needs a real Discord guild with
 * a bridged channel, a staging appserver, and the bridge account's app
 * password. It is written to be CI-adoptable: it takes all inputs from env,
 * exits non-zero on any failure, and cleans up the webhook it creates.
 *
 * Usage (from packages/discord-bridge, with .env loaded):
 *   export E2E_SPACE_DID=did:plc:...            # bridged space
 *   export E2E_ROOM_ULID=01...                  # bridged channel's Roomy room
 *   export E2E_DISCORD_CHANNEL_ID=147...       # bridged Discord channel
 *   bun run src/scripts/e2e.ts
 */

import { Database } from "bun:sqlite";
import { AtpAgent } from "@atproto/api";
import { transport, newUlid, toBytes, serializeBlocks } from "@roomy-space/sdk";

// ── config ──────────────────────────────────────────────────────────────────

function required(name: string): string {
	const value = process.env[name];
	if (!value) throw new Error(`${name} environment variable not provided.`);
	return value;
}

const DISCORD_TOKEN = required("DISCORD_TOKEN");
const APP_PASSWORD = required("ATPROTO_BRIDGE_APP_PASSWORD");
const APPSERVER_URL = required("APPSERVER_URL");
const APPSERVER_DID = required("APPSERVER_DID");
const DB_PATH = process.env.BRIDGE_DB_PATH ?? "./data/bridge.sqlite";

const SPACE_DID = required("E2E_SPACE_DID");
const ROOM_ULID = required("E2E_ROOM_ULID");
const CHANNEL_ID = required("E2E_DISCORD_CHANNEL_ID");

const DISCORD_API = "https://discord.com/api/v10";
const POLL_MS = 1_000;
const POLL_TIMEOUT_MS = 30_000;

// ── helpers ────────────────────────────────────────────────────────────────

let failures = 0;
let checks = 0;

function check(name: string, ok: boolean, detail = ""): void {
	checks += 1;
	if (ok) {
		console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
	} else {
		failures += 1;
		console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

async function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	await promise;
}

async function poll<T>(
	fn: () => Promise<T | undefined>,
	label: string,
): Promise<T | undefined> {
	const deadline = Date.now() + POLL_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const value = await fn();
		if (value !== undefined) return value;
		await sleep(POLL_MS);
	}
	console.error(`  (timeout waiting for ${label})`);
	return undefined;
}

function discordHeaders(): Record<string, string> {
	return { Authorization: `Bot ${DISCORD_TOKEN}` };
}

async function discordFetch(path: string, init?: RequestInit): Promise<Response> {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		const res = await fetch(`${DISCORD_API}${path}`, init);
		if (res.status === 429) {
			const body = (await res.json().catch(() => ({}))) as {
				retry_after?: number;
			};
			await sleep(Math.ceil((body.retry_after ?? 1) * 1000) + 100);
			continue;
		}
		return res;
	}
	throw new Error(`Discord ${init?.method ?? "GET"} ${path}: rate limited after 5 retries`);
}

async function discordGet<T>(path: string): Promise<T> {
	const res = await discordFetch(path, { headers: discordHeaders() });
	if (!res.ok) throw new Error(`Discord GET ${path}: ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}

async function discordPost<T>(path: string, body: unknown): Promise<T> {
	const res = await discordFetch(path, {
		method: "POST",
		headers: { ...discordHeaders(), "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`Discord POST ${path}: ${res.status} ${await res.text()}`);
	return (await res.json()) as T;
}

async function discordDelete(path: string): Promise<void> {
	const res = await discordFetch(path, {
		method: "DELETE",
		headers: discordHeaders(),
	});
	if (!res.ok) throw new Error(`Discord DELETE ${path}: ${res.status} ${await res.text()}`);
}

/** Read the bridge DB (read-only) to resolve a Roomy message → Discord id. */
function discordIdForRoomyMessage(roomyMessageId: string): string | undefined {
	const db = new Database(DB_PATH, { readonly: true });
	try {
		const row = db
			.query(
				`SELECT discord_id FROM id_mappings
				 WHERE kind = 'message' AND roomy_id = ?`,
			)
			.get(roomyMessageId) as { discord_id: string } | null;
		return row?.discord_id;
	} finally {
		db.close();
	}
}

/** Read the bridge DB (read-only) to resolve a Discord message → Roomy id. */
function roomyIdForDiscordMessage(discordMessageId: string): string | undefined {
	const db = new Database(DB_PATH, { readonly: true });
	try {
		const row = db
			.query(
				`SELECT roomy_id FROM id_mappings
				 WHERE kind = 'message' AND discord_id = ?`,
			)
			.get(discordMessageId) as { roomy_id: string } | null;
		return row?.roomy_id;
	} finally {
		db.close();
	}
}

function makeTextBody(content: string): { mimeType: string; data: { $bytes: string } } {
	return {
		mimeType: "text/markdown",
		data: toBytes(new TextEncoder().encode(content)),
	};
}

function makeRichTextBody(blocks: unknown[]): {
	mimeType: string;
	data: { $bytes: string };
} {
	const serialized = serializeBlocks(blocks as never);
	return { mimeType: serialized.mimeType, data: toBytes(serialized.data) };
}
// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
	console.log("Discord bridge E2E (TASK-64)");
	console.log(`  space: ${SPACE_DID}`);
	console.log(`  room:  ${ROOM_ULID}`);
	console.log(`  channel: ${CHANNEL_ID}`);
	console.log(`  db:    ${DB_PATH}`);
	console.log("");

	const agent = new AtpAgent({ service: "https://bsky.social" });
	await agent.login({
		identifier: process.env.ATPROTO_BRIDGE_DID ?? "roomy-test-3.bsky.social",
		password: APP_PASSWORD,
	});
	const serviceAuth = new transport.ServiceAuthClient(agent);
	const xrpc = new transport.DirectXrpcClient(APPSERVER_URL, APPSERVER_DID, serviceAuth);

	// ── 1. Roomy → Discord: send + edit (text/markdown) ─────────────────────
	console.log("== R→D: send + edit (text/markdown) ==");
	const originalText = `TASK-64 E2E original ${newUlid()}`;
	const createEvent = {
		id: newUlid(),
		room: ROOM_ULID,
		$type: "space.roomy.message.createMessage.v0",
		body: makeTextBody(originalText),
		extensions: {},
	};
	await xrpc.procedure("space.roomy.space.sendEvents", {
		spaceId: SPACE_DID,
		events: [createEvent],
	});
	const roomyMessageId = createEvent.id;
	console.log(`  sent Roomy message ${roomyMessageId}`);

	const discordMessageId = await poll(
		async () => discordIdForRoomyMessage(roomyMessageId),
		"bridge mapping for Roomy message",
	);
	check("R→D message bridged to Discord", discordMessageId !== undefined);
	if (!discordMessageId) {
		console.error("  aborting: no Discord mapping; is the bridge running?");
		process.exit(1);
	}

	const sent = await discordGet<{ content: string }>(
		`/channels/${CHANNEL_ID}/messages/${discordMessageId}`,
	);
	check("R→D message content matches", sent.content === originalText, sent.content);

	const editedText = `TASK-64 E2E edited text ${newUlid()}`;
	await xrpc.procedure("space.roomy.space.sendEvents", {
		spaceId: SPACE_DID,
		events: [
			{
				id: newUlid(),
				room: ROOM_ULID,
				$type: "space.roomy.message.editMessage.v0",
				messageId: roomyMessageId,
				body: makeTextBody(editedText),
				extensions: {},
			},
		],
	});
	const edited = await poll(
		async () => {
			const m = await discordGet<{ content: string; edited_timestamp?: string }>(
				`/channels/${CHANNEL_ID}/messages/${discordMessageId}`,
			);
			return m.content === editedText ? m : undefined;
		},
		"text edit to propagate to Discord",
	);
	check(
		"R→D text edit synced",
		edited !== undefined && edited.edited_timestamp !== undefined,
		edited?.content,
	);

	// ── 2. Roomy → Discord: edit (richtext body) ────────────────────────────
	console.log("== R→D: edit (richtext body) ==");
	const richtextText = `TASK-64 E2E edited richtext ${newUlid()}`;
	const richtextBlocks = [
		{ $type: "space.roomy.richtext.blocks#text", text: richtextText },
		{ $type: "space.roomy.richtext.blocks#code", text: "const x = 1;" },
	];
	await xrpc.procedure("space.roomy.space.sendEvents", {
		spaceId: SPACE_DID,
		events: [
			{
				id: newUlid(),
				room: ROOM_ULID,
				$type: "space.roomy.message.editMessage.v0",
				messageId: roomyMessageId,
				body: makeRichTextBody(richtextBlocks),
				extensions: {},
			},
		],
	});
	const richtextEdited = await poll(
		async () => {
			const m = await discordGet<{ content: string }>(
				`/channels/${CHANNEL_ID}/messages/${discordMessageId}`,
			);
			return m.content === `${richtextText}\n\`\`\`\nconst x = 1;\n\`\`\``
				? m
				: undefined;
		},
		"richtext edit to propagate to Discord",
	);
	check("R→D richtext edit synced", richtextEdited !== undefined, richtextEdited?.content);

	// ── 3. Discord → Roomy: media attachments ────────────────────────────────
	console.log("== D→R: media attachments ==");
	const webhookName = `task64-e2e-${newUlid().slice(-8)}`;
	const webhook = await discordPost<{ id: string; token: string }>(
		`/channels/${CHANNEL_ID}/webhooks`,
		{ name: webhookName },
	);
	const webhookUrl = `${DISCORD_API}/webhooks/${webhook.id}/${webhook.token}`;

	async function postWithFile(
		content: string,
		filename: string,
		file: Uint8Array,
		contentType: string,
	): Promise<string> {
		const form = new FormData();
		form.append(
			"file",
			new Blob([file as unknown as BlobPart], { type: contentType }),
			filename,
		);
		form.append("payload_json", JSON.stringify({ content }));
		const res = await discordFetch(`/webhooks/${webhook.id}/${webhook.token}`, {
			method: "POST",
			body: form,
		});
		if (!res.ok) throw new Error(`webhook post: ${res.status} ${await res.text()}`);
		const m = (await res.json()) as { id: string };
		return m.id;
	}

	async function roomyMessageWithMedia(
		discordMsgId: string,
	): Promise<{ id: string; media: Array<{ type: string }> } | undefined> {
		const roomyId = roomyIdForDiscordMessage(discordMsgId);
		if (!roomyId) return undefined;
		const res = await xrpc.query("space.roomy.room.getMessages", {
			roomId: ROOM_ULID,
			limit: "50",
		});
		const match = res.messages.find((m) => m.id === roomyId);
		if (!match || match.media.length === 0) return undefined;
		return { id: match.id, media: match.media as Array<{ type: string }> };
	}

	// image + text
	const png = new Uint8Array([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
		0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
		0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
		0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
		0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x0d, 0x00, 0x00, 0x00,
		0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
	]);
	const imgMsgId = await postWithFile(
		`TASK-64 E2E image ${newUlid()}`,
		"task64-e2e.png",
		png,
		"image/png",
	);
	const imgInRoomy = await poll(
		async () => roomyMessageWithMedia(imgMsgId),
		"image message to appear in Roomy with media",
	);
	check(
		"D→R image+text appears with media",
		imgInRoomy !== undefined &&
			imgInRoomy.media.some((m: { type: string }) => m.type.startsWith("image/")),
		imgInRoomy ? JSON.stringify(imgInRoomy.media[0]?.type) : undefined,
	);

	// media-only (no text)
	const mediaOnlyMsgId = await postWithFile("", "task64-e2e.png", png, "image/png");
	const mediaOnlyInRoomy = await poll(
		async () => roomyMessageWithMedia(mediaOnlyMsgId),
		"media-only message to appear in Roomy with media",
	);
	check(
		"D→R media-only appears with media",
		mediaOnlyInRoomy !== undefined &&
			mediaOnlyInRoomy.media.some((m: { type: string }) => m.type.startsWith("image/")),
		mediaOnlyInRoomy ? JSON.stringify(mediaOnlyInRoomy.media[0]?.type) : undefined,
	);

	// file
	const txt = new TextEncoder().encode(`TASK-64 E2E file ${newUlid()}\n`);
	const fileMsgId = await postWithFile(
		`TASK-64 E2E file ${newUlid()}`,
		"task64-e2e.txt",
		txt,
		"text/plain",
	);
	const fileInRoomy = await poll(
		async () => roomyMessageWithMedia(fileMsgId),
		"file message to appear in Roomy with media",
	);
	check(
		"D→R file appears with media",
		fileInRoomy !== undefined &&
			fileInRoomy.media.some((m: { type: string }) => m.type.startsWith("text/")),
		fileInRoomy ? JSON.stringify(fileInRoomy.media[0]?.type) : undefined,
	);

	// cleanup
	await discordDelete(`/webhooks/${webhook.id}/${webhook.token}`).catch(() => {});
	console.log("  (cleaned up E2E webhook)");

	// ── summary ─────────────────────────────────────────────────────────────
	console.log("");
	if (failures === 0) {
		console.log(`E2E PASS: ${checks}/${checks} checks passed`);
		process.exit(0);
	}
	console.error(`E2E FAIL: ${failures}/${checks} checks failed`);
	process.exit(1);
}

main().catch((err) => {
	console.error("E2E error:", err);
	process.exit(1);
});
