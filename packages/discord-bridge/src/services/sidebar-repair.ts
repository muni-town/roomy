/**
 * Repair of sidebar damage left by the one-shot structure sync.
 *
 * The sync (README, "Initial structure sync") appends a guild's categories to
 * the sidebar a bridged space already had, matching categories by exact name
 * and deciding each channel's placement from that channel alone. Merging that
 * way can duplicate what the space already had — see `sidebar-recovery.ts` for
 * the two shapes — and the repair undoes it by writing back the layout the
 * sync replaced.
 *
 * The space's history is read over the sync WebSocket as the bridge account:
 * a member's read, with no admin API and no access to the appserver's database
 * — nothing here reaches outside the bridge's own credentials and this
 * process. `/roomy-repair-sidebar` is the surface an operator uses.
 *
 * A revert only ever writes a layout some write in the log already contained,
 * and only when the classification is `restorable`: the sync's write is the
 * space's latest sidebar write, the write it replaced is in the log, that
 * write's merge duplicated a header or a room placement, and the read matched
 * the space's current sidebar. Everything else is reported and left alone — in
 * particular a space whose members have edited the sidebar since the sync is
 * theirs, not the bridge's to overwrite.
 *
 * The log is read over a live connection, so a sidebar write landing between
 * that read and the re-check is caught by the re-check (`getMetadata` is
 * re-read immediately before writing). Do not repair a space whose sidebar is
 * being edited at that moment.
 *
 * A backfill is not a reliable full-log reader. On a busy space the appserver
 * drops whole batches while reporting the backfill drained, which is invisible
 * in the frames received, so one read cannot be trusted to have seen every
 * write. A read therefore only counts once a second read classifies the same
 * writes; see {@link readConsistentHistory}.
 */

import { sync, transport } from "@roomy-space/sdk";
import { APPSERVER_WS_URL, ATPROTO_BRIDGE_DID } from "../env.ts";
import { createLogger } from "../logger.ts";
import {
	type SidebarCategoryView,
	type SidebarWrite,
	type StreamEventEntry,
	type SyncAnalysis,
	analyzeStructureSync,
	isSidebarEvent,
	parseSidebarWrite,
	restoreEvent,
	sameLayout,
	viewMatchesWrite,
} from "./sidebar-recovery.ts";

const log = createLogger("sidebar-repair");

/** How long a space's backfill may take before the read is abandoned. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * How long a backfill may go without a frame before the read resumes it.
 *
 * The server pushes backfill batches in a loop and marks a batch `hasMore`
 * when it was full. A log whose length is an exact multiple of the batch size
 * therefore ends on `hasMore: true` and sends nothing else — the loop's next
 * read comes back empty and it stops without a terminal frame. A quiet spell
 * longer than this is either that end or a stall; the read resumes from the
 * last event it saw, which the server ignores in the former case and continues
 * from in the latter.
 */
const BACKFILL_IDLE_MS = 3_000;

/** WebSocket connect (ticket fetch + handshake) budget. */
const CONNECT_TIMEOUT_MS = 15_000;

/** Reads after the first that a consistent history may take to agree. */
const READ_ATTEMPTS = 2;

/** Resumes a single read may use before it gives up on the backfill. */
const MAX_RESUMES = 8;

/** A scheduled timer, as `setTimeout` returns it. */
type Timer = ReturnType<typeof setTimeout>;

/** One space's scanned event log, in the order the appserver delivered it. */
export interface SidebarHistory {
	/** Events accepted, counted once each. */
	entries: number;
	/** Sidebar writes among them, in log order. */
	writes: SidebarWrite[];
	/** The appserver reported the backfill drained (`hasMore: false`). */
	drained: boolean;
	/** Highest event index seen, or -1 for an empty log. */
	maxIdx: number;
	/** Times a stalled backfill was resumed from the last event seen. */
	resumes: number;
}

