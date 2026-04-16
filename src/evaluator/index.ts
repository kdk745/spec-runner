/**
 * Evaluator interface.
 *
 * The evaluator synthesises all prior stage outputs into a scored recommendation.
 * It reads artifacts but never writes them. It is the only stage that may use
 * LLM judgment as part of scoring (via a bounded, structured prompt).
 *
 * Scoring dimensions (V1):
 *   - correctness    (weight 40): do artifacts satisfy success criteria?
 *   - completeness   (weight 25): are all required files/components present?
 *   - code_quality   (weight 20): static signals (syntax, structure, size)
 *   - demo_fidelity  (weight 15): did the demo script run cleanly?
 *
 * Final recommendation thresholds:
 *   >= 75  → accept
 *   50–74  → needs-revision
 *   < 50   → reject
 */

import type {
  RunSpec,
  BuildResult,
  VerificationResult,
  RecordingResult,
  DebateResult,
} from "../types/index.js";

export interface EvaluatorInput {
  spec: RunSpec;
  build: BuildResult;
  verification: VerificationResult;
  recording: RecordingResult;
}

export interface Evaluator {
  /**
   * Produce a scored evaluation and recommendation.
   * Must resolve (not reject).
   */
  evaluate(input: EvaluatorInput): Promise<DebateResult>;
}

// ─── Rubric ───────────────────────────────────────────────────────────────────

export interface RubricDimension {
  name: string;
  weight: number; // must sum to 100 across all dimensions
  scorer: DimensionScorer;
}

export type DimensionScorer = (input: EvaluatorInput) => Promise<{
  score: number;
  rationale: string;
}>;

// ─── Factory ─────────────────────────────────────────────────────────────────

export { createEvaluator } from "./default-evaluator.js";
