/**
 * Environment abstraction — isolated compute context for one candidate.
 *
 * Lifecycle:
 *   provision() → status: provisioning → ready
 *   activate()  → status: running
 *   release()   → status: teardown_requested → terminated
 *
 * Backends:
 *   "local-process" — no isolation (V0 fallback, environmentManager absent)
 *   "docker"        — one container per candidate, workspace bind-mounted
 *
 * Execution helpers:
 *   getExecFn()         → ExecFn routed through `docker exec` (or undefined)
 *   getSpawnServerFn()  → ServerSpawnFn that starts a background server in the
 *                         container and exposes it on a mapped host port
 */

import type { RunId, Environment, EnvironmentConfig, ExecFn, ServerSpawnFn } from "../types/index.js";

export type { ExecFn, ServerSpawnFn };

export interface EnvironmentManager {
  /**
   * Allocate a new environment for a candidate.
   * Creates the workspace directory. Returns environment in "ready" state.
   * Must resolve (not reject) — encode failures in returned status field.
   */
  provision(
    runId: RunId,
    candidateId: string,
    config: EnvironmentConfig
  ): Promise<Environment>;

  /** Transition to "running" when a stage begins executing. */
  activate(env: Environment): Promise<Environment>;

  /** Transition to "teardown_requested" then "terminated". Cleans up resources. */
  release(env: Environment): Promise<Environment>;

  /** Load a previously provisioned environment by ID. */
  get(environmentId: string): Promise<Environment | null>;

  /**
   * Returns an ExecFn that routes commands through this environment.
   * Returns undefined for local-process environments (callers fall back to spawn).
   */
  getExecFn(env: Environment): ExecFn | undefined;

  /**
   * Returns a ServerSpawnFn that starts a long-running process inside the environment.
   * Returns undefined for local-process environments (callers use spawnServer directly).
   */
  getSpawnServerFn(env: Environment): ServerSpawnFn | undefined;
}

// ─── Configs ──────────────────────────────────────────────────────────────────

export const DEFAULT_ENVIRONMENT_CONFIG: EnvironmentConfig = {
  isolationType: "local-process",
};

export const DOCKER_ENVIRONMENT_CONFIG: EnvironmentConfig = {
  isolationType: "docker",
};

// ─── Re-exports ───────────────────────────────────────────────────────────────

export { DockerEnvironmentManager, createDockerEnvironmentManager } from "./docker-manager.js";
