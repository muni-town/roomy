import type {
  Batch,
  MaterializationSummary,
  MaterializationWarnings,
} from "./types";
import type { StreamDid, Ulid } from "@roomy/sdk";

/**
 * Compute a summary of materialization results from a batch of applied events.
 * Counts events, statements, and timing information.
 */
export function computeMaterializationSummary(
  results: Batch.ApplyResult["results"],
  batchStartTime: number,
): MaterializationSummary {
  let appliedEvents = 0;
  let stashedEvents = 0;
  let errorEvents = 0;
  let totalStatements = 0;
  let successfulStatements = 0;
  let failedStatements = 0;

  for (const result of results) {
    if (result.result === "applied") {
      appliedEvents++;
      totalStatements += result.output.length;
      successfulStatements += result.output.filter((r) => r.type === "success").length;
      failedStatements += result.output.filter((r) => r.type === "error").length;
    } else if (result.result === "stashed") {
      stashedEvents++;
    } else if (result.result === "error") {
      errorEvents++;
    } else if (result.result === "appliedProfiles") {
      // Profile bundles are not events, so we count statements but not events
      totalStatements += result.output.length;
      successfulStatements += result.output.filter((r) => r.type === "success").length;
      failedStatements += result.output.filter((r) => r.type === "error").length;
    }
  }

  // totalEvents should only count actual events, not profile bundles
  const totalEvents = appliedEvents + stashedEvents + errorEvents;

  return {
    totalEvents,
    appliedEvents,
    stashedEvents,
    errorEvents,
    totalStatements,
    successfulStatements,
    failedStatements,
    durationMs: performance.now() - batchStartTime,
  };
}

/**
 * Compute warnings from materialization results.
 * Extracts stashed events and failed statements for reporting.
 */
export function computeMaterializationWarnings(
  results: Batch.ApplyResult["results"],
): MaterializationWarnings {
  const stashedEvents: Array<{ eventId: Ulid; dependsOn: Ulid[] }> = [];
  const failedStatements: Array<{ eventId: Ulid; statement: string; error: string }> = [];

  for (const result of results) {
    if (result.result === "stashed") {
      stashedEvents.push({ eventId: result.eventId, dependsOn: result.dependsOn });
    } else if (result.result === "applied" || result.result === "appliedProfiles") {
      for (const output of result.output) {
        if (output.type === "error") {
          failedStatements.push({
            eventId: result.result === "applied" ? result.eventId : ("profile" as Ulid),
            statement: output.statement.sql,
            error: output.message,
          });
        }
      }
    }
  }

  const warnings: MaterializationWarnings = {};
  if (stashedEvents.length > 0) warnings.stashedEvents = stashedEvents;
  if (failedStatements.length > 0) warnings.failedStatements = failedStatements;
  return warnings;
}

/**
 * Log materialization result with summary and warnings.
 * Used by the peer worker to provide visibility into event processing.
 */
export function logMaterializationResult(
  streamId: StreamDid,
  result: Batch.Statement | Batch.ApplyResult,
  spaceType: "personal" | "space",
): void {
  if (result.status !== "applied") {
    console.debug(`materialised (${spaceType}):`, { streamId, result });
    return;
  }

  const { summary, warnings } = result;

  // Log successful materialization with summary
  console.debug(`materialised (${spaceType}):`, {
    streamId,
    summary: {
      events: `${summary.appliedEvents}/${summary.totalEvents} applied`,
      stashed: summary.stashedEvents,
      errors: summary.errorEvents,
      statements: `${summary.successfulStatements}/${summary.totalStatements} successful`,
      duration: `${summary.durationMs.toFixed(2)}ms`,
    },
  });

  // Log warnings for issues
  if (warnings.stashedEvents?.length) {
    console.warn(`[BW] Stashed events waiting for dependencies:`, {
      streamId,
      count: warnings.stashedEvents.length,
      events: warnings.stashedEvents.map((e) => ({
        eventId: e.eventId,
        dependsOn: e.dependsOn,
      })),
    });
  }

  if (warnings.failedStatements?.length) {
    console.error(`[BW] Failed statements during materialization:`, {
      streamId,
      count: warnings.failedStatements.length,
      failures: warnings.failedStatements.map((f) => ({
        eventId: f.eventId,
        statement:
          f.statement.slice(0, 100) + (f.statement.length > 100 ? "..." : ""),
        error: f.error,
      })),
    });
  }

  if (warnings.failedEvents?.length) {
    console.error(`[BW] Failed events during materialization:`, {
      streamId,
      count: warnings.failedEvents.length,
      events: warnings.failedEvents,
    });
  }
}
