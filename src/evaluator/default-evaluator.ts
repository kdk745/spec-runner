/**
 * DefaultEvaluator — aggregates six deterministic dimension scores into a
 * final DebateResult. No LLM calls. All scoring is grounded in structured
 * artifacts passed in via EvaluatorInput.
 *
 * Thresholds:
 *   >= 75  → accept
 *   50–74  → needs-revision
 *   < 50   → reject
 */

import type { Evaluator, EvaluatorInput } from "./index.js";
import {
  scoreCorrectness,
  scoreRuntimeStability,
  scoreReproducibility,
  scoreImplementationSimplicity,
  scoreDemoQuality,
  scoreEvidenceConfidence,
} from "./dimensions.js";
import type {
  DebateResult,
  EvaluationEvidence,
  ScoreDimension,
  Recommendation,
} from "../types/index.js";

interface WeightedDimension {
  name: string;
  weight: number;
  scorer: (input: EvaluatorInput, ev: EvaluationEvidence) => { score: number; rationale: string };
}

const RUBRIC: WeightedDimension[] = [
  { name: "correctness",               weight: 30, scorer: scoreCorrectness },
  { name: "runtime_stability",         weight: 20, scorer: scoreRuntimeStability },
  { name: "reproducibility",           weight: 15, scorer: scoreReproducibility },
  { name: "implementation_simplicity", weight: 15, scorer: scoreImplementationSimplicity },
  { name: "demo_quality",              weight: 10, scorer: scoreDemoQuality },
  { name: "evidence_confidence",       weight: 10, scorer: scoreEvidenceConfidence },
];

export class DefaultEvaluator implements Evaluator {
  async evaluate(input: EvaluatorInput): Promise<DebateResult> {
    const evidence = extractEvidence(input);
    const dimensions: ScoreDimension[] = [];

    for (const dim of RUBRIC) {
      const { score, rationale } = dim.scorer(input, evidence);
      dimensions.push({ name: dim.name, weight: dim.weight, score, rationale });
    }

    // Weighted aggregate
    const totalScore = Math.round(
      dimensions.reduce((sum, d) => sum + d.score * (d.weight / 100), 0)
    );

    const recommendation = deriveRecommendation(totalScore);
    const rationale = buildRationale(totalScore, recommendation, evidence, dimensions);

    return {
      runId: input.spec.id,
      totalScore,
      dimensions,
      recommendation,
      rationale,
      evidence,
      completedAt: new Date().toISOString(),
    };
  }
}

// ─── Evidence extraction ──────────────────────────────────────────────────────

function extractEvidence(input: EvaluatorInput): EvaluationEvidence {
  const { spec, build: worker, verification, recording } = input;

  const active = verification.checks.filter((c) => !c.skipped);
  const passed = active.filter((c) => c.passed);

  const runtimeCriteria = spec.successCriteria.filter((c) => c.checkKind === "runtime");
  const staticCriteria  = spec.successCriteria.filter((c) => c.checkKind === "static");

  const runtimeChecks = verification.checks.filter((c) =>
    !c.skipped && runtimeCriteria.some((rc) => rc.id === c.criterionId)
  );
  const staticChecks = verification.checks.filter((c) =>
    !c.skipped && staticCriteria.some((sc) => sc.id === c.criterionId)
  );

  // Server started = first demo log step has exitCode 0
  const serverStarted = (recording.demoLog[0]?.exitCode ?? 1) === 0;

  const totalBytes = worker.artifacts.reduce(
    (sum, a) => sum + (a.sizeBytes ?? 0), 0
  );

  return {
    criteriaTotal:           spec.successCriteria.length,
    criteriaActive:          active.length,
    criteriaPassed:          passed.length,
    runtimeCriteriaTotal:    runtimeCriteria.length,
    runtimeCriteriaPassed:   runtimeChecks.filter((c) => c.passed).length,
    staticCriteriaTotal:     staticCriteria.length,
    staticCriteriaPassed:    staticChecks.filter((c) => c.passed).length,
    serverStarted,
    videoRecorded:           !!recording.videoPath,
    screenshotCount:         recording.screenshotPaths.length,
    artifactCount:           worker.artifacts.length,
    totalArtifactBytes:      totalBytes,
    hasBuildManifest:        worker.artifacts.some((a) => a.path === "build-manifest.json"),
    buildSuccess:            worker.success,
    verificationState:       verification.state,
  };
}

// ─── Recommendation ───────────────────────────────────────────────────────────

function deriveRecommendation(totalScore: number): Recommendation {
  if (totalScore >= 75) return "accept";
  if (totalScore >= 50) return "needs-revision";
  return "reject";
}

// ─── Summary rationale ────────────────────────────────────────────────────────

function buildRationale(
  totalScore: number,
  recommendation: Recommendation,
  ev: EvaluationEvidence,
  dimensions: ScoreDimension[]
): string {
  const topDim = [...dimensions].sort((a, b) => b.score * b.weight - a.score * a.weight)[0];
  const bottomDim = [...dimensions].sort((a, b) => a.score * a.weight - b.score * b.weight)[0];

  const parts: string[] = [];

  parts.push(`Score ${totalScore}/100 → ${recommendation}.`);

  if (ev.criteriaActive > 0) {
    parts.push(`${ev.criteriaPassed}/${ev.criteriaActive} criteria passed.`);
  }

  if (ev.serverStarted) {
    parts.push("Server started.");
  } else {
    parts.push("Server did not start.");
  }

  if (topDim && topDim.score >= 70) {
    parts.push(`Strongest: ${topDim.name} (${topDim.score}).`);
  }
  if (bottomDim && bottomDim.score <= 30) {
    parts.push(`Weakest: ${bottomDim.name} (${bottomDim.score}).`);
  }

  return parts.join(" ");
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createEvaluator(): Evaluator {
  return new DefaultEvaluator();
}
