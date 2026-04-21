/**
 * Pipeline orchestrator — runs NUM_CANDIDATES agents sequentially against the
 * same locked spec, collects their results, and picks the best recommendation.
 *
 * Each candidate gets its own isolated workspace under runs/<runId>/candidates/.
 * All stages always run per candidate; failures are encoded in result types.
 *
 * Writes runs/<runId>/result.json on completion.
 * Emits run.completed or run.failed as the final event.
 */

const NUM_CANDIDATES = 3;

/**
 * Per-candidate style hints injected into the build prompt.
 * Each hint nudges the agent toward a genuinely different design approach
 * so evaluators have meaningful differences to debate.
 */
const CANDIDATE_STYLE_HINTS: [string, string, string] = [
  // Candidate 1 — minimalist/functional
  "Design philosophy: minimalist and functional. Use the fewest UI elements possible. " +
  "Monochrome palette with a single accent color. No animations or gradients. " +
  "Show only what the user needs to act on. Prioritise clarity over decoration.",

  // Candidate 2 — visual/polished
  "Design philosophy: visual and polished. Use a modern colour palette, smooth CSS " +
  "transitions, and micro-interactions (e.g. the strength bar animates on change). " +
  "Make it feel like a finished product — rounded corners, subtle shadows, icon checkmarks.",

  // Candidate 3 — informative/power-user
  "Design philosophy: informative and developer-focused. Maximise feedback density — " +
  "show which specific criteria are met/unmet with clear labels, display a numeric " +
  "strength score (0–100) alongside the tier label, and show a brief tip for the " +
  "weakest unmet criterion. Prioritise information over decoration.",
];

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineResult, CandidateRecord, RunSpec, CandidateUXInput, UXEvaluation, UXDebateResult, SubmissionResult } from "../types/index.js";
import { buildSubmissionPayload } from "../submitter/index.js";
import type { OrchestratorConfig, Orchestrator } from "./index.js";
import { createFsCandidateManager } from "../candidate/index.js";
import { runCandidate } from "./candidate-runner.js";
import { log, logStage } from "../logger.js";