/** What one space's read and classification found. */
export interface SidebarInspection {
	spaceDid: string;
	/** Events scanned in the space's event log. */
	events: number;
	/** Sidebar writes among them. */
	writes: number;
	analysis?: SyncAnalysis;
	/** The read's latest write matched the space's current sidebar. */
	verified: boolean;
	/** Set when the read failed or could not be confirmed against the space. */
	error?: string;
}

/** What a revert did. */
export interface RepairOutcome {
	/** Event index of the layout that was written back. */
	restoredFrom: number;
	/** The space showed that layout when the write returned. */
	verified: boolean;
}

/**
 * Read one space's sidebar history, classify it, and confirm the read.
 *
 * Never throws: a failed read comes back as an inspection carrying `error`.
 */
export async function inspectSidebar(
	xrpc: transport.DirectXrpcClient,
	spaceDid: string,
	opts: { timeoutMs?: number } = {},
): Promise<SidebarInspection> {
	const inspection: SidebarInspection = {
		spaceDid,
		events: 0,
		writes: 0,
		verified: false,
	};
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	try {
		const history = await readConsistentHistory(spaceDid, (did) =>
			readSidebarHistory(xrpc, did, timeoutMs),
		);
		inspection.events = history.entries;
		inspection.writes = history.writes.length;

		const analysis = analyzeStructureSync(history.writes, ATPROTO_BRIDGE_DID());
		inspection.analysis = analysis;

		const current = await readCurrentSidebar(xrpc, spaceDid);
		inspection.verified =
			analysis.currentWrite === undefined
				? current.length === 0
				: viewMatchesWrite(analysis.currentWrite.categories, current);
		if (!inspection.verified) {
			inspection.error =
				"the read does not match the space's current sidebar" +
				(history.entries === 0
					? ": the backfill delivered no events"
					: " (incomplete backfill, or the sidebar changed while reading)");
			log.warn(`${spaceDid}: ${inspection.error}`);
		}
	} catch (err) {
		inspection.error = describe(err);
		log.warn(`${spaceDid}: read failed: ${inspection.error}`);
	}
	return inspection;
}

/**
 * Read a space until two reads agree on its sidebar writes.
 *
 * The appserver can drop whole backfill batches on a busy space while still
 * reporting the backfill drained, and the frames that did arrive carry no trace
 * of the ones that did not. Two reads that classify the same writes are
 * evidence the classification saw the log: a lost batch holding a sidebar write
 * would show up as a write the other read does not have.
 *
 * Any pair counts, not just neighbours: one read may lose a batch while another
 * sees a write a space member added in between. A read whose backfill never
 * drained cannot agree with anything and is retried. Throws when no pair
 * agrees, or when every read failed to drain. `read` is injected so the retry
 * policy is testable without a connection.
 */
export async function readConsistentHistory(
	spaceDid: string,
	read: (spaceDid: string) => Promise<SidebarHistory>,
	attempts: number = READ_ATTEMPTS,
): Promise<SidebarHistory> {
	const drained: SidebarHistory[] = [];
	let undrained = 0;
	for (let attempt = 0; attempt <= attempts; attempt += 1) {
		const history = await read(spaceDid);
		if (!history.drained) {
			undrained += 1;
			continue;
		}
		if (drained.some((earlier) => sameHistory(earlier, history))) return history;
		drained.push(history);
	}
	throw new Error(
		`could not read a consistent history in ${attempts + 1} reads` +
			(undrained > 0 ? ` (${undrained} did not finish)` : ""),
	);
}

/**
 * Whether two reads classified the same sidebar writes.
 *
 * Only the writes matter: they are all the classification reads, so a pair that
 * agrees on them proves neither read lost one. Event counts and the log's tail
 * are left out — a live space appends events between reads.
 */
export function sameHistory(a: SidebarHistory, b: SidebarHistory): boolean {
	if (a.writes.length !== b.writes.length) return false;
	return a.writes.every((write, i) => {
		const other = b.writes[i];
		return (
			other !== undefined &&
			write.idx === other.idx &&
			write.eventType === other.eventType &&
			write.user === other.user &&
			sameLayout(write.categories, other.categories)
		);
	});
}

