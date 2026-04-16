/**
 * Worker adapter interface.
 *
 * The worker layer is the only component permitted to produce artifacts.
 * All implementations must:
 * - Respect spec.workerConfig.timeoutMs (hard kill)
 * - Respect spec.workerConfig.maxTokenBudget (reject before exceeding)
 * - Write artifacts only inside workspace.rootPath
 * - Never call back into the orchestrator
 *
 * V1 ships one adapter: ClaudeWorkerAdapter.
 * Additional adapters (local shell, Docker sandbox) follow the same interface.
 */

import type { RunSpec, Workspace, BuildResult } from "../types/index.js";

export interface WorkerAdapter {
  /** Unique stable identifier, matched against RunSpec.workerConfig.adapterName */
  readonly name: string;

  /**
   * Execute the spec against the isolated workspace.
   * Must resolve (not reject) even on failure — return success:false with error set.
   */
  execute(spec: RunSpec, workspace: Workspace): Promise<BuildResult>;
}

// ─── Registry ────────────────────────────────────────────────────────────────

export interface WorkerRegistry {
  register(adapter: WorkerAdapter): void;
  get(adapterName: string): WorkerAdapter;
}

export { createWorkerRegistry } from "./registry.js";
export { createStubWorkerAdapter } from "./stub-adapter.js";
export { createClaudeWorkerAdapter } from "./claude-adapter.js";
