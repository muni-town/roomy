#!/usr/bin/env bun
/**
 * One-off structure-sync recovery tool (TASK-181 follow-up).
 *
 * The Discord structure sync (TASK-140) merged bridged guild layouts into the
 * Roomy sidebar for spaces that already existed, producing duplicated or
 * reorganized sidebars. For each (guild, space) whose `structure_sync` claim
 * was applied, this tool replays the space's sidebar-write history from the
 * appserver's event log and classifies the bridge:
 *
 *   - untouched  — the sync write is the latest sidebar change; the pre-sync
 *                  sidebar is recoverable from the log and CAN be restored
 *                  (a revert candidate).
 *   - edited     — a human authored an updateSidebar event after the sync;
 *                  leave the layout alone.
 *   - multi-sync — more than one bridge sidebar write on the space; manual
 *                  review (which write belongs to this guild's claim).
 *   - unapplied / no-sync-event — nothing (or nothing attributable) written.
 *
 * Usage:
 *   bun run src/scripts/recover-sidebar.ts \
 *     --events-db <appserver events sqlite> \
 *     [--bridge-db <bridge sqlite>] \
 *     [--space <did>] [--guild <id>] [--json] [--since <epoch-ms>]
 *
 *   # restore every untouched bridge's pre-sync sidebar (writes as the bridge):
 *   bun run src/scripts/recover-sidebar.ts --events-db ... --apply --yes
 *
 * `--apply` sends a corrective space.roomy.space.updateSidebar.v1 per
 * untouched bridge via `sendEvents`, authenticated as the bridge's ATProto
 * account (same env/session as the running bridge: ATPROTO_BRIDGE_DID,
 * ATPROTO_BRIDGE_APP_PASSWORD, APPSERVER_URL, APPSERVER_DID). `--yes`
 * acknowledges the plan; without it `--apply` errors before sending anything.
 *
 * Read-only by default: --apply is the only mode that writes.
 */

import { Database } from "bun:sqlite";
import { decode } from "@atcute/cbor";
import {
	newUlid,
	updateSidebarEvents,
	type SidebarCategory as SdkSidebarCategory,
} from "@roomy-space/sdk";
import { transport } from "@roomy-space/sdk";
import {
	APPSERVER_DID,
	APPSERVER_URL,
	ATPROTO_BRIDGE_APP_PASSWORD,
	ATPROTO_BRIDGE_DID,
	BRIDGE_DB_PATH,
} from "../env.ts";
import { initRoomyClient } from "../roomy/client.ts";
import {
	analyzeStructureSync,
	type SidebarEventRow,
	type SidebarWrite,
	SIDEBAR_EVENT_TYPES,
	type StructureSyncRow,
	type SyncAnalysis,
	type SidebarCategory,
} from "./sidebar-recovery.ts";

interface Flags {
	eventsDb: string;
	bridgeDb: string;
	space?: string;
	guild?: string;
	apply: boolean;
	yes: boolean;
	json: boolean;
	help: boolean;
}

function parseFlags(argv: string[]): Flags {
	const flags: Flags = {
		eventsDb: "",
		bridgeDb: "",
		apply: false,
		yes: false,
		json: false,
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		const next = () => argv[++i]!;
		switch (arg) {
			case "--events-db":
				flags.eventsDb = next();
				break;
			case "--bridge-db":
				flags.bridgeDb = next();
				break;
			case "--space":
				flags.space = next();
				break;
			case "--guild":
				flags.guild = next();
				break;
			case "--apply":
				flags.apply = true;
				break;
			case "--yes":
				flags.yes = true;
				break;
			case "--json":
				flags.json = true;
				break;
			case "--help":
			case "-h":
				flags.help = true;
				break;
			default:
				throw new Error(`Unknown flag: ${arg}`);
		}
	}
	return flags;
}

const USAGE = `recover-sidebar.ts — classify/revert Discord structure-sync sidebar duplication

Usage:
  bun run src/scripts/recover-sidebar.ts --events-db <PATH> [flags]

Required:
  --events-db <PATH>   Appserver events SQLite (read-only; contains stream_events)
                       e.g. /var/lib/roomy/appserver/events.sqlite

Flags:
  --bridge-db <PATH>   Bridge SQLite (default: BRIDGE_DB_PATH env / ./data/bridge.sqlite)
  --space <did>        Only analyze this space (repeatable not required)
  --guild <id>         Only analyze this guild
  --json               Machine-readable report on stdout (one JSON object per line)
  --apply              Restore pre-sync sidebar for untouched bridges (writes!)
  --yes                Acknowledge the --apply plan without prompting
  -h, --help           This help

Env (apply mode): ATPROTO_BRIDGE_DID, ATPROTO_BRIDGE_APP_PASSWORD,
                  APPSERVER_URL, APPSERVER_DID (same as the bridge).
`;