/**
 * Write the pre-sync layout back and report whether the space shows it.
 *
 * Throws when the analysis carries no pre-sync layout, or when the space's
 * sidebar moved between the inspection and this call — the revert is only
 * correct while the layout the read saw as current is still the current one.
 */
export async function applySidebarRestore(
	xrpc: transport.DirectXrpcClient,
	spaceDid: string,
	analysis: SyncAnalysis,
): Promise<RepairOutcome> {
	const previous = analysis.preSyncWrite;
	const latest = analysis.currentWrite;
	if (!previous || !latest) {
		throw new Error(`nothing to restore: ${analysis.status} (${analysis.reason})`);
	}

	const current = await readCurrentSidebar(xrpc, spaceDid);
	if (!viewMatchesWrite(latest.categories, current)) {
		throw new Error("the sidebar changed since the read; re-run before applying");
	}

	await xrpc.procedure("space.roomy.space.sendEvents", {
		spaceId: spaceDid,
		events: [restoreEvent(analysis)],
	});
	log.info(
		`${spaceDid}: restored the sidebar layout from event idx ${previous.idx}`,
	);

	const after = await readCurrentSidebar(xrpc, spaceDid);
	return {
		restoredFrom: previous.idx,
		verified: viewMatchesWrite(previous.categories, after),
	};
}

/**
 * The operator-facing report for one space, as Discord markdown.
 *
 * States what the classification found and, when the run asked to apply,
 * either what was written or why nothing was.
 */
export function formatRepairReport(
	inspection: SidebarInspection,
	outcome?: RepairOutcome,
	options: { applyRequested?: boolean; applyError?: string } = {},
): string {
	const lines: string[] = [`**\`${inspection.spaceDid}\`**`];
	if (inspection.analysis) {
		lines.push(`${inspection.analysis.status} — ${inspection.analysis.reason}`);
	} else {
		lines.push("no classification");
	}
	lines.push(
		`read ${inspection.events} event(s), ${inspection.writes} sidebar write(s)` +
			(inspection.verified ? ", verified against the current sidebar" : ""),
	);

	const previous = inspection.analysis?.preSyncWrite;
	if (previous) {
		lines.push(
			`restore target: event idx ${previous.idx} — ${describeLayout(previous.categories)}`,
		);
	}

	if (outcome) {
		lines.push(
			outcome.verified
				? `applied: restored the layout from event idx ${outcome.restoredFrom}, and the space shows it.`
				: `applied: wrote the layout from event idx ${outcome.restoredFrom}, but the space does not show it yet.`,
		);
	} else if (options.applyError) {
		lines.push(`not applied: ${options.applyError}`);
	} else if (options.applyRequested && inspection.analysis) {
		lines.push(
			inspection.analysis.status === "restorable"
				? "not applied: the read does not match the space's current sidebar."
				: `not applied: \`${inspection.analysis.status}\` is not restorable.`,
		);
	}

	if (inspection.error) lines.push(`error: ${inspection.error}`);
	return lines.join("\n");
}

/**
 * Read a space's full event history over the sync WebSocket.
 *
 * A backfill that goes quiet for {@link BACKFILL_IDLE_MS} is resumed from the
 * last event seen, which both continues a stalled read and refills a batch the
 * connection missed while it was quiet. Reconnect stays disabled: the SDK's own
 * reconnect replays every tracked topic at `cursor: -1`, restarting the
 * backfill underneath the read. The deadline bounds the whole read.
 *
 * `drained` is set only by a terminal frame (`hasMore: false`); a read that
 * ends on the resume cap or the deadline returns with `drained: false`, which
 * {@link readConsistentHistory} treats as a failure.
 */
