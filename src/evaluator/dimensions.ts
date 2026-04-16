/**
 * Dimension scorers for the evaluator.
 *
 * Each scorer takes EvaluatorInput and pre-extracted EvaluationEvidence,
 * returns a { score: 0–100, rationale: string }. All are synchronous.
 *
 * Weights must sum to 100:
 *   correctness              30
 *   runtime_stability        20
 *   reproducibility          15
 *   implementation_simplicity 15
 *   demo_quality             10
 *   evidence_confidence      10
 */

import type { EvaluatorInput } from "./index.js";
import type { EvaluationEvidence } from "../types/index.js";

interface Score {
  score: number;
  rationale: string;
}

// ─── 1. Correctness (30) ───────────────────────────────────────────────────────
// Fraction of non-skipped criteria that passed.

export function scoreCorrectness(
  _input: EvaluatorInput,
  ev: EvaluationEvidence
): Score {
  if (ev.criteriaActive === 0) {
    return { score: 0, rationale: "All criteria were skipped — no correctness evidence available." };
  }

  const score = Math.round((ev.criteriaPassed / ev.criteriaActive) * 100);

  const rationale =
    `${ev.criteriaPassed}/${ev.criteriaActive} active criteria passed` +
    (ev.criteriaTotal > ev.criteriaActive
      ? ` (${ev.criteriaTotal - ev.criteriaActive} skipped)`
      : "") +
    ".";

  return { score, rationale };
}

// ─── 2. Runtime stability (20) ────────────────────────────────────────────────
// Did the candidate behave correctly at runtime? Server start + runtime checks.

export function scoreRuntimeStability(
  _input: EvaluatorInput,
  ev: EvaluationEvidence
): Score {
  let score = 0;
  const notes: string[] = [];

  // Server started (40 pts)
  if (ev.serverStarted) {
    score += 40;
    notes.push("Server started successfully.");
  } else {
    notes.push("Server did not start.");
  }

  // Runtime checks (60 pts, proportional)
  if (ev.runtimeCriteriaTotal > 0) {
    const runtimeScore = Math.round(
      (ev.runtimeCriteriaPassed / ev.runtimeCriteriaTotal) * 60
    );
    score += runtimeScore;
    notes.push(
      `${ev.runtimeCriteriaPassed}/${ev.runtimeCriteriaTotal} runtime criteria passed.`
    );
  } else {
    // No runtime criteria — full marks for that portion if server started
    if (ev.serverStarted) score += 60;
    notes.push("No runtime criteria defined.");
  }

  return { score: Math.min(100, score), rationale: notes.join(" ") };
}

// ─── 3. Reproducibility (15) ──────────────────────────────────────────────────
// Can the result be reproduced? Consistent artifacts + server start + video.

export function scoreReproducibility(
  _input: EvaluatorInput,
  ev: EvaluationEvidence
): Score {
  let score = 0;
  const notes: string[] = [];

  // Worker produced artifacts (40 pts)
  if (ev.buildSuccess && ev.artifactCount > 0) {
    score += 40;
    notes.push(`Worker produced ${ev.artifactCount} artifact(s).`);
  } else {
    notes.push("Worker produced no artifacts.");
  }

  // Server started (means the output is actually runnable) (35 pts)
  if (ev.serverStarted) {
    score += 35;
    notes.push("Execution was reproducible (server started).");
  }

  // Video captured = strongest signal (25 pts)
  if (ev.videoRecorded) {
    score += 25;
    notes.push("Demo video captured.");
  } else if (ev.screenshotCount > 0) {
    score += 10;
    notes.push(`${ev.screenshotCount} screenshot(s) captured.`);
  }

  return { score: Math.min(100, score), rationale: notes.join(" ") };
}

// ─── 4. Implementation simplicity (15) ────────────────────────────────────────
// Is the output lean and well-structured? Penalise bloat and missing metadata.

