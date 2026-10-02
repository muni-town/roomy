import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runMigrations } from "../db/schema.ts";
import { migrateForwardMappings } from "./migrate-forward-mappings.ts";

const SPACE = "did:web:space.example";

function db(): Database {
	const database = new Database(":memory:");
	runMigrations(database);
	return database;
}

function insert(
	database: Database,
	kind: string,
	discordId: string,
	roomyId: string,
	createdAt = 1_700_000_000_000,
): void {
	database
		.prepare(
			`INSERT INTO id_mappings (space_did, kind, discord_id, roomy_id, created_at)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.run(SPACE, kind, discordId, roomyId, createdAt);
}

function mapping(
	database: Database,
	kind: string,
	discordId: string,
): { roomy_id: string; created_at: number } | null {
	return database
		.query<{ roomy_id: string; created_at: number }, [string, string, string]>(
			`SELECT roomy_id, created_at FROM id_mappings
			  WHERE space_did = ? AND kind = ? AND discord_id = ?`,
		)
		.get(SPACE, kind, discordId);
}

function count(database: Database): number {
	return (
		database
			.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM id_mappings")
			.get()?.n ?? 0
	);
}

// The composite a pre-fix forward registered: <forwardUlid>:<originalRoomyId>.
const FORWARD_ULID = "01M3QTYAH30K8Y557XNJ1G7V0A";
const ORIGINAL_ULID = "01M2JYXJ8909ED6HMCHWVQK28N";
const COMPOSITE = `${FORWARD_ULID}:${ORIGINAL_ULID}`;

describe("migrateForwardMappings", () => {
	let database: Database;
	beforeEach(() => {
		database = db();
	});

	test("moves a composite key to the forward kind and re-points the message", () => {
		insert(database, "message", "111", COMPOSITE);

		const result = migrateForwardMappings(database);

		expect(result).toEqual({ moved: 1, repointed: 1, conflicts: [] });
		// Reply/edit/delete/reaction lookups resolve to a ULID again.
		expect(mapping(database, "message", "111")?.roomy_id).toBe(FORWARD_ULID);
		// The router's dedup key survives, under its own kind.
		expect(mapping(database, "forward", "111")?.roomy_id).toBe(COMPOSITE);
	});

	test("preserves created_at on the derived message mapping", () => {
		insert(database, "message", "111", COMPOSITE, 123_456);

		migrateForwardMappings(database);

		expect(mapping(database, "message", "111")?.created_at).toBe(123_456);
		expect(mapping(database, "forward", "111")?.created_at).toBe(123_456);
	});

	test("leaves ULID-valued rows and other kinds untouched", () => {
		insert(database, "message", "111", "01M2JYXJ8909ED6HMCHWVQK28N");
		insert(database, "reaction", "222", COMPOSITE);
		insert(database, "channel", "333", "01M2JYXJ8909ED6HMCHWVQK28N");

		const result = migrateForwardMappings(database);

		expect(result).toEqual({ moved: 0, repointed: 0, conflicts: [] });
		expect(count(database)).toBe(3);
		expect(mapping(database, "message", "111")?.roomy_id).toBe(
			"01M2JYXJ8909ED6HMCHWVQK28N",
		);
		expect(mapping(database, "reaction", "222")?.roomy_id).toBe(COMPOSITE);
	});

	test("is idempotent: a second run writes nothing", () => {
		insert(database, "message", "111", COMPOSITE);

		const first = migrateForwardMappings(database);
		const afterFirst = count(database);
		const second = migrateForwardMappings(database);

		expect(first.moved).toBe(1);
		expect(second).toEqual({ moved: 0, repointed: 0, conflicts: [] });
		expect(count(database)).toBe(afterFirst);
	});

	test("accepts rows the current code already wrote", () => {
		insert(database, "message", "111", FORWARD_ULID);
		insert(database, "forward", "111", COMPOSITE);

		const result = migrateForwardMappings(database);

		expect(result).toEqual({ moved: 0, repointed: 0, conflicts: [] });
		expect(mapping(database, "message", "111")?.roomy_id).toBe(FORWARD_ULID);
	});

	test("dry run reports the rewrite but rolls it back", () => {
		insert(database, "message", "111", COMPOSITE);

		const result = migrateForwardMappings(database, { dryRun: true });

		expect(result).toEqual({ moved: 1, repointed: 1, conflicts: [] });
		expect(mapping(database, "message", "111")?.roomy_id).toBe(COMPOSITE);
		expect(mapping(database, "forward", "111")).toBeNull();
	});

	test("reports a conflicting message mapping without overwriting it", () => {
		insert(database, "message", "111", "01M2JYXJ8909ED6HMCHWVQK28N");
		insert(database, "forward", "111", COMPOSITE);

		const result = migrateForwardMappings(database);

		expect(result.moved).toBe(0);
		expect(result.repointed).toBe(0);
		expect(result.conflicts).toEqual([
			{
				space_did: SPACE,
				discord_id: "111",
				dedup_key: COMPOSITE,
				message_id: "01M2JYXJ8909ED6HMCHWVQK28N",
			},
		]);
		expect(mapping(database, "message", "111")?.roomy_id).toBe(
			"01M2JYXJ8909ED6HMCHWVQK28N",
		);
	});
});
