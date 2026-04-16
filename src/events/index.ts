/**
 * Append-only event log interface.
 *
 * V1 persistence: newline-delimited JSON (JSONL) at runs/<runId>/events.jsonl.
 * Events are never updated or deleted. Reads always scan from the beginning.
 */

import type { RunEvent, RunId, EventKind } from "../types/index.js";

export interface EventLog {
  /**
   * Append a single event. Must never overwrite existing records.
   * Returns the persisted event (with id and timestamp populated if absent).
   */
  append<P extends Record<string, unknown>>(
    event: Omit<RunEvent<P>, "id" | "timestamp">
  ): Promise<RunEvent<P>>;

  /**
   * Read all events for a run in insertion order.
   */
  readAll(runId: RunId): Promise<RunEvent[]>;

  /**
   * Read events of a specific kind for a run, in insertion order.
   */
  readByKind(runId: RunId, kind: EventKind): Promise<RunEvent[]>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export { createFileEventLog } from "./file-log.js";