async function readSidebarHistory(
	xrpc: transport.DirectXrpcClient,
	spaceDid: string,
	timeoutMs: number,
): Promise<SidebarHistory> {
	const writes: SidebarWrite[] = [];
	/** Event indices accepted, so a resumed batch cannot be counted twice. */
	const seen = new Set<number>();
	let entries = 0;
	let maxIdx = -1;
	let drained = false;
	let resumes = 0;

	const connection = new sync.SyncConnection({
		fetchTicket: async () => {
			const { ticket } = await xrpc.procedure(
				"space.roomy.auth.getConnectionTicket",
				{},
			);
			return ticket;
		},
		wsUrl: APPSERVER_WS_URL(),
		connectTimeoutMs: CONNECT_TIMEOUT_MS,
		maxReconnectAttempts: 0,
	});

	try {
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let deadline: Timer | undefined;
			let idle: Timer | undefined;
			const settle = (err?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				clearTimeout(idle);
				if (err) reject(err);
				else resolve();
			};
			// Re-subscribe once nothing has arrived for BACKFILL_IDLE_MS. Armed on
			// open as well, so a log that delivers no frame at all — an empty
			// space, or a connection that never subscribed — ends the read instead
			// of waiting out the deadline.
			const armIdle = (): void => {
				if (idle !== undefined) clearTimeout(idle);
				idle = setTimeout(() => {
					if (resumes >= MAX_RESUMES) {
						settle(
							new Error(`the backfill stalled ${resumes} times without finishing`),
						);
						return;
					}
					resumes += 1;
					log.debug(`${spaceDid}: resuming the backfill from idx ${maxIdx}`);
					connection.subscribe({ kind: "stream", id: spaceDid, cursor: maxIdx });
					armIdle();
				}, BACKFILL_IDLE_MS);
			};
			deadline = setTimeout(
				() => settle(new Error(`no completed backfill within ${timeoutMs}ms`)),
				timeoutMs,
			);

			connection.onOpen(() => armIdle());
			connection.onError((err) =>
				settle(new Error(`sync connection error: ${describe(err)}`)),
			);
			connection.onFrame((frame) => {
				if (settled) return;
				const body = frame.body as { events?: unknown; hasMore?: unknown };
				if (!Array.isArray(body.events)) return;

				try {
					for (const entry of body.events as StreamEventEntry[]) {
						const idx = typeof entry.idx === "number" ? entry.idx : undefined;
						if (idx !== undefined) {
							if (seen.has(idx)) continue;
							seen.add(idx);
							if (idx > maxIdx) maxIdx = idx;
						}
						entries += 1;
						if (!isSidebarEvent(entry.payload)) continue;
						const write = parseSidebarWrite(entry);
						if (write) writes.push(write);
					}
				} catch (err) {
					settle(err instanceof Error ? err : new Error(String(err)));
					return;
				}
				if (body.hasMore === false) {
					drained = true;
					settle();
					return;
				}
				armIdle();
			});

			// cursor -1: backfill the whole log.
			connection.subscribe({ kind: "stream", id: spaceDid, cursor: -1 });
			connection
				.connect()
				.catch((err) => settle(err instanceof Error ? err : new Error(String(err))));
		});
	} finally {
		connection.close();
	}

	return { entries, writes, drained, maxIdx, resumes };
}

/** The space's current sidebar, as the layout a write would have left. */
async function readCurrentSidebar(
	xrpc: transport.DirectXrpcClient,
	spaceDid: string,
): Promise<SidebarCategoryView[]> {
	const response = await xrpc.query("space.roomy.space.getMetadata", {
		spaceId: spaceDid,
	});
	const meta = response as unknown as {
		sidebar: {
			categories: Array<{
				id?: string;
				name: string;
				channels: Array<{ id: string }>;
			}>;
		};
	};
	return (meta.sidebar?.categories ?? []).map((category) => ({
		...(category.id ? { id: category.id } : {}),
		name: category.name,
		children: category.channels.map((channel) => channel.id),
	}));
}

/** Categories with their room counts, capped so a report stays readable. */
function describeLayout(categories: SidebarCategoryView[]): string {
	if (categories.length === 0) return "an empty sidebar";
	const layout = categories
		.map((category) => `${category.name} (${category.children.length})`)
		.join(", ");
	return layout.length <= 400 ? layout : `${layout.slice(0, 400)}…`;
}

function describe(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
