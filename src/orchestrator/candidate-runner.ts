/**
 * Candidate runner — coordinates the lifecycle of a single candidate execution.
 *
 * Responsibilities:
 * 1. Create the candidate record and workspace
 * 2. Emit worker.started event
 * 3. Invoke the worker adapter
 * 4. Persist the WorkerResult to result.json
 * 5. Update candidate status
 * 6. Emit worker.completed / worker.failed event
 *
 * Does not update run.json — callers own run-level status transitions.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RunSpec, Candidate, BuildResult, Workspace, VerificationResult, RecordingResult, DebateResult, Environment } from "../types/index.js";
import type { EventLog } from "../events/index.js";
import type { CandidateManager } from "../candidate/index.js";
import type { WorkerRegistry } from "../worker/adapter.js";
import type { Verifier } from "../verifier/index.js";
import type { Recorder } from "../recorder/index.js";
import type { Evaluator } from "../evaluator/index.js";
import type { EnvironmentManager } from "../environment/index.js";
import { DOCKER_ENVIRONMENT_CONFIG } from "../environment/index.js";
import { log } from "../logger.js";

export interface CandidateRunnerDeps {
  runsDir: string;
  events: EventLog;
  candidates: CandidateManager;
  workers: WorkerRegistry;
  verifier: Verifier;
  recorder: Recorder;
  evaluator: Evaluator;
  /** Optional: when provided, each candidate gets a managed compute environment */
  environmentManager?: EnvironmentManager;
}

export interface CandidateRunResult {
  candidate: Candidate;
  build: BuildResult;
  verification: VerificationResult;
  recording: RecordingResult;
  debate: DebateResult;
}

