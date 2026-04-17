/**
 * buildSubmissionPayload — assembles the human-review package from PipelineResult.
 *
 * Resolution order for winner:
 *   uxDebate.finalWinner > uxEvaluation.recommendedWinner > first candidate
 *
 * Resolution order for ranking:
 *   uxDebate ranking (by finalWinner + evaluation scores) > uxEvaluation ranking > build order
 *
 * All IDs are kept for traceability but presented alongside plain labels.
 */

import { join } from "node:path";
import type {
  PipelineResult,
  CandidateRecord,
  SubmissionPayload,
  SubmissionCandidateSummary,
  SubmissionDebateTurn,
} from "../types/index.js";

// ─── Public API ───────────────────────────────────────────────────────────────

export function buildSubmissionPayload(
  result: PipelineResult,
  runsDir: string,
): SubmissionPayload {
  const { runId, spec, candidates, uxEvaluation, uxEvaluationB, uxDebate, totalDurationMs, completedAt } = result;

  // Determine winner candidateId
  const winnerId =
    uxDebate?.finalWinner ??
    uxEvaluation?.recommendedWinner ??
    candidates[0]?.candidateId ??
    "";

  // Build ranked list of candidateIds.
  // Use uxDebate ranking if available (derived from evalA + evalB combined scores),
  // otherwise fall back to evalA ranking, otherwise use build order.
  const rankedIds = deriveRankedIds(winnerId, candidates, uxEvaluation?.ranking, uxEvaluationB?.ranking);

  // Assemble per-candidate summaries
  const summaries = rankedIds.map((cid, idx) => {
    const cr = candidates.find((c) => c.candidateId === cid);
    if (!cr) {
      return placeholder(cid, idx + 1, runsDir, runId);
    }
    return buildCandidateSummary(cr, idx + 1, runsDir, runId, uxEvaluation?.ranking, uxEvaluationB?.ranking);
  });

  const winner = summaries[0]!;
  const ranking = summaries;

  // Debate block
  const debate = buildDebateBlock(uxDebate, uxEvaluation, uxEvaluationB, ranking);

  return {
    title: `Spec evaluation: ${spec.goal.slice(0, 100)}`,
    runId,
    specGoal: spec.goal,
    constraints: spec.constraints,
    successCriteria: spec.successCriteria.map((c) => ({
      kind: c.checkKind,
      description: c.description,
    })),
    winner,
    ranking,
    debate,
    evaluations: {
      A: {
        focus: "API correctness + CRUD completeness",
        recommendedWinner: uxEvaluation?.recommendedWinner ?? "(not evaluated)",
        tradeoffs: uxEvaluation?.tradeoffs ?? [],
      },
      B: {
        focus: "Response quality + UX consistency",
        recommendedWinner: uxEvaluationB?.recommendedWinner ?? "(not evaluated)",
        tradeoffs: uxEvaluationB?.tradeoffs ?? [],
      },
    },
    pipelineStats: {
      totalDurationMs,
      totalDuration: formatDuration(totalDurationMs),
      candidateCount: candidates.length,
      completedAt,
    },
  };
}

// ─── Ranking derivation ───────────────────────────────────────────────────────

function deriveRankedIds(
  winnerId: string,
  candidates: CandidateRecord[],
  rankingA: Array<{ candidateId: string; rank: number; score: number }> | undefined,
  rankingB: Array<{ candidateId: string; rank: number; score: number }> | undefined,
): string[] {
  const allIds = candidates.map((c) => c.candidateId);

  // Combined score from both evaluations
  if (rankingA && rankingB) {
    const scoreMap = new Map<string, number>();
    for (const a of rankingA) {
      scoreMap.set(a.candidateId, (scoreMap.get(a.candidateId) ?? 0) + a.score);
    }
    for (const b of rankingB) {
      scoreMap.set(b.candidateId, (scoreMap.get(b.candidateId) ?? 0) + b.score);
    }
    return [...allIds].sort((x, y) => {
      // Winner always first regardless of score tie
      if (x === winnerId) return -1;
      if (y === winnerId) return 1;
      return (scoreMap.get(y) ?? 0) - (scoreMap.get(x) ?? 0);
    });
  }

  // Single evaluation fallback
  const singleRanking = rankingA ?? rankingB;
  if (singleRanking) {
    const rankMap = new Map(singleRanking.map((a) => [a.candidateId, a.rank]));
    return [...allIds].sort((x, y) => (rankMap.get(x) ?? 99) - (rankMap.get(y) ?? 99));
  }

  // Build-order fallback — winner first
  return [winnerId, ...allIds.filter((id) => id !== winnerId)];
}

// ─── Candidate summary ────────────────────────────────────────────────────────

