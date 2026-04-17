/**
 * Orchestrator — the single pipeline coordinator.
 *
 * Responsibilities:
 * 1. Convert user prompt → locked RunSpec
 * 2. Provision an isolated workspace
 * 3. Run worker adapter
 * 4. Run verifier (independently, reads-only)
 * 5. Run recorder
 * 6. Run evaluator
 * 7. Persist PipelineResult and return it
 *
 * The orchestrator owns the event log. Every stage transition emits an event
 * before and after execution. Stage implementations never touch the event log.
 *
 * Error handling: stage failures are encoded in stage result types (success:false).
 * The pipeline always runs to completion unless workspace creation fails.
 */

import type {
  RunSpec,
  PipelineResult,
  RunId,
} from "../types/index.js";
import type { EventLog } from "../events/index.js";
import type { WorkspaceManager } from "../workspace/index.js";
import type { WorkerRegistry } from "../worker/adapter.js";
import type { Verifier } from "../verifier/index.js";
import type { Recorder } from "../recorder/index.js";
import type { Evaluator } from "../evaluator/index.js";
import type { EnvironmentManager } from "../environment/index.js";
import type { UXEvaluator, UXDebater } from "../ux-evaluator/index.js";
import type { Submitter } from "../submitter/index.js";

// ─── Spec Builder ─────────────────────────────────────────────────────────────

export interface SpecBuilderOptions {
  /** API key for the LLM call that parses the prompt */
  llmApiKey: string;
  defaultWorkerConfig?: Partial<RunSpec["workerConfig"]>;
}

export interface SpecBuilder {
  /**
   * Parse a user prompt into a locked RunSpec.
   * The spec is written to disk before this resolves.
   */
  build(prompt: string): Promise<RunSpec>;
}

/**
 * TODO: implement in src/orchestrator/spec-builder.ts
 */
export declare function createSpecBuilder(
  runsDir: string,
  options: SpecBuilderOptions
): SpecBuilder;

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export interface OrchestratorConfig {
  runsDir: string;
  events: EventLog;
  workspace: WorkspaceManager;
  workers: WorkerRegistry;
  verifier: Verifier;
  recorder: Recorder;
  evaluator: Evaluator;
  specBuilder: SpecBuilder;
  /** When provided, each candidate runs in a managed compute environment (e.g. Docker). */
  environmentManager?: EnvironmentManager;
  /** Primary UX evaluator — correctness + CRUD completeness focus. */
  uxEvaluator?: UXEvaluator;
  /** Secondary UX evaluator — response quality + consistency focus. Required for debate. */
  uxEvaluatorB?: UXEvaluator;
  /** Debate moderator — runs after both evaluations, produces bounded transcript + final winner. */
  uxDebater?: UXDebater;
  /** Submitter — sends the completed payload for human review. Stub writes to disk; swap for real destination. */
  submitter?: Submitter;
}

export interface Orchestrator {
  /**
   * Run the full pipeline for a user prompt.
   * Returns the complete PipelineResult written to runs/<runId>/result.json.
   */
  run(prompt: string): Promise<PipelineResult>;

  /**
   * Replay an existing run from a locked spec (skips spec building).
   * Useful for re-running a candidate with a different worker adapter.
   */
  rerun(runId: RunId): Promise<PipelineResult>;
}

export { createOrchestrator } from "./pipeline.js";
