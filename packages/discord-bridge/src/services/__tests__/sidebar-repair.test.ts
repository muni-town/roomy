import { describe, expect, test } from "bun:test";
import { transport } from "@roomy-space/sdk";
import {
	type SidebarWrite,
	analyzeStructureSync,
	restoreEvent,
} from "../sidebar-recovery.ts";
import {
	type RepairOutcome,
	type SidebarHistory,
	type SidebarInspection,
	applySidebarRestore,
	formatRepairReport,
	readConsistentHistory,
	sameHistory,
} from "../sidebar-repair.ts";

const BRIDGE = "did:plc:bridge";
const ADMIN = "did:plc:admin";
const SPACE = "did:plc:space";

/** The sidebar a stub appserver holds, in the shape `getMetadata` returns. */
interface Sidebar {
	categories: Array<{ id: string; name: string; children: string[] }>;
}

function getMetadataBody(sidebar: Sidebar): unknown {
	return {
		sidebar: {
			categories: sidebar.categories.map((category) => ({
				id: category.id,
				name: category.name,
				channels: category.children.map((id) => ({ id })),
			})),
		},
	};
}

/**
 * An appserver stub: `getMetadata` reports `sidebar`, `sendEvents` replaces it
 * with what it was sent, as the real one materializes the write.
 */
function stubAppserver(sidebar: Sidebar) {
	const calls: Array<{ nsid: string; body: unknown }> = [];
	const xrpc = {
		query: async () => getMetadataBody(sidebar),
		procedure: async (nsid: string, body: unknown) => {
			calls.push({ nsid, body });
			const sent = (
				body as { events: Array<{ categories: Sidebar["categories"] }> }
			).events;
			for (const event of sent) sidebar.categories = event.categories;
			return {};
		},
	};
	return {
		xrpc: xrpc as unknown as transport.DirectXrpcClient,
		calls,
		sidebar,
	};
}

/** A space whose sidebar the sync duplicated a header of. */
function damagedAnalysis() {
	return analyzeStructureSync(
		[
			{
				idx: 1,
				user: ADMIN,
				eventType: "space.roomy.space.updateSidebar.v1",
				categories: [{ name: "general", children: ["lobby"] }],
			},
			{
				idx: 2,
				user: BRIDGE,
				eventType: "space.roomy.space.updateSidebar.v1",
				categories: [
					{ name: "general", children: ["lobby"] },
					{ name: "General", children: ["chat"] },
				],
			},
		],
		BRIDGE,
	);
}

describe("restoreEvent", () => {
	test("carries the pre-sync layout as one updateSidebar.v1", () => {
		const event = restoreEvent(damagedAnalysis());
		expect(event.$type).toBe("space.roomy.space.updateSidebar.v1");
		expect(typeof event.id).toBe("string");
		const categories = (event as unknown as {
			categories: Array<{ id: string; name: string; children: string[] }>;
		}).categories;
		expect(categories.map((category) => category.name)).toEqual(["general"]);
		expect(categories[0]?.children).toEqual(["lobby"]);
		expect(new Set(categories.map((category) => category.id)).size).toBe(
			categories.length,
		);
	});

	test("refuses an analysis with no pre-sync layout", () => {
		const analysis = analyzeStructureSync(
			[
				{
					idx: 1,
					user: BRIDGE,
					eventType: "space.roomy.space.updateSidebar.v1",
					categories: [{ name: "general", children: [] }],
				},
			],
			BRIDGE,
		);
		expect(() => restoreEvent(analysis)).toThrow(/nothing to restore/);
	});
});

