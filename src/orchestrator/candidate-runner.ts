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
import type { RunSpec, Candidate, BuildResult, Workspace, VerificationResult, SelfVerificationResult, RepairContext, RepairAttemptResult, EscalationResult, RecordingResult, DebateResult, Environment } from "../types/index.js";
import type { EventLog } from "../events/index.js";
import type { CandidateManager } from "../candidate/index.js";
import type { WorkerRegistry } from "../worker/adapter.js";
import type { Verifier } from "../verifier/index.js";
import type { Recorder } from "../recorder/index.js";
import type { Evaluator } from "../evaluator/index.js";
import type { EnvironmentManager } from "../environment/index.js";
import { DOCKER_ENVIRONMENT_CONFIG } from "../environment/index.js";
import { selfVerify } from "../verifier/self-verifier.js";
import { log, logStage } from "../logger.js";

// ─── Stage timeouts ───────────────────────────────────────────────────────────
// Each value is the outer safety net. Stages with internal timeouts (build,
// self-verify server wait) still get this hard ceiling to prevent silent hangs.

const TIMEOUT_MS = {
  BUILD:         300_000,  // 5 min  — adapter has its own budget; this is the hard ceiling
  SELF_VERIFY:    45_000,  // 45 sec — covers 15 s server wait + all checks
  RECORD:        120_000,  // 2 min
  DEBATE:         30_000,  // 30 sec — deterministic evaluator
  ENV_OPERATION:  30_000,  // 30 sec — provision / activate / release
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Races a promise against a timeout. Rejects with a descriptive error on
 * expiry so the stage label and limit appear in the event log and stderr.
 */
function withTimeout<T>(label: string, promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`[timeout] ${label} did not complete within ${ms}ms`)),
        ms,
      )
    ),
  ]);
}

/**
 * Releases a compute environment, swallowing errors so cleanup failure
 * never masks the original stage error. Always logs the outcome.
 */
