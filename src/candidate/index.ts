/**
 * Candidate management interface.
 *
 * A candidate is one execution attempt for a run. Each candidate gets its own
 * isolated workspace directory. V1 creates exactly one candidate per run.
 *
 * Disk layout:
 *   runs/<runId>/candidates/<candidateId>/
 *     ├── candidate.json   ← this record
 *     ├── result.json      ← WorkerResult (written after execution)
 *     └── workspace/       ← worker writes here exclusively
 */

import type { Candidate, RunId } from "../types/index.js";

export interface CandidateManager {
  /**
   * Create a new candidate for the given run.
   * Provisions the workspace directory on disk.
   * Throws if a candidate directory collision occurs.
   */
  create(runId: RunId, adapterName: string): Promise<Candidate>;

  /**
   * Load an existing candidate record from disk.
   */
  get(runId: RunId, candidateId: string): Promise<Candidate>;

  /**
   * Persist updated candidate state (e.g., status change).
   * Merges updatedAt automatically.
   */
  save(candidate: Candidate): Promise<void>;

  /**
   * List all candidates for a run, ordered by createdAt.
   */
  listForRun(runId: RunId): Promise<Candidate[]>;
}

export { createFsCandidateManager } from "./fs-manager.js";
