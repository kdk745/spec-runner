/**
 * Workspace management interface.
 *
 * Each run gets a fully isolated directory at runs/<runId>/workspace/.
 * The workspace is created once and never renamed or shared across runs.
 */

import type { Artifact, RunId, Workspace } from "../types/index.js";

export interface WorkspaceManager {
  /**
   * Create a new isolated workspace directory for the given run.
   * Throws if the workspace already exists.
   */
  create(runId: RunId): Promise<Workspace>;

  /**
   * Resolve the workspace for an existing run.
   * Throws if the workspace does not exist.
   */
  get(runId: RunId): Promise<Workspace>;

  /**
   * List all artifacts currently present in the workspace.
   * Computes SHA-256 checksums for all files.
   */
  listArtifacts(workspace: Workspace): Promise<Artifact[]>;

  /**
   * Write a text file into the workspace.
   * Parent directories are created automatically.
   */
  writeFile(
    workspace: Workspace,
    relativePath: string,
    content: string
  ): Promise<Artifact>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export { createFsWorkspaceManager } from "./fs-manager.js";