export function scoreImplementationSimplicity(
  _input: EvaluatorInput,
  ev: EvaluationEvidence
): Score {
  if (ev.artifactCount === 0) {
    return { score: 0, rationale: "No files produced — nothing to evaluate." };
  }

  let score = 100;
  const deductions: string[] = [];

  // Ideal file count: 2–7 (including manifest/README)
  if (ev.artifactCount > 10) {
    score -= 20;
    deductions.push(`Too many files (${ev.artifactCount} > 10).`);
  } else if (ev.artifactCount > 7) {
    score -= 10;
    deductions.push(`High file count (${ev.artifactCount}).`);
  }

  // Total size limit: 100 KB
  const totalKB = Math.round(ev.totalArtifactBytes / 1024);
  if (ev.totalArtifactBytes > 200_000) {
    score -= 20;
    deductions.push(`Total size too large (${totalKB} KB > 200 KB).`);
  } else if (ev.totalArtifactBytes > 100_000) {
    score -= 10;
    deductions.push(`Total size elevated (${totalKB} KB > 100 KB).`);
  }

  // Structured metadata present
  if (!ev.hasBuildManifest) {
    score -= 10;
    deductions.push("No build-manifest.json — outputs are undeclared.");
  }

  const positives = [
    ev.hasBuildManifest ? "Build manifest present." : "",
    deductions.length === 0 ? `Clean output (${ev.artifactCount} files, ${totalKB} KB).` : "",
  ].filter(Boolean);

  const rationale = [...positives, ...deductions].join(" ") ||
    `${ev.artifactCount} files, ${totalKB} KB.`;

  return { score: Math.max(0, score), rationale };
}

// ─── 5. Demo quality (10) ─────────────────────────────────────────────────────
// Did the demo flow produce observable evidence?

export function scoreDemoQuality(
  _input: EvaluatorInput,
  ev: EvaluationEvidence
): Score {
  let score = 0;
  const notes: string[] = [];

  if (ev.serverStarted) {
    score += 40;
    notes.push("Server started.");
  }
  if (ev.videoRecorded) {
    score += 40;
    notes.push("Video recorded.");
  }
  if (ev.screenshotCount > 0) {
    score += Math.min(20, ev.screenshotCount * 10);
    notes.push(`${ev.screenshotCount} screenshot(s).`);
  }

  if (score === 0) {
    notes.push("No observable demo evidence.");
  }

  return { score: Math.min(100, score), rationale: notes.join(" ") };
}

// ─── 6. Evidence confidence (10) ──────────────────────────────────────────────
// Are the worker's claims supported by verification? Penalise contradictions.

export function scoreEvidenceConfidence(
  _input: EvaluatorInput,
  ev: EvaluationEvidence
): Score {
  const notes: string[] = [];
  let score: number;

  // Core signal: worker claim vs verification outcome
  if (ev.buildSuccess && ev.verificationState === "failed") {
    // Worker claimed success but independent verification found nothing working
    score = 15;
    notes.push("Worker reported success but all verification checks failed — claim is unsupported.");
  } else if (ev.buildSuccess && ev.verificationState === "partial") {
    score = 55;
    notes.push("Worker reported success; verification partially corroborates.");
  } else if (ev.buildSuccess && ev.verificationState === "passed") {
    score = 90;
    notes.push("Worker report confirmed by independent verification.");
  } else if (!ev.buildSuccess && ev.verificationState === "failed") {
    // Consistent: both report failure — no contradiction
    score = 60;
    notes.push("Worker and verifier agree: candidate did not meet criteria.");
  } else {
    score = 40;
    notes.push("Mixed signals between worker result and verification.");
  }

  // Build manifest adds traceability
  if (ev.hasBuildManifest) {
    score = Math.min(100, score + 10);
    notes.push("Build manifest adds output traceability.");
  }

  return { score, rationale: notes.join(" ") };
}