describe("applySidebarRestore", () => {
	test("writes back the layout the sync replaced, and verifies it", async () => {
		const appserver = stubAppserver({
			categories: [
				{ id: "c1", name: "general", children: ["lobby"] },
				{ id: "c2", name: "General", children: ["chat"] },
			],
		});
		const applied = await applySidebarRestore(
			appserver.xrpc,
			SPACE,
			damagedAnalysis(),
		);

		expect(applied).toEqual({ restoredFrom: 1, verified: true });
		expect(appserver.calls.map((call) => call.nsid)).toEqual([
			"space.roomy.space.sendEvents",
		]);
		expect(appserver.calls[0]?.body).toMatchObject({
			spaceId: SPACE,
			events: [{ $type: "space.roomy.space.updateSidebar.v1" }],
		});
		expect(appserver.sidebar.categories.map((c) => c.name)).toEqual(["general"]);
	});

	test("refuses to write when the sidebar moved since the read", async () => {
		// Someone renamed the category between the read and the write.
		const appserver = stubAppserver({
			categories: [
				{ id: "c1", name: "chat", children: ["lobby"] },
				{ id: "c2", name: "General", children: ["chat"] },
			],
		});
		await expect(
		applySidebarRestore(appserver.xrpc, SPACE, damagedAnalysis()),
		).rejects.toThrow(/changed since the read/);
		expect(appserver.calls).toEqual([]);
	});

	test("refuses an analysis with no pre-sync layout", async () => {
		const appserver = stubAppserver({ categories: [] });
		const analysis = analyzeStructureSync(
			[
				{
					idx: 1,
					user: BRIDGE,
					eventType: "space.roomy.space.updateSidebar.v1",
					categories: [{ name: "general", children: [] }],
				},
			],
			BRIDGE,
		);
		await expect(
		applySidebarRestore(appserver.xrpc, SPACE, analysis),
		).rejects.toThrow(/nothing to restore/);
		expect(appserver.calls).toEqual([]);
	});
});

describe("formatRepairReport", () => {
	const inspection = (fields: Partial<SidebarInspection> = {}): SidebarInspection => ({
		spaceDid: SPACE,
		events: 12,
		writes: 2,
		verified: true,
		...fields,
	});

	test("names the restore target and the read", () => {
		const report = formatRepairReport(
			inspection({ analysis: damagedAnalysis() }),
		);
		expect(report).toContain(`**\`${SPACE}\`**`);
		expect(report).toContain("restorable");
		expect(report).toContain("read 12 event(s), 2 sidebar write(s)");
		expect(report).toContain("verified against the current sidebar");
		expect(report).toContain("restore target: event idx 1 — general (1)");
		expect(report).not.toContain("applied:");
	});

	test("reports what a revert did, and whether the space shows it", () => {
		const applied: RepairOutcome = { restoredFrom: 1, verified: true };
		const report = formatRepairReport(
			inspection({ analysis: damagedAnalysis() }),
			applied,
			{ applyRequested: true },
		);
		expect(report).toContain(
			"applied: restored the layout from event idx 1, and the space shows it.",
		);
	});

	test("states why nothing was written when the space is not restorable", () => {
		const analysis = analyzeStructureSync(
			[
				{
					idx: 1,
					user: ADMIN,
					eventType: "space.roomy.space.updateSidebar.v1",
					categories: [{ name: "general", children: ["lobby"] }],
				},
				{
					idx: 2,
					user: BRIDGE,
					eventType: "space.roomy.space.updateSidebar.v1",
					categories: [{ name: "general", children: ["lobby"] }],
				},
				{
					idx: 3,
					user: ADMIN,
					eventType: "space.roomy.space.updateSidebar.v1",
					categories: [{ name: "general", children: [] }],
				},
			],
			BRIDGE,
		);
		const report = formatRepairReport(inspection({ analysis }), undefined, {
			applyRequested: true,
		});
		expect(analysis.status).toBe("edited");
		expect(report).toContain("not applied: `edited` is not restorable.");
	});

	test("surfaces an apply that failed after a clean read", () => {
		const report = formatRepairReport(
			inspection({ analysis: damagedAnalysis() }),
			undefined,
			{
				applyRequested: true,
				applyError: "the sidebar changed since the read; re-run before applying",
			},
		);
		expect(report).toContain(
			"not applied: the sidebar changed since the read; re-run before applying",
		);
	});

	test("surfaces a read that could not be confirmed", () => {
		const report = formatRepairReport(
			inspection({
				analysis: damagedAnalysis(),
				verified: false,
				error: "the read does not match the space's current sidebar",
			}),
			undefined,
			{ applyRequested: true },
		);
		expect(report).toContain(
			"not applied: the read does not match the space's current sidebar.",
		);
		expect(report).toContain(
			"error: the read does not match the space's current sidebar",
		);
	});

	test("does not claim a classification for a read that failed", () => {
		const report = formatRepairReport(
			inspection({ error: "connect ETIMEDOUT", verified: false }),
			undefined,
			{ applyRequested: true },
		);
		expect(report).toContain("no classification");
		expect(report).toContain("error: connect ETIMEDOUT");
		expect(report).not.toContain("not applied:");
	});
});