async function main(): Promise<void> {
	const flags = parseFlags(process.argv.slice(2));
	if (flags.help) {
		console.log(USAGE);
		return;
	}

	if (!flags.eventsDb) {
		if (!process.env.APP_EVENTS_DB_PATH) {
			console.error(USAGE);
			process.exit(1);
		}
		flags.eventsDb = process.env.APP_EVENTS_DB_PATH;
	}
	flags.bridgeDb ||= BRIDGE_DB_PATH();

	if (flags.apply && !flags.yes) {
		console.error(
			"--apply requires --yes (this tool WRITES corrective sidebar events).",
		);
		process.exit(1);
	}
	if (flags.apply) {
		// Force evaluation now so auth misconfig fails fast, before any read.
		ATPROTO_BRIDGE_DID();
		ATPROTO_BRIDGE_APP_PASSWORD();
		APPSERVER_URL();
		APPSERVER_DID();
	}

	const eventsDb = new Database(flags.eventsDb, { readonly: true });
	const bridgesDb = new Database(flags.bridgeDb, { readonly: true });

	// ── Load structure_sync claims ─────────────────────────────────────────
	const structureSyncQuery = bridgesDb.query<{
		guild_id: string;
		space_did: string;
		claimed_at: number;
		applied_at: number | null;
	}, []>(
		"select guild_id, space_did, claimed_at, applied_at from structure_sync order by claimed_at",
	);
	const syncs = structureSyncQuery.all().map(
		(r): StructureSyncRow => ({
			guildId: r.guild_id,
			spaceDid: r.space_did,
			claimedAt: r.claimed_at,
			appliedAt: r.applied_at,
		}),
	);
	if (syncs.length === 0) {
		console.error("No structure_sync rows in bridge DB — nothing to recover.");
		process.exit(0);
	}

	// ── Load sidebar-write history for involved spaces ────────────────────
	const involved = new Set<string>(syncs.map((s) => s.spaceDid));
	const spaceFilter = flags.space ? [flags.space] : undefined;
	for (const did of spaceFilter ?? []) {
		if (!involved.has(did)) {
			console.error(`--space ${did} has no structure_sync claims; ignoring.`);
		}
	}
	const sidebarQuery = eventsDb.prepare<
		SidebarEventRow,
		[string, ...string[]]
	>(
		`select idx, user, payload, created_at from stream_events
		 where stream_id = ?
		   and (event_type in (${SIDEBAR_EVENT_TYPES.map(() => "?").join(", ")})
		        or event_type is null)
		 order by idx`,
	);
	const history = new Map<string, SidebarEventRow[]>();
	for (const spaceDid of involved) {
		if (spaceFilter && !spaceFilter.includes(spaceDid)) continue;
		const rows = sidebarQuery.all(spaceDid, ...SIDEBAR_EVENT_TYPES);
		// Event_type predates the sidebar event types (NULL rows): keep only
		// rows that actually decode to a sidebar write.
		const writes = rows.filter((r) => isSidebarWrite(r.payload));
		history.set(spaceDid, writes);
	}

	// ── Classify ───────────────────────────────────────────────────────────
	// (In apply mode ATPROTO_BRIDGE_DID is already validated above.)
	const bridgeDid = readBridgeDidOrNull();
	const analyses = syncs
		.filter((s) => (flags.guild ? s.guildId === flags.guild : true))
		.filter((s) => !spaceFilter || spaceFilter.includes(s.spaceDid))
		.map((s) => ({
			sync: s,
			analysis: analyzeStructureSync(
				history.get(s.spaceDid) ?? [],
				s,
				bridgeDid,
			),
		}));

	// ── Report ─────────────────────────────────────────────────────────────
	const byStatus: Record<string, typeof analyses> = {};
	for (const entry of analyses) {
		(byStatus[entry.analysis.status] ??= []).push(entry);
	}

	if (!flags.json) {
		for (const entry of analyses) {
			printEntry(entry);
		}
		console.log("");
		const summary = Object.entries(byStatus)
			.map(([status, list]) => `${status}: ${list.length}`)
			.join("  ");
		console.log(`SUMMARY  ${summary}`);
		if (bridgeDid) console.log(`(attributed by bridge DID ${bridgeDid})`);
		else
			console.log(
				"(no ATPROTO_BRIDGE_DID — attribution fell back to timestamps)",
			);
	} else {
		for (const entry of analyses) {
			console.log(JSON.stringify(jsonEntry(entry)));
		}
	}

	// ── Apply ──────────────────────────────────────────────────────────────
	if (flags.apply) {
		const untouched = analyses.filter(
			(e) => e.analysis.status === "untouched",
		);
		if (untouched.length === 0) {
			console.log("No untouched bridges to restore.");
			return;
		}
		console.log(
			`Restoring pre-sync sidebar for ${untouched.length} untouched bridge(s)...`,
		);
		const roomy = await initRoomyClient();
		const serviceAuth = new transport.ServiceAuthClient(roomy.agent);
		const xrpc = new transport.DirectXrpcClient(
			APPSERVER_URL(),
			APPSERVER_DID(),
			serviceAuth,
		);
		for (const { sync, analysis } of untouched) {
			const event = updateSidebarEvents(
				restoreCategories(analysis.preSyncCategories),
			);
			console.log(
				`  ${sync.spaceDid} (guild ${sync.guildId}): writing updateSidebar ` +
					`event ${event.id} with ${analysis.preSyncCategories.length} categories...`,
			);
			await xrpc.procedure("space.roomy.space.sendEvents", {
				spaceId: sync.spaceDid,
				events: [event],
			});
			console.log("    ok — verify with `getMetadata` and re-run --dry-run.");
		}
		console.log("Apply complete.");
	}
}