function buildCandidateSummary(
  cr: CandidateRecord,
  position: number,
  runsDir: string,
  runId: string,
  rankingA: Array<{ candidateId: string; rank: number; score: number; strengths: string[]; weaknesses: string[]; observedMoments: string[] }> | undefined,
  rankingB: Array<{ candidateId: string; rank: number; score: number }> | undefined,
): SubmissionCandidateSummary {
  const aEntry = rankingA?.find((a) => a.candidateId === cr.candidateId);
  const bEntry = rankingB?.find((b) => b.candidateId === cr.candidateId);

  const effectiveSV = cr.repairAttempt?.selfVerification ?? cr.selfVerification;
  const strengths    = aEntry?.strengths ?? [];
  const weaknesses   = aEntry?.weaknesses ?? [];
  const moments      = aEntry?.observedMoments ?? [];

  const summary = buildOneSentenceSummary(position, effectiveSV.passed, strengths, weaknesses);

  const workspacePath = join(runsDir, runId, "candidates", cr.candidateId, "workspace");
  const files = cr.build.artifacts.map((a) => a.path);

  return {
    label: `Candidate ${position}`,
    candidateId: cr.candidateId,
    position,
    summary,
    strengths,
    weaknesses,
    observedMoments: moments,
    selfVerificationPassed: effectiveSV.passed,
    ...(cr.recording.videoPath ? { videoPath: cr.recording.videoPath } : {}),
    workspacePath,
    files,
    buildDurationMs: cr.build.durationMs,
    scores: {
      evaluatorA: { score: aEntry?.score ?? 0, rank: aEntry?.rank ?? position },
      evaluatorB: { score: bEntry?.score ?? 0, rank: bEntry?.rank ?? position },
    },
  };
}

function placeholder(candidateId: string, position: number, runsDir: string, runId: string): SubmissionCandidateSummary {
  return {
    label: `Candidate ${position}`,
    candidateId,
    position,
    summary: "Candidate record unavailable.",
    strengths: [],
    weaknesses: [],
    observedMoments: [],
    selfVerificationPassed: false,
    workspacePath: join(runsDir, runId, "candidates", candidateId, "workspace"),
    files: [],
    buildDurationMs: 0,
    scores: { evaluatorA: { score: 0, rank: position }, evaluatorB: { score: 0, rank: position } },
  };
}

function buildOneSentenceSummary(
  position: number,
  selfVerPassed: boolean,
  strengths: string[],
  weaknesses: string[],
): string {
  if (position === 1) {
    const lead = strengths[0] ?? "strongest overall UX signal";
    return `Ranked first — ${lead}.`;
  }
  const gap = weaknesses[0] ?? "weaker UX signal than the winner";
  const sv  = selfVerPassed ? "" : " Self-verification did not pass.";
  return `Ranked ${ordinal(position)} — ${gap}.${sv}`;
}

function ordinal(n: number): string {
  if (n === 2) return "second";
  if (n === 3) return "third";
  return `${n}th`;
}

// ─── Debate block ─────────────────────────────────────────────────────────────

function buildDebateBlock(
  uxDebate: PipelineResult["uxDebate"],
  uxEvaluation: PipelineResult["uxEvaluation"],
  uxEvaluationB: PipelineResult["uxEvaluationB"],
  ranking: SubmissionCandidateSummary[],
): SubmissionPayload["debate"] {
  const evaluatorsAgreed =
    !!uxEvaluation && !!uxEvaluationB &&
    uxEvaluation.recommendedWinner === uxEvaluationB.recommendedWinner;

  if (!uxDebate) {
    // No debate ran — synthesize what we can from the evaluations
    return {
      evaluatorsAgreed,
      consensusPoints: [],
      disputedPoints: evaluatorsAgreed ? [] : [
        `Evaluator A recommended ${uxEvaluation?.recommendedWinner?.slice(0, 8) ?? "unknown"}, ` +
        `Evaluator B recommended ${uxEvaluationB?.recommendedWinner?.slice(0, 8) ?? "unknown"}.`,
      ],
      transcript: [],
      finalRationale: ranking[0]?.summary ?? "No debate was run.",
    };
  }

  const transcript: SubmissionDebateTurn[] = uxDebate.rounds.map((r) => ({
    round: r.roundIndex,
    evaluator: r.evaluatorId === "A"
      ? "Evaluator A (correctness)"
      : "Evaluator B (quality)",
    role: r.roundIndex <= 2 ? "Opening" : "Rebuttal",
    position:     r.position,
    evidenceRefs: r.evidenceRefs,
    concessions:  r.concessions,
  }));

  return {
    evaluatorsAgreed,
    consensusPoints: uxDebate.consensusPoints,
    disputedPoints:  uxDebate.disputedPoints,
    transcript,
    finalRationale: uxDebate.finalRationale,
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min === 0) return `${sec} sec`;
  return `${min} min ${sec} sec`;
}
