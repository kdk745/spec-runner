/**
 * UX Evaluator interface.
 *
 * Reviews all candidates' recording artifacts together and produces
 * an independent, ranked UX evaluation focused on observable behavior —
 * not code quality.
 *
 * Inputs:  spec + per-candidate frame index + api trace paths
 * Outputs: ranked assessments, tradeoffs, recommended winner
 *
 * V1 implementation: ClaudeUXEvaluator — loads key frames as base64,
 * builds a multimodal prompt, forces structured output via tool_use.
 */

import type { RunSpec, CandidateUXInput, UXEvaluation, UXDebateResult } from "../types/index.js";

export interface UXEvaluator {
  /**
   * Evaluate all candidates against each other.
   * Must resolve (not reject) — encode failures in returned result.
   * Candidates slice is ordered; their order does not imply ranking.
   */
  evaluate(spec: RunSpec, candidates: CandidateUXInput[]): Promise<UXEvaluation>;
}

export type { UXDebater } from "./debate.js";
export { createClaudeUXEvaluator } from "./claude-evaluator.js";
export { createClaudeUXDebater } from "./debate.js";
export { createBuilderDebater } from "./builder-debate.js";