function readBridgeDidOrNull(): string | undefined {
	try {
		return ATPROTO_BRIDGE_DID();
	} catch {
		return undefined;
	}
}

/**
 * v0 payloads have no category ids; v1 requires them. Synthesize stable ids.
 * Decoded ids/children are ULID strings written by the SDK — the `Ulid`
 * brand is unobservable at runtime, so the casts are structural only.
 */
function restoreCategories(
	categories: SidebarCategory[],
): SdkSidebarCategory[] {
	return categories.map((cat) => ({
		id: cat.id ? (cat.id as SdkSidebarCategory["id"]) : newUlid(),
		name: cat.name,
		children: cat.children as SdkSidebarCategory["children"],
	}));
}

function isSidebarWrite(payload: Uint8Array): boolean {
	try {
		const decoded: unknown = decode(payload);
		if (typeof decoded !== "object" || decoded === null) return false;
		if (!("$type" in decoded)) return false;
		const $type: unknown = decoded.$type;
		return typeof $type === "string" && SIDEBAR_EVENT_TYPES.includes($type);
	} catch {
		return false;
	}
}

function printEntry(entry: {
	sync: StructureSyncRow;
	analysis: SyncAnalysis;
}): void {
	const { sync, analysis } = entry;
	const tag = analysis.status.toUpperCase();
	console.log(`[${tag}] space=${sync.spaceDid} guild=${sync.guildId}`);
	console.log(`  ${analysis.reason}`);
	if (analysis.syncEvent) {
		const se = analysis.syncEvent;
		console.log(
			`  sync write: idx ${se.idx}, ${se.categories.length} categories, author ${se.user}`,
		);
	}
	console.log(
		`  pre-sync: ${summarize(analysis.preSyncCategories)}  current: ${summarize(
			analysis.currentCategories,
		)}`,
	);
	if (analysis.appliedButUnmarked) {
		console.log(
			"  WARNING: bridge DB shows claim NOT applied, but a bridge-authored sidebar write exists —",
			"the sync likely crashed between send and markStructureSyncApplied.",
		);
	}
}

function summarize(categories: SidebarCategory[]): string {
	if (categories.length === 0) return "(none)";
	return categories
		.map((c) => `${c.name}[${c.children.length}]`)
		.join(", ");
}

function jsonEntry(entry: {
	sync: StructureSyncRow;
	analysis: SyncAnalysis;
}): Record<string, unknown> {
	return {
		guildId: entry.sync.guildId,
		spaceDid: entry.sync.spaceDid,
		status: entry.analysis.status,
		reason: entry.analysis.reason,
		syncEvent: entry.analysis.syncEvent
			? jsonWrite(entry.analysis.syncEvent)
			: null,
		preSyncCategories: entry.analysis.preSyncCategories,
		currentCategories: entry.analysis.currentCategories,
		humanEdits: entry.analysis.humanEdits.map(jsonWrite),
		laterBridgeWrites: entry.analysis.laterBridgeWrites.map(jsonWrite),
		appliedButUnmarked: entry.analysis.appliedButUnmarked,
	};
}

function jsonWrite(w: SidebarWrite): Record<string, unknown> {
	return {
		idx: w.idx,
		user: w.user,
		created_at: w.created_at,
		hasIds: w.hasIds,
		categories: w.categories,
	};
}

main().catch((err) => {
	console.error("recover-sidebar failed:", err);
	process.exit(1);
});