export async function runCandidate(
  spec: RunSpec,
  deps: CandidateRunnerDeps
): Promise<CandidateRunResult> {
  const { events, candidates, workers, verifier, recorder, evaluator, runsDir, environmentManager } = deps;
  const adapterName = spec.workerConfig.adapterName;

  // 1. Create candidate + workspace on disk
  let candidate = await candidates.create(spec.id, adapterName);

  // 1a. Provision a compute environment and extract execution helpers
  let currentEnv: Environment | null = null;
  if (environmentManager) {
    currentEnv = await environmentManager.provision(spec.id, candidate.id, DOCKER_ENVIRONMENT_CONFIG);
    candidate = { ...candidate, environmentId: currentEnv.id };
    await candidates.save(candidate);
  }

  const execFn       = currentEnv ? environmentManager?.getExecFn(currentEnv)       : undefined;
  const spawnServerFn = currentEnv ? environmentManager?.getSpawnServerFn(currentEnv) : undefined;

  const workspace: Workspace = {
    runId: spec.id,
    rootPath: candidate.workspacePath,
    createdAt: candidate.createdAt,
  };

  // 2. Mark as running; activate the environment
  if (environmentManager && currentEnv) {
    currentEnv = await environmentManager.activate(currentEnv);
  }
  candidate = { ...candidate, status: "running", startedAt: new Date().toISOString() };
  await candidates.save(candidate);

  await events.append({
    runId: spec.id,
    kind: "build.started",
    payload: { candidateId: candidate.id, adapterName },
  });

  // 3. Execute — adapter must not throw; failure encoded in result
  log("arena", `[${candidate.id.slice(0, 8)}] build starting (adapter: ${adapterName})${currentEnv?.containerId ? ` [container: ${currentEnv.containerId.slice(0, 12)}]` : ""}`);
  const adapter = workers.get(adapterName);
  const buildResult = await adapter.execute(spec, workspace);
  log("arena", `[${candidate.id.slice(0, 8)}] build ${buildResult.success ? "succeeded" : "failed"} — ${buildResult.artifacts.length} artifact(s), ${buildResult.durationMs}ms`);

  // 4. Persist build result
  const resultPath = join(runsDir, spec.id, "candidates", candidate.id, "result.json");
  await writeFile(resultPath, JSON.stringify(buildResult, null, 2), "utf8");

  // 5. Update candidate status
  const completedAt = new Date().toISOString();
  candidate = {
    ...candidate,
    status: buildResult.success ? "completed" : "failed",
    completedAt,
  };
  await candidates.save(candidate);

  // 6. Emit build outcome event
  await events.append({
    runId: spec.id,
    kind: buildResult.success ? "build.completed" : "build.failed",
    payload: {
      candidateId: candidate.id,
      artifactCount: buildResult.artifacts.length,
      durationMs: buildResult.durationMs,
      ...(buildResult.error ? { error: buildResult.error } : {}),
    },
  });

  // 7. Build verification — independent quality check on build output
  log("arena", `[${candidate.id.slice(0, 8)}] build verification starting (${spec.successCriteria.length} criteria)`);
  await events.append({
    runId: spec.id,
    kind: "build.verify.started",
    payload: { candidateId: candidate.id },
  });

  const verification = await verifier.verify(spec, workspace, execFn);
  const checksPassed = verification.checks.filter((c) => c.passed).length;
  const checksTotal  = verification.checks.filter((c) => !c.skipped).length;
  log("arena", `[${candidate.id.slice(0, 8)}] build verification ${verification.state} — ${checksPassed}/${checksTotal} checks passed`);

  await events.append({
    runId: spec.id,
    kind: "build.verify.completed",
    payload: {
      candidateId: candidate.id,
      passed: verification.passed,
      state: verification.state,
      checksTotal: verification.checks.length,
      checksPassed,
      checksSkipped: verification.checks.filter((c) => c.skipped).length,
    },
  });

  // 8. Record — always runs; failure is non-fatal, logged in result
  log("arena", `[${candidate.id.slice(0, 8)}] record starting`);
  await events.append({
    runId: spec.id,
    kind: "record.started",
    payload: { candidateId: candidate.id },
  });

  const script = recorder.buildScript(spec);
  const recording = await recorder.record(spec, workspace, script, {
    ...(execFn        ? { execFn }        : {}),
    ...(spawnServerFn ? { spawnServerFn } : {}),
    ...(currentEnv?.hostPort !== undefined ? { overridePort: currentEnv.hostPort } : {}),
  });
  log("arena", `[${candidate.id.slice(0, 8)}] record done — video: ${!!recording.videoPath}, screenshots: ${recording.screenshotPaths.length}`);

  await events.append({
    runId: spec.id,
    kind: recording.videoPath ? "record.completed" : "record.failed",
    payload: {
      candidateId: candidate.id,
      stepCount: recording.demoLog.length,
      videoRecorded: !!recording.videoPath,
      screenshotCount: recording.screenshotPaths.length,
    },
  });

  // 9. Debate — always runs; grounded in structured artifacts only
  log("arena", `[${candidate.id.slice(0, 8)}] debate starting`);
  await events.append({
    runId: spec.id,
    kind: "debate.started",
    payload: { candidateId: candidate.id },
  });

  const debate = await evaluator.evaluate({
    spec,
    build: buildResult,
    verification,
    recording,
  });

  const debatePath = join(runsDir, spec.id, "candidates", candidate.id, "debate.json");
  await writeFile(debatePath, JSON.stringify(debate, null, 2), "utf8");
  log("arena", `[${candidate.id.slice(0, 8)}] debate complete — score: ${debate.totalScore}/100 → ${debate.recommendation}`);

  // Release compute environment
  if (environmentManager && currentEnv) {
    await environmentManager.release(currentEnv);
  }

  await events.append({
    runId: spec.id,
    kind: "debate.completed",
    payload: {
      candidateId: candidate.id,
      totalScore: debate.totalScore,
      recommendation: debate.recommendation,
    },
  });

  return { candidate, build: buildResult, verification, recording, debate };
}