export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  const { runsDir, events, workers, verifier, recorder, evaluator, uxEvaluator, uxEvaluatorB, uxDebater, submitter, specBuilder, environmentManager } = config;

  // Core: run the pipeline for an already-locked spec.
  async function execSpec(spec: RunSpec, pipelineStartedAt: number): Promise<PipelineResult> {
    log("arena", `Starting run ${spec.id.slice(0, 8)} — "${spec.goal.slice(0, 70)}"`);
    const candidates = createFsCandidateManager(runsDir);

    let pipelineResult: PipelineResult;

    try {
      const candidateRecords: CandidateRecord[] = [];
      const BASE_RECORDING_PORT = 3100; // well above 3000 to avoid collision with app servers
      const deps = {
        runsDir, events, candidates, workers, verifier, recorder, evaluator,
        ...(environmentManager ? { environmentManager } : {}),
      };

      // Launch all candidates concurrently; each has isolated workspace + environment.
      // Promise.allSettled ensures one failure never cancels the others.
      logStage("build", `${NUM_CANDIDATES} candidates in parallel`);
      log("arena", `Launching ${NUM_CANDIDATES} candidates in parallel`);
      const settled = await Promise.allSettled(
        Array.from({ length: NUM_CANDIDATES }, (_, i) => {
          log("arena", `Candidate ${i + 1}/${NUM_CANDIDATES} starting`);
          // Inject per-candidate style hint so each agent makes genuinely different choices
          const candidateSpec: RunSpec = {
            ...spec,
            workerConfig: {
              ...spec.workerConfig,
              options: { ...spec.workerConfig.options, styleHint: CANDIDATE_STYLE_HINTS[i] },
            },
          };
          // Each candidate gets a unique port so parallel python static servers don't collide
          const candidateDeps = { ...deps, recordingPort: BASE_RECORDING_PORT + i };
          // Stagger starts by 3s to reduce simultaneous API burst / rate-limit risk
          return new Promise<Awaited<ReturnType<typeof runCandidate>>>((resolve, reject) => {
            setTimeout(() => runCandidate(candidateSpec, candidateDeps).then(resolve, reject), i * 3000);
          });
        })
      );

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i]!;
        if (result.status === "fulfilled") {
          const { candidate, build, verification, selfVerification, repairAttempt, escalation, recording, debate } = result.value;
          candidateRecords.push({
            candidateId: candidate.id,
            build, verification, selfVerification,
            ...(repairAttempt ? { repairAttempt } : {}),
            ...(escalation    ? { escalation }    : {}),
            recording, debate,
          });
          log("arena", `Candidate ${i + 1}/${NUM_CANDIDATES} done — ${debate.totalScore}/100 → ${debate.recommendation}`);
        } else {
          // Candidate failed hard (workspace creation or unrecoverable error).
          // Log and skip — remaining candidates still contribute to the result.
          log("arena", `Candidate ${i + 1}/${NUM_CANDIDATES} FAILED — ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
        }
      }

      if (candidateRecords.length === 0) {
        throw new Error("All candidates failed — no results to evaluate.");
      }

      // ── UX evaluations ───────────────────────────────────────────────────────
      logStage("evaluate", `${candidateRecords.length} candidates`);
      const uxInputs: CandidateUXInput[] = candidateRecords.map((cr, i) => {
        const effectiveSelfVerification = cr.repairAttempt?.selfVerification ?? cr.selfVerification;
        return {
          candidateId: cr.candidateId,
          selfVerificationPassed: effectiveSelfVerification.passed,
          ...(cr.recording.tracePath      ? { tracePath: cr.recording.tracePath }           : {}),
          ...(cr.recording.frameIndexPath ? { frameIndexPath: cr.recording.frameIndexPath } : {}),
          ...(CANDIDATE_STYLE_HINTS[i]    ? { styleHint: CANDIDATE_STYLE_HINTS[i] }         : {}),
        };
      });

      let uxEvaluation: UXEvaluation | undefined;
      if (uxEvaluator) {
        await events.append({ runId: spec.id, kind: "ux.review.started", payload: { evaluator: "A", candidateCount: candidateRecords.length } });
        log("arena", `UX evaluation A starting — ${candidateRecords.length} candidates`);
        uxEvaluation = await uxEvaluator.evaluate(spec, uxInputs);
        await writeFile(join(runsDir, spec.id, "ux-evaluation.json"), JSON.stringify(uxEvaluation, null, 2), "utf8");
        log("arena", `UX evaluation A complete — winner: ${uxEvaluation.recommendedWinner}`);
        await events.append({ runId: spec.id, kind: "ux.review.completed", payload: { evaluator: "A", recommendedWinner: uxEvaluation.recommendedWinner } });
      }

      let uxEvaluationB: UXEvaluation | undefined;
      if (uxEvaluatorB) {
        await events.append({ runId: spec.id, kind: "ux.review.started", payload: { evaluator: "B", candidateCount: candidateRecords.length } });
        log("arena", `UX evaluation B starting — ${candidateRecords.length} candidates`);
        uxEvaluationB = await uxEvaluatorB.evaluate(spec, uxInputs);
        await writeFile(join(runsDir, spec.id, "ux-evaluation-b.json"), JSON.stringify(uxEvaluationB, null, 2), "utf8");
        log("arena", `UX evaluation B complete — winner: ${uxEvaluationB.recommendedWinner}`);
        await events.append({ runId: spec.id, kind: "ux.review.completed", payload: { evaluator: "B", recommendedWinner: uxEvaluationB.recommendedWinner } });
      }

      let uxDebate: UXDebateResult | undefined;
      if (uxDebater && uxEvaluation && uxEvaluationB) {
        logStage("debate", "4-round structured transcript");
        await events.append({ runId: spec.id, kind: "ux.debate.started", payload: { rounds: 4 } });
        log("arena", `UX debate starting`);
        uxDebate = await uxDebater.debate(spec, uxEvaluation, uxEvaluationB, uxInputs);
        await writeFile(join(runsDir, spec.id, "ux-debate.json"), JSON.stringify(uxDebate, null, 2), "utf8");
        log("arena", `UX debate complete — final winner: ${uxDebate.finalWinner}`);
        await events.append({ runId: spec.id, kind: "ux.debate.completed", payload: { finalWinner: uxDebate.finalWinner, rounds: uxDebate.rounds.length } });
      }

      // ── Submit stage ─────────────────────────────────────────────────────────
      // Build the payload now (before pipelineResult) so it can reference all UX outputs.
      // pipelineResult is passed after construction to include submission in the result.
      let submission: SubmissionResult | undefined;
      if (submitter) {
        logStage("submit");
        await events.append({ runId: spec.id, kind: "submit.started", payload: { candidateCount: candidateRecords.length } });
        log("arena", `Building submission payload`);

        // Assemble a partial PipelineResult for payload construction.
        // uxDebate/uxEvaluation are already resolved above.
        const partialResult: PipelineResult = {
          runId: spec.id,
          spec,
          candidates: candidateRecords,
          recommendation: candidateRecords[0]!.debate.recommendation, // placeholder; best resolved below
          totalDurationMs: Date.now() - pipelineStartedAt,
          completedAt: new Date().toISOString(),
          ...(uxEvaluation  ? { uxEvaluation }  : {}),
          ...(uxEvaluationB ? { uxEvaluationB } : {}),
          ...(uxDebate      ? { uxDebate }      : {}),
        };

        const payload = buildSubmissionPayload(partialResult, runsDir);
        submission = await submitter.submit(payload);

        const submitStatus = submission.status === "failed" ? "FAILED" : submission.status;
        log("arena", `Submit ${submitStatus} — payload at ${submission.payloadPath}`);
        await events.append({
          runId: spec.id,
          kind: submission.status === "failed" ? "submit.failed" : "submit.completed",
          payload: { submissionId: submission.submissionId, status: submission.status, destination: submission.destination },
        });
      }

      // Pick best candidate by debate score for the overall recommendation
      const best = candidateRecords.reduce((a, b) =>
        a.debate.totalScore >= b.debate.totalScore ? a : b
      );

      const completedAt = new Date().toISOString();
      const totalDurationMs = Date.now() - pipelineStartedAt;

      pipelineResult = {
        runId: spec.id,
        spec,
        candidates: candidateRecords,
        recommendation: best.debate.recommendation,
        totalDurationMs,
        completedAt,
        ...(uxEvaluation  ? { uxEvaluation }  : {}),
        ...(uxEvaluationB ? { uxEvaluationB } : {}),
        ...(uxDebate      ? { uxDebate }      : {}),
        ...(submission    ? { submission }    : {}),
      };

      // Persist final result
      const resultPath = join(runsDir, spec.id, "result.json");
      await writeFile(resultPath, JSON.stringify(pipelineResult, null, 2), "utf8");

      log("arena", `Run ${spec.id.slice(0, 8)} complete — best ${best.debate.totalScore}/100 → ${best.debate.recommendation} (${totalDurationMs}ms)`);

      await events.append({
        runId: spec.id,
        kind: "run.completed",
        payload: {
          recommendation: best.debate.recommendation,
          totalScore: best.debate.totalScore,
          candidateCount: candidateRecords.length,
          totalDurationMs,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("arena", `Run ${spec.id.slice(0, 8)} FAILED — ${msg}`);
      await events.append({
        runId: spec.id,
        kind: "run.failed",
        payload: { error: msg },
      });
      throw err;
    }

    return pipelineResult;
  }

  return {
    async run(prompt: string): Promise<PipelineResult> {
      const startedAt = Date.now();
      const spec = await specBuilder.build(prompt);
      return execSpec(spec, startedAt);
    },

    async rerun(runId: string): Promise<PipelineResult> {
      const startedAt = Date.now();

      let spec: RunSpec;
      try {
        spec = JSON.parse(
          await readFile(join(runsDir, runId, "spec.json"), "utf8")
        ) as RunSpec;
      } catch {
        throw new Error(`No locked spec found for run ${runId}.`);
      }

      if (!spec.lockedAt) {
        throw new Error(`Spec for run ${runId} is not locked.`);
      }

      return execSpec(spec, startedAt);
    },
  };
}
