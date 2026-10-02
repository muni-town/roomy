/**
 * One-shot data migration for databases written before the forward-dedup key
 * got its own mapping kind.
 *
 * A Discord forward is ingested as a Roomy message of its own, and the
 * Roomy→Discord router needs a second key to dedupe the echo of the forward
 * it created: the composite `<forwardUlid>:<originalRoomyId>`. That key used
 * to be stored under the `message` kind, which broke the bridge's invariant
 * that `(space, "message", discordId)` holds a ULID — replying to, editing,
 * deleting, or reacting to a bridged forward fed the composite string to
 * `Ulid.assert` and crashed the process.
 *
 * Current code registers the composite under its own kind (`forward`) and maps
 * `(space, "message", discordId)` to the forward's Roomy ULID. Rows written by
 * the old code still carry the old shape, so this script rewrites them:
 *
 *   1. `message` rows whose value contains `:` become `forward` rows.
 *   2. The `message` row the forward should have is derived from the
 *      composite's `<forwardUlid>` prefix, which is lossless.
 *
 * Idempotent and safe against a running bridge: the whole rewrite runs in one
 * `BEGIN IMMEDIATE` transaction, so a concurrent writer waits rather than
 * interleaving. Running it on an already-migrated database reports zero and
 * writes nothing.
 *
 * Usage (inside the deployed container, where `BRIDGE_DB_PATH` is set):
 *   bun run /app/dist/migrate-forward-mappings.js --dry-run
 *   bun run /app/dist/migrate-forward-mappings.js
 *
 * Locally:
 *   bun run src/scripts/migrate-forward-mappings.ts
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { BRIDGE_DB_PATH } from "../env.ts";

/** A `forward` row whose message counterpart is missing or points elsewhere. */
export type ForwardMappingConflict = {
	space_did: string;
	discord_id: string;
	dedup_key: string;
	message_id: string;
};

export type ForwardMappingMigrationResult = {
	/** Composite keys moved from `message` to `forward`. */
	moved: number;
	/** `message` rows created (or confirmed) for a forward's Roomy message. */
	repointed: number;
	conflicts: ForwardMappingConflict[];
};

const MOVE_COMPOSITE_KEYS = `
	UPDATE id_mappings SET kind = 'forward'
	 WHERE kind = 'message' AND roomy_id LIKE '%:%'
`;

// `INSERT OR IGNORE` because the row already exists when the current code had
// written the pair itself, or when this script has run before.
const REPOINT_MESSAGE_MAPPINGS = `
	INSERT OR IGNORE INTO id_mappings (space_did, kind, discord_id, roomy_id, created_at)
	SELECT space_did, 'message', discord_id,
	       substr(roomy_id, 1, instr(roomy_id, ':') - 1), created_at
	  FROM id_mappings
	 WHERE kind = 'forward' AND roomy_id LIKE '%:%'
`;

const FIND_CONFLICTS = `
	SELECT f.space_did     AS space_did,
	       f.discord_id    AS discord_id,
	       f.roomy_id      AS dedup_key,
	       m.roomy_id      AS message_id
	  FROM id_mappings f
	  JOIN id_mappings m
	    ON m.space_did = f.space_did
	   AND m.kind = 'message'
	   AND m.discord_id = f.discord_id
	 WHERE f.kind = 'forward'
	   AND f.roomy_id LIKE '%:%'
	   AND m.roomy_id <> substr(f.roomy_id, 1, instr(f.roomy_id, ':') - 1)
`;

/**
 * Rewrite the forward-dedup rows in `db`. Wrapped in a single write
 * transaction; `dryRun` rolls it back so the result can be inspected first.
 */
export function migrateForwardMappings(
	db: Database,
	{ dryRun = false }: { dryRun?: boolean } = {},
): ForwardMappingMigrationResult {
	db.exec("BEGIN IMMEDIATE");
	try {
		const moved = db.run(MOVE_COMPOSITE_KEYS).changes;
		const repointed = db.run(REPOINT_MESSAGE_MAPPINGS).changes;
		const conflicts = db
			.query<ForwardMappingConflict, []>(FIND_CONFLICTS)
			.all();
		db.exec(dryRun ? "ROLLBACK" : "COMMIT");
		return { moved, repointed, conflicts };
	} catch (err) {
		db.exec("ROLLBACK");
		throw err;
	}
}

const USAGE = `Usage: bun run migrate-forward-mappings.js [--dry-run]

Rewrites pre-fix forward-dedup rows in the bridge SQLite database. Reads the
database path from BRIDGE_DB_PATH (default ./data/bridge.sqlite).`;

function main(): void {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(USAGE);
		return;
	}
	const unknown = args.filter((arg) => arg !== "--dry-run");
	if (unknown.length > 0) {
		console.error(`Unknown argument(s): ${unknown.join(", ")}\n\n${USAGE}`);
		process.exit(2);
	}
	const dryRun = args.includes("--dry-run");

	const path = BRIDGE_DB_PATH();
	if (!existsSync(path)) {
		console.error(`[forward-dedup-migration] no database at ${path}`);
		process.exit(1);
	}

	const db = new Database(path);
	try {
		db.exec("PRAGMA busy_timeout = 5000");
		const hasTable = db
			.query(
				`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'id_mappings'`,
			)
			.get();
		if (!hasTable) {
			console.error(
				`[forward-dedup-migration] ${path} has no id_mappings table; not a bridge database`,
			);
			process.exit(1);
		}

		console.log(`[forward-dedup-migration] database: ${path}`);
		const { moved, repointed, conflicts } = migrateForwardMappings(db, {
			dryRun,
		});

		console.log(
			`[forward-dedup-migration] moved ${moved} composite key(s) from "message" to "forward"`,
		);
		console.log(
			`[forward-dedup-migration] ${dryRun ? "would write" : "wrote"} ${repointed} message mapping(s) for bridged forwards`,
		);

		if (conflicts.length > 0) {
			console.warn(
				`[forward-dedup-migration] WARNING: ${conflicts.length} forward(s) already had a different message mapping; left untouched:`,
			);
			for (const row of conflicts) {
				console.warn(
					`  space=${row.space_did} discord=${row.discord_id} dedup=${row.dedup_key} message=${row.message_id}`,
				);
			}
		}

		if (dryRun) {
			console.log("[forward-dedup-migration] dry run — no changes written");
		}
	} finally {
		db.close();
	}
}

if (import.meta.main) {
	main();
}