async function safeRelease(
  mgr: EnvironmentManager,
  env: Environment,
  runId: string,
  candidateId: string,
): Promise<void> {
  const tag = `[${candidateId.slice(0, 8)}]`;
  log("cleanup", `${tag} releasing environment ${env.id.slice(0, 8)}`);
  try {
    await withTimeout("env.release", mgr.release(env), TIMEOUT_MS.ENV_OPERATION);
    log("cleanup", `${tag} environment released`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("cleanup", `${tag} release failed (non-fatal) — ${msg}`);
  }
}

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
  selfVerification: SelfVerificationResult;
  repairAttempt?: RepairAttemptResult;
  escalation?: EscalationResult;
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
  const tag = `[${candidate.id.slice(0, 8)}]`;

  // 1a. Provision compute environment — tracked separately so finally can always release it
  let currentEnv: Environment | null = null;
  if (environmentManager) {
    currentEnv = await withTimeout(
      "env.provision",
      environmentManager.provision(spec.id, candidate.id, DOCKER_ENVIRONMENT_CONFIG),
      TIMEOUT_MS.ENV_OPERATION,
    );
    candidate = { ...candidate, environmentId: currentEnv.id };
    await candidates.save(candidate);
  }

  // ── All remaining stages run inside try/finally so the environment is
  //    always released — even when a stage throws or times out.
  try {
    const execFn        = currentEnv ? environmentManager?.getExecFn(currentEnv)        : undefined;
    const spawnServerFn = currentEnv ? environmentManager?.getSpawnServerFn(currentEnv)  : undefined;

    const workspace: Workspace = {
      runId: spec.id,
      rootPath: candidate.workspacePath,
      createdAt: candidate.createdAt,
    };

    // 2. Activate environment and mark candidate as running
    if (environmentManager && currentEnv) {
      currentEnv = await withTimeout(
        "env.activate",
        environmentManager.activate(currentEnv),
        TIMEOUT_MS.ENV_OPERATION,
      );
    }
    candidate = { ...candidate, status: "running", startedAt: new Date().toISOString() };
    await candidates.save(candidate);

    await events.append({
      runId: spec.id,
      kind: "build.started",
      payload: { candidateId: candidate.id, adapterName },
    });

    // 3. Build — hard ceiling of TIMEOUT_MS.BUILD; adapter has its own inner budget
    log("arena", `${tag} build starting (adapter: ${adapterName})${currentEnv?.containerId ? ` [container: ${currentEnv.containerId.slice(0, 12)}]` : ""}`);
    const adapter = workers.get(adapterName);
    const buildResult = await withTimeout(
      "build",
      adapter.execute(spec, workspace),
      TIMEOUT_MS.BUILD,
    );
    log("arena", `${tag} build ${buildResult.success ? "succeeded" : "failed"} — ${buildResult.artifacts.length} artifact(s), ${buildResult.durationMs}ms`);

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
    log("arena", `${tag} build verification starting (${spec.successCriteria.length} criteria)`);
    await events.append({
      runId: spec.id,
      kind: "build.verify.started",
      payload: { candidateId: candidate.id },
    });

    const verification = await verifier.verify(spec, workspace, execFn);
    const checksPassed = verification.checks.filter((c) => c.passed).length;
    const checksTotal  = verification.checks.filter((c) => !c.skipped).length;
    log("arena", `${tag} build verification ${verification.state} — ${checksPassed}/${checksTotal} checks passed`);

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

    // 8. Self-verification — candidate verifies its own running server via Playwright
    log("arena", `${tag} self-verification starting`);
    await events.append({
      runId: spec.id,
      kind: "self.verify.started",
      payload: { candidateId: candidate.id },
    });

    const selfVerification = await withTimeout(
      "self-verify",
      selfVerify(spec, workspace, {
        ...(spawnServerFn ? { spawnServerFn } : {}),
        ...(currentEnv?.hostPort !== undefined ? { overridePort: currentEnv.hostPort } : {}),
      }),
      TIMEOUT_MS.SELF_VERIFY,
    );

    const svPassed = selfVerification.checks.filter((c) => c.passed).length;
    log("arena", `${tag} self-verification ${selfVerification.passed ? "PASSED" : "FAILED"} — ${svPassed}/${selfVerification.checks.length} checks, server started: ${selfVerification.serverStarted}`);

    await events.append({
      runId: spec.id,
      kind: "self.verify.completed",
      payload: {
        candidateId: candidate.id,
        passed: selfVerification.passed,
        serverStarted: selfVerification.serverStarted,
        checksPassed: svPassed,
        checksTotal: selfVerification.checks.length,
      },
    });

    // 9. Bounded repair — one attempt if initial self-verification failed
    const MAX_REPAIR_ATTEMPTS = 1;
    let repairAttempt: RepairAttemptResult | undefined;
    let escalation: EscalationResult | undefined;

    if (!selfVerification.passed) {
      const failedChecks = selfVerification.checks.filter((c) => !c.passed);
      log("arena", `${tag} self-verify failed (${failedChecks.length} check(s)) — repair attempt 1/${MAX_REPAIR_ATTEMPTS}`);

      await events.append({
        runId: spec.id,
        kind: "repair.started",
        payload: { candidateId: candidate.id, attempt: 1, failedCheckCount: failedChecks.length },
      });

      const repairContext: RepairContext = { failedChecks, attempt: 1 };
      const repairBuild = await withTimeout(
        "repair.build",
        adapter.execute(spec, workspace, repairContext),
        TIMEOUT_MS.BUILD,
      );
      log("arena", `${tag} repair build ${repairBuild.success ? "succeeded" : "failed"} — ${repairBuild.artifacts.length} artifact(s)`);

      const repairSelfVerification = await withTimeout(
        "repair.self-verify",
        selfVerify(spec, workspace, {
          ...(spawnServerFn ? { spawnServerFn } : {}),
          ...(currentEnv?.hostPort !== undefined ? { overridePort: currentEnv.hostPort } : {}),
        }),
        TIMEOUT_MS.SELF_VERIFY,
      );

      const repairSvPassed = repairSelfVerification.checks.filter((c) => c.passed).length;
      log("arena", `${tag} repair self-verify ${repairSelfVerification.passed ? "PASSED" : "FAILED"} — ${repairSvPassed}/${repairSelfVerification.checks.length} checks`);

      repairAttempt = {
        attempt: 1,
        build: repairBuild,
        selfVerification: repairSelfVerification,
        completedAt: new Date().toISOString(),
      };

      const repairAttemptPath = join(runsDir, spec.id, "candidates", candidate.id, "repair-attempt.json");
      await writeFile(repairAttemptPath, JSON.stringify(repairAttempt, null, 2), "utf8");

      await events.append({
        runId: spec.id,
        kind: "repair.completed",
        payload: {
          candidateId: candidate.id,
          attempt: 1,
          passed: repairSelfVerification.passed,
          checksPassed: repairSvPassed,
          checksTotal: repairSelfVerification.checks.length,
        },
      });

      if (!repairSelfVerification.passed) {
        const stillFailing = repairSelfVerification.checks.filter((c) => !c.passed);
        escalation = {
          runId: spec.id,
          candidateId: candidate.id,
          reason: `Repair attempt 1/${MAX_REPAIR_ATTEMPTS} exhausted. ${stillFailing.length} check(s) still failing after repair.`,
          failedChecks: stillFailing,
          completedAt: new Date().toISOString(),
        };

        const escalationPath = join(runsDir, spec.id, "candidates", candidate.id, "escalation.json");
        await writeFile(escalationPath, JSON.stringify(escalation, null, 2), "utf8");

        log("arena", `${tag} repair exhausted — escalation written`);

        await events.append({
          runId: spec.id,
          kind: "escalation.emitted",
          payload: {
            candidateId: candidate.id,
            reason: escalation.reason,
            failedCheckCount: stillFailing.length,
          },
        });
      }
    }

    // 10. Record — always runs regardless of verification outcome
    log("arena", `${tag} record starting`);
    await events.append({
      runId: spec.id,
      kind: "record.started",
      payload: { candidateId: candidate.id },
    });

    const script = recorder.buildScript(spec);
    const recording = await withTimeout(
      "record",
      recorder.record(spec, workspace, script, {
        ...(execFn        ? { execFn }        : {}),
        ...(spawnServerFn ? { spawnServerFn } : {}),
        ...(currentEnv?.hostPort !== undefined ? { overridePort: currentEnv.hostPort } : {}),
      }),
      TIMEOUT_MS.RECORD,
    );
    log("arena", `${tag} record done — video: ${!!recording.videoPath}, screenshots: ${recording.screenshotPaths.length}`);

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

    // 11. Debate — deterministic scoring; always runs
    log("arena", `${tag} debate starting`);
    await events.append({
      runId: spec.id,
      kind: "debate.started",
      payload: { candidateId: candidate.id },
    });

    const debate = await withTimeout(
      "debate",
      evaluator.evaluate({ spec, build: buildResult, verification, recording }),
      TIMEOUT_MS.DEBATE,
    );

    const debatePath = join(runsDir, spec.id, "candidates", candidate.id, "debate.json");
    await writeFile(debatePath, JSON.stringify(debate, null, 2), "utf8");
    log("arena", `${tag} debate complete — score: ${debate.totalScore}/100 → ${debate.recommendation}`);

    await events.append({
      runId: spec.id,
      kind: "debate.completed",
      payload: {
        candidateId: candidate.id,
        totalScore: debate.totalScore,
        recommendation: debate.recommendation,
      },
    });

    return {
      candidate, build: buildResult, verification, selfVerification,
      ...(repairAttempt ? { repairAttempt } : {}),
      ...(escalation    ? { escalation }    : {}),
      recording, debate,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("cleanup", `${tag} stage failed — ${msg}`);
    throw err;

  } finally {
    // Always release the compute environment — success, failure, or timeout.
    if (environmentManager && currentEnv) {
      logStage("cleanup", `${tag}`);
      await safeRelease(environmentManager, currentEnv, spec.id, candidate.id);
    }
  }
}