/** A sidebar write at `idx`, as the classifier reads one off the wire. */
function write(idx: number, children: string[] = ["01ROOM"]): SidebarWrite {
	return {
		idx,
		user: BRIDGE,
		eventType: "space.roomy.space.updateSidebar.v1",
		categories: [{ name: "General", children }],
	};
}

/** A drained read over a log holding `writes`. */
function history(
	writes: SidebarWrite[],
	over: Partial<SidebarHistory> = {},
): SidebarHistory {
	return { entries: 12, writes, drained: true, maxIdx: 11, resumes: 0, ...over };
}

describe("sameHistory", () => {
	test("agrees when both reads classified the same writes", () => {
		expect(sameHistory(history([write(3), write(9)]), history([write(3), write(9)]))).toBe(
			true,
		);
	});

	test("ignores the event count and the log's tail", () => {
		expect(
			sameHistory(
				history([write(3)]),
				history([write(3)], { entries: 40, maxIdx: 39, resumes: 2 }),
			),
		).toBe(true);
	});

	test("disagrees when a read lost a sidebar write", () => {
		expect(sameHistory(history([write(3), write(9)]), history([write(3)]))).toBe(false);
		expect(sameHistory(history([write(3)]), history([write(3), write(9)]))).toBe(false);
	});

	test("disagrees when the same index classified a different layout", () => {
		expect(sameHistory(history([write(9)]), history([write(9, [])]))).toBe(false);
	});
});

describe("readConsistentHistory", () => {
	/** A reader returning `reads` in order, counting its calls. */
	function reader(reads: SidebarHistory[]) {
		const calls: number[] = [];
		return {
			calls,
			read: async (): Promise<SidebarHistory> => {
				const next = reads[calls.length];
				if (!next) throw new Error("read past the scripted histories");
				calls.push(calls.length);
				return next;
			},
		};
	}

	test("returns the read that a second read agrees with", async () => {
		const { calls, read } = reader([
			history([write(3)]),
			history([write(3)], { entries: 30, maxIdx: 29 }),
		]);
		const result = await readConsistentHistory(SPACE, read);
		expect(calls).toHaveLength(2);
		expect(result.maxIdx).toBe(29);
	});

	test("accepts a later pair when one read lost a batch", async () => {
		const { calls, read } = reader([
			history([write(3), write(9)]),
			history([write(3)]),
			history([write(3), write(9)]),
		]);
		expect((await readConsistentHistory(SPACE, read)).writes).toHaveLength(2);
		expect(calls).toHaveLength(3);
	});

	test("accepts a pair that both saw a write added mid-read", async () => {
		const { calls, read } = reader([
			history([write(3)]),
			history([write(3), write(20)]),
			history([write(3), write(20)]),
		]);
		expect((await readConsistentHistory(SPACE, read)).writes).toHaveLength(2);
		expect(calls).toHaveLength(3);
	});

	test("retries a read whose backfill did not drain", async () => {
		const { calls, read } = reader([
			history([write(3)], { drained: false }),
			history([write(3)]),
			history([write(3)]),
		]);
		expect((await readConsistentHistory(SPACE, read)).drained).toBe(true);
		expect(calls).toHaveLength(3);
	});

	test("throws when no pair agrees", async () => {
		const { read } = reader([
			history([write(3)]),
			history([write(3), write(9)]),
			history([write(3), write(9), write(20)]),
		]);
		expect(readConsistentHistory(SPACE, read)).rejects.toThrow(
			"could not read a consistent history in 3 reads",
		);
	});

	test("names the reads whose backfill never drained", async () => {
		const { read } = reader([
			history([write(3)], { drained: false }),
			history([write(3), write(9)], { drained: false }),
			history([write(3), write(9), write(20)], { drained: false }),
		]);
		expect(readConsistentHistory(SPACE, read)).rejects.toThrow(
			"could not read a consistent history in 3 reads (3 did not finish)",
		);
	});
});
