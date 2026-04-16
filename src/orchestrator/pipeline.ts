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

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineResult, CandidateRecord, RunSpec } from "../types/index.js";
import type { OrchestratorConfig, Orchestrator } from "./index.js";
import { createFsCandidateManager } from "../candidate/index.js";
import { runCandidate } from "./candidate-runner.js";
import { log } from "../logger.js";

export function createOrchestrator(config: OrchestratorConfig): Orchestrator {
  const { runsDir, events, workers, verifier, recorder, evaluator, specBuilder, environmentManager } = config;

  // Core: run the pipeline for an already-locked spec.
  async function execSpec(spec: RunSpec, pipelineStartedAt: number): Promise<PipelineResult> {
    log("arena", `Starting run ${spec.id.slice(0, 8)} — "${spec.goal.slice(0, 70)}"`);
    const candidates = createFsCandidateManager(runsDir);

    let pipelineResult: PipelineResult;

    try {
      const candidateRecords: CandidateRecord[] = [];
      const deps = {
        runsDir, events, candidates, workers, verifier, recorder, evaluator,
        ...(environmentManager ? { environmentManager } : {}),
      };

      for (let i = 0; i < NUM_CANDIDATES; i++) {
        log("arena", `Candidate ${i + 1}/${NUM_CANDIDATES} starting`);
        const { candidate, build, verification, recording, debate } =
          await runCandidate(spec, deps);
        candidateRecords.push({ candidateId: candidate.id, build, verification, recording, debate });
        log("arena", `Candidate ${i + 1}/${NUM_CANDIDATES} done — ${debate.totalScore}/100 → ${debate.recommendation}`);
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
