/**
 * CLI entry point.
 *
 * Commands:
 *   run  "<prompt>"   — create a new run, generate and lock the spec, print result
 *   exec <runId>      — run the worker adapter against a locked spec
 *   show <runId>      — print the run record, spec, and candidates for an existing run
 *
 * Environment:
 *   ANTHROPIC_API_KEY  (required for `run`)
 *   RUNS_DIR           (optional, default: ./runs)
 */

import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createFileEventLog } from "./events/index.js";
import { logBanner, logStage } from "./logger.js";
import { createSpecBuilder } from "./orchestrator/spec-builder.js";
import { createOrchestrator } from "./orchestrator/index.js";
import { createFsCandidateManager } from "./candidate/index.js";
import {
  createWorkerRegistry,
  createStubWorkerAdapter,
  createClaudeWorkerAdapter,
} from "./worker/adapter.js";
import { createVerifier } from "./verifier/index.js";
import { createRecorder } from "./recorder/index.js";
import { createEvaluator } from "./evaluator/index.js";
import { createClaudeUXEvaluator, createBuilderDebater } from "./ux-evaluator/index.js";
import { createStubSubmitter, createWebhookSubmitter } from "./submitter/index.js";
import { createDockerEnvironmentManager, sweepOrphanContainers } from "./environment/docker-manager.js";
import type { RunRecord, RunSpec, PipelineResult } from "./types/index.js";

const RUNS_DIR = resolve(process.env["RUNS_DIR"] ?? "./runs");

function usage(): void {
  console.error(`
Usage:
  node dist/cli.js pipeline "<prompt>"   — full run: spec → worker → verify → record → evaluate
  node dist/cli.js run      "<prompt>"   — lock a spec only (no execution)
  node dist/cli.js exec     <runId>      — re-run pipeline against an existing locked spec
  node dist/cli.js show     <runId>      — inspect run, spec, candidates, and result
  node dist/cli.js env      <runId>      — show Docker container status for all candidates in a run

Environment:
  ANTHROPIC_API_KEY   required for "pipeline", "run", and "exec" with the claude adapter
  RUNS_DIR            override artifact storage path (default: ./runs)
  DOCKER_ENV=1        enable Docker-backed compute environments (one container per candidate)
`.trim());
}

async function cmdRun(prompt: string): Promise<void> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    console.error("Error: ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const events = createFileEventLog(RUNS_DIR);
  const builder = createSpecBuilder(RUNS_DIR, events, { llmApiKey: apiKey });

  console.error("Parsing prompt and generating locked spec...");
  const spec = await builder.build(prompt);

  const output = {
    runId: spec.id,
    status: "provisioned",
    goal: spec.goal,
    constraints: spec.constraints,
    successCriteria: spec.successCriteria.map((c) => ({
      checkKind: c.checkKind,
      description: c.description,
    })),
    workerConfig: spec.workerConfig,
    lockedAt: spec.lockedAt,
    paths: {
      runDir: join(RUNS_DIR, spec.id),
      spec: join(RUNS_DIR, spec.id, "spec.json"),
      runRecord: join(RUNS_DIR, spec.id, "run.json"),
      events: join(RUNS_DIR, spec.id, "events.jsonl"),
    },
  };

  console.log(JSON.stringify(output, null, 2));
}

// ─── Shared orchestrator factory ─────────────────────────────────────────────

async function buildOrchestrator(adapterName: string) {
  const apiKey = process.env["ANTHROPIC_API_KEY"];

  const workers = createWorkerRegistry();
  workers.register(createStubWorkerAdapter());
  if (apiKey) {
    workers.register(createClaudeWorkerAdapter(apiKey));
  } else if (adapterName === "claude") {
    console.error("Error: ANTHROPIC_API_KEY is required for the claude adapter.");
    process.exit(1);
  }

  const events = createFileEventLog(RUNS_DIR);
  const specBuilder = createSpecBuilder(RUNS_DIR, events, {
    llmApiKey: apiKey ?? "",
  });

  const environmentManager = process.env["DOCKER_ENV"] === "1"
    ? createDockerEnvironmentManager(RUNS_DIR)
    : undefined;

  if (environmentManager) {
    console.error("Docker environment enabled (DOCKER_ENV=1).");
    const swept = await sweepOrphanContainers();
    if (swept > 0) console.error(`Swept ${swept} orphan spec-runner container(s) from prior runs.`);
  }

  const uxEvaluator  = apiKey ? createClaudeUXEvaluator(apiKey, "correctness") : undefined;
  const uxEvaluatorB = apiKey ? createClaudeUXEvaluator(apiKey, "quality")     : undefined;
  const uxDebater    = apiKey ? createBuilderDebater(apiKey)                  : undefined;
  const webhookUrl   = process.env["SUBMIT_WEBHOOK_URL"];
  const submitter    = webhookUrl
    ? createWebhookSubmitter(RUNS_DIR, { url: webhookUrl })
    : createStubSubmitter(RUNS_DIR);

  return createOrchestrator({
    runsDir: RUNS_DIR,
    events,
    workspace: null as never,
    workers,
    verifier: createVerifier(),
    recorder: createRecorder(),
    evaluator: createEvaluator(),
    specBuilder,
    submitter,
    ...(environmentManager ? { environmentManager } : {}),
    ...(uxEvaluator  ? { uxEvaluator }  : {}),
    ...(uxEvaluatorB ? { uxEvaluatorB } : {}),
    ...(uxDebater    ? { uxDebater }    : {}),
  });
}

function formatPipelineResult(pr: PipelineResult): object {
  // Pick best candidate for the headline score
  const best = pr.candidates.reduce((a, b) =>
    a.debate.totalScore >= b.debate.totalScore ? a : b
  );

  return {
    runId: pr.runId,
    recommendation: pr.recommendation,
    totalScore: best.debate.totalScore,
    rationale: best.debate.rationale,
    spec: {
      goal: pr.spec.goal,
      constraints: pr.spec.constraints,
      successCriteria: pr.spec.successCriteria.map((c) => ({
        checkKind: c.checkKind,
        description: c.description,
      })),
    },
    candidates: pr.candidates.map((c, i) => ({
      index: i + 1,
      candidateId: c.candidateId,
      score: c.debate.totalScore,
      recommendation: c.debate.recommendation,
      build: {
        success: c.build.success,
        artifactCount: c.build.artifacts.length,
        durationMs: c.build.durationMs,
        ...(c.build.error ? { error: c.build.error } : {}),
        ...(c.build.tokenUsage ? { tokenUsage: c.build.tokenUsage } : {}),
      },
      verification: {
        state: c.verification.state,
        passed: c.verification.passed,
        checks: c.verification.checks.map((ck) => ({
          name: ck.name,
          passed: ck.passed,
          skipped: ck.skipped,
          reason: ck.reason,
        })),
      },
      selfVerification: {
        passed: c.selfVerification.passed,
        serverStarted: c.selfVerification.serverStarted,
        checksPassed: c.selfVerification.checks.filter((ck) => ck.passed).length,
        checksTotal: c.selfVerification.checks.length,
        checks: c.selfVerification.checks.map((ck) => ({
          endpoint: ck.endpoint,
          passed: ck.passed,
          ...(ck.httpStatus !== undefined ? { httpStatus: ck.httpStatus } : {}),
          reason: ck.reason,
        })),
      },
      ...(c.repairAttempt ? {
        repairAttempt: {
          attempt: c.repairAttempt.attempt,
          buildSuccess: c.repairAttempt.build.success,
          selfVerificationPassed: c.repairAttempt.selfVerification.passed,
          checksPassed: c.repairAttempt.selfVerification.checks.filter((ck) => ck.passed).length,
          checksTotal: c.repairAttempt.selfVerification.checks.length,
          checks: c.repairAttempt.selfVerification.checks.map((ck) => ({
            endpoint: ck.endpoint,
            passed: ck.passed,
            ...(ck.httpStatus !== undefined ? { httpStatus: ck.httpStatus } : {}),
            reason: ck.reason,
          })),
        },
      } : {}),
      ...(c.escalation ? {
        escalation: {
          reason: c.escalation.reason,
          failedCheckCount: c.escalation.failedChecks.length,
          failedChecks: c.escalation.failedChecks.map((ck) => ck.endpoint),
        },
      } : {}),
      recording: {
        stepCount: c.recording.demoLog.length,
        videoRecorded: !!c.recording.videoPath,
        screenshotCount: c.recording.screenshotPaths.length,
        steps: c.recording.demoLog.map((s) => ({
          description: s.description,
          exitCode: s.exitCode,
          ...(s.exitCode !== 0 ? { stderr: s.stderr.slice(0, 120) } : {}),
        })),
      },
      debate: {
        rationale: c.debate.rationale,
        dimensions: c.debate.dimensions.map((d) => ({
          name: d.name,
          weight: d.weight,
          score: d.score,
          rationale: d.rationale,
        })),
      },
    })),
    ...(pr.uxEvaluation ? {
      uxEvaluationA: {
        recommendedWinner: pr.uxEvaluation.recommendedWinner,
        rationale: pr.uxEvaluation.rationale,
        tradeoffs: pr.uxEvaluation.tradeoffs,
        ranking: pr.uxEvaluation.ranking.map((a) => ({
          candidateId: a.candidateId,
          rank: a.rank,
          score: a.score,
          strengths: a.strengths,
          weaknesses: a.weaknesses,
          observedMoments: a.observedMoments,
        })),
      },
    } : {}),
    ...(pr.uxEvaluationB ? {
      uxEvaluationB: {
        recommendedWinner: pr.uxEvaluationB.recommendedWinner,
        rationale: pr.uxEvaluationB.rationale,
        tradeoffs: pr.uxEvaluationB.tradeoffs,
        ranking: pr.uxEvaluationB.ranking.map((a) => ({
          candidateId: a.candidateId,
          rank: a.rank,
          score: a.score,
          strengths: a.strengths,
          weaknesses: a.weaknesses,
          observedMoments: a.observedMoments,
        })),
      },
    } : {}),
    ...(pr.uxDebate ? {
      uxDebate: {
        finalWinner: pr.uxDebate.finalWinner,
        finalRationale: pr.uxDebate.finalRationale,
        consensusPoints: pr.uxDebate.consensusPoints,
        disputedPoints: pr.uxDebate.disputedPoints,
        rounds: pr.uxDebate.rounds.map((r) => ({
          evaluatorId: r.evaluatorId,
          roundIndex: r.roundIndex,
          position: r.position,
          evidenceRefs: r.evidenceRefs,
          concessions: r.concessions,
        })),
      },
    } : {}),
    ...(pr.submission ? {
      submission: {
        status: pr.submission.status,
        submissionId: pr.submission.submissionId,
        destination: pr.submission.destination,
        payloadPath: pr.submission.payloadPath,
        submittedAt: pr.submission.submittedAt,
      },
    } : {}),
    totalDurationMs: pr.totalDurationMs,
    completedAt: pr.completedAt,
    paths: {
      runDir: join(RUNS_DIR, pr.runId),
      result: join(RUNS_DIR, pr.runId, "result.json"),
      spec: join(RUNS_DIR, pr.runId, "spec.json"),
      events: join(RUNS_DIR, pr.runId, "events.jsonl"),
      candidates: join(RUNS_DIR, pr.runId, "candidates"),
      ...(pr.submission ? { submission: pr.submission.payloadPath } : {}),
    },
  };
}

// ─── pipeline command ─────────────────────────────────────────────────────────

async function cmdPipeline(prompt: string): Promise<void> {
  const apiKey   = process.env["ANTHROPIC_API_KEY"] ?? "";
  const dockerEnv = process.env["DOCKER_ENV"] === "1";

  // In Docker mode the build agents run claude-cli inside containers via ~/.claude
  // and do not need ANTHROPIC_API_KEY. The key is still required for spec-builder,
  // evaluators, and debater which run on the host.
  if (!apiKey) {
    logBanner([
      "ERROR: ANTHROPIC_API_KEY is not set.",
      "",
      "Export it before running:",
      "  export ANTHROPIC_API_KEY=sk-ant-...",
      "",
      dockerEnv
        ? "Note: DOCKER_ENV=1 — build agents use ~/.claude in containers (no key needed)."
        + "\n  ANTHROPIC_API_KEY is still required for spec-builder, evaluators, and debater."
        : "",
    ].filter(Boolean));
    process.exit(1);
  }

  const webhookUrl = process.env["SUBMIT_WEBHOOK_URL"];

  logBanner([
    "SPEC RUNNER ARENA",
    "",
    `Prompt : ${prompt.length > 72 ? prompt.slice(0, 72) + "…" : prompt}`,
    `Output : ${RUNS_DIR}`,
    `Adapter: claude`,
    `Submit : ${webhookUrl ? `webhook → ${webhookUrl.split("?")[0]}` : "dry-run (set SUBMIT_WEBHOOK_URL to send)"}`,
    ...(dockerEnv ? ["Env    : Docker (DOCKER_ENV=1)"] : []),
    "",
    "Stages : provision → build ×3 → record → evaluate A+B → debate → submit",
  ]);

  const events      = createFileEventLog(RUNS_DIR);
  const specBuilder = createSpecBuilder(RUNS_DIR, events, { llmApiKey: apiKey });
  const workers     = createWorkerRegistry();
  workers.register(createStubWorkerAdapter());
  workers.register(createClaudeWorkerAdapter(apiKey));

  const environmentManager = dockerEnv
    ? createDockerEnvironmentManager(RUNS_DIR)
    : undefined;

  if (environmentManager) {
    const swept = await sweepOrphanContainers();
    if (swept > 0) console.error(`Swept ${swept} orphan spec-runner container(s) from prior runs.`);
  }

  const orchestrator = createOrchestrator({
    runsDir: RUNS_DIR,
    events,
    workspace: null as never,
    workers,
    verifier:     createVerifier(),
    recorder:     createRecorder(),
    evaluator:    createEvaluator(),
    specBuilder,
    uxEvaluator:  createClaudeUXEvaluator(apiKey, "correctness"),
    uxEvaluatorB: createClaudeUXEvaluator(apiKey, "quality"),
    uxDebater:    createBuilderDebater(apiKey),
    submitter:    webhookUrl
      ? createWebhookSubmitter(RUNS_DIR, { url: webhookUrl })
      : createStubSubmitter(RUNS_DIR),
    ...(environmentManager ? { environmentManager } : {}),
  });

  logStage("provision", "locking spec");

  let result: PipelineResult;
  try {
    result = await orchestrator.run(prompt);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logBanner([
      "PIPELINE FAILED",
      "",
      `Error : ${msg}`,
      "",
      "Partial artifacts (if any) are in:",
      `  ${RUNS_DIR}/`,
      "",
      "Check events.jsonl inside the run directory for the last stage reached.",
    ]);
    process.exit(1);
  }

  await patchRunRecord(join(RUNS_DIR, result.runId), "completed");

  // Determine winner label from submission payload or fallback to recommendation
  const winnerRecord = result.candidates.find(
    (c) => c.candidateId === (result.uxDebate?.finalWinner ?? result.recommendation)
  ) ?? result.candidates[0]!;
  const winnerLabel = `Candidate ${result.candidates.indexOf(winnerRecord) + 1}`;

  const sub = result.submission;
  const runDir = join(RUNS_DIR, result.runId);

  logBanner([
    "PIPELINE COMPLETE",
    "",
    `Run ID   : ${result.runId}`,
    `Duration : ${formatMs(result.totalDurationMs)}`,
    `Winner   : ${winnerLabel} (${winnerRecord.candidateId.slice(0, 8)})`,
    ...(result.uxDebate
      ? [`Rationale: ${result.uxDebate.finalRationale.slice(0, 72)}…`]
      : []),
    "",
    "Artifacts:",
    `  Result     : ${join(runDir, "result.json")}`,
    `  Spec       : ${join(runDir, "spec.json")}`,
    `  Events     : ${join(runDir, "events.jsonl")}`,
    `  Candidates : ${join(runDir, "candidates")}`,
    ...(result.uxDebate
      ? [`  Debate     : ${join(runDir, "ux-debate.json")}`]
      : []),
    ...(sub
      ? [`  Submission : ${sub.payloadPath}  [${sub.status}]`]
      : []),
  ]);

  // Structured JSON to stdout — pipe-friendly
  console.log(JSON.stringify(formatPipelineResult(result), null, 2));
}

function formatMs(ms: number): string {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

// ─── exec command (rerun against existing spec) ───────────────────────────────

async function cmdExec(runId: string): Promise<void> {
  const runDir = join(RUNS_DIR, runId);

  let spec: RunSpec;
  try {
    spec = JSON.parse(
      await readFile(join(runDir, "spec.json"), "utf8")
    ) as RunSpec;
  } catch {
    console.error(`No locked spec found for run ${runId} at ${runDir}`);
    process.exit(1);
  }

  if (!spec.lockedAt) {
    console.error("Spec is not locked. Run 'run' first.");
    process.exit(1);
  }

  await patchRunRecord(runDir, "building");

  const orchestrator = await buildOrchestrator(spec.workerConfig.adapterName);

  console.error(`Executing pipeline for run ${runId} (adapter: ${spec.workerConfig.adapterName})...`);
  const result = await orchestrator.rerun(runId);
  await patchRunRecord(runDir, "completed");

  console.log(JSON.stringify(formatPipelineResult(result), null, 2));
}

async function patchRunRecord(
  runDir: string,
  status: RunRecord["status"]
): Promise<void> {
  try {
    const record = JSON.parse(
      await readFile(join(runDir, "run.json"), "utf8")
    ) as RunRecord;
    const updated: RunRecord = {
      ...record,
      status,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(join(runDir, "run.json"), JSON.stringify(updated, null, 2), "utf8");
  } catch {
    // non-fatal: run.json may not exist on a manually constructed run
  }
}

async function cmdEnvStatus(runId: string): Promise<void> {
  const mgr = createDockerEnvironmentManager(RUNS_DIR);
  const envs = await mgr.listForRun(runId);

  if (envs.length === 0) {
    console.error(`No Docker environments found for run ${runId}.`);
    console.error("Run with DOCKER_ENV=1 to use Docker-backed compute environments.");
    process.exit(1);
  }

  const rows = await Promise.all(
    envs.map(async (env) => {
      const info = await mgr.inspect(env);
      return {
        env:       info.environmentId.slice(0, 8),
        candidate: info.candidateId.slice(0, 8),
        status:    info.status,
        container: info.containerStatus,
        running:   info.running ? "yes" : "no",
        port:      info.hostPort ?? "-",
        uptime:    info.uptimeSec !== undefined ? `${info.uptimeSec}s` : "-",
      };
    })
  );

  const header = ["ENV", "CANDIDATE", "STATUS", "CONTAINER", "RUNNING", "PORT", "UPTIME"];
  const cols   = rows.map((r) => Object.values(r).map(String));
  const widths = header.map((h, i) =>
    Math.max(h.length, ...cols.map((c) => (c[i] ?? "").length))
  );

  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join("  ");

  console.error(`\nDocker environments for run ${runId.slice(0, 8)}:\n`);
  console.error(fmt(header));
  console.error(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of cols) console.error(fmt(row));
  console.error();
}

async function cmdShow(runId: string): Promise<void> {
  const runDir = join(RUNS_DIR, runId);

  let runRecord: RunRecord;
  let spec: RunSpec | null = null;

  try {
    runRecord = JSON.parse(
      await readFile(join(runDir, "run.json"), "utf8")
    ) as RunRecord;
  } catch {
    console.error(`No run found at ${runDir}`);
    process.exit(1);
  }

  try {
    spec = JSON.parse(
      await readFile(join(runDir, "spec.json"), "utf8")
    ) as RunSpec;
  } catch {
    // spec may not exist yet if run failed early
  }

  const candidates = createFsCandidateManager(RUNS_DIR);
  const candidateList = await candidates.listForRun(runId);

  console.log(JSON.stringify({ runRecord, spec, candidates: candidateList }, null, 2));
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  if (command === "pipeline") {
    const prompt = args.join(" ").trim();
    if (!prompt) {
      console.error("Error: prompt is required.\n");
      usage();
      process.exit(1);
    }
    await cmdPipeline(prompt);
    return;
  }

  if (command === "run") {
    const prompt = args.join(" ").trim();
    if (!prompt) {
      console.error("Error: prompt is required.\n");
      usage();
      process.exit(1);
    }
    await cmdRun(prompt);
    return;
  }

  if (command === "exec") {
    const runId = args[0]?.trim();
    if (!runId) {
      console.error("Error: runId is required.\n");
      usage();
      process.exit(1);
    }
    await cmdExec(runId);
    return;
  }

  if (command === "show") {
    const runId = args[0]?.trim();
    if (!runId) {
      console.error("Error: runId is required.\n");
      usage();
      process.exit(1);
    }
    await cmdShow(runId);
    return;
  }

  if (command === "env") {
    const runId = args[0]?.trim();
    if (!runId) {
      console.error("Error: runId is required.\n");
      usage();
      process.exit(1);
    }
    await cmdEnvStatus(runId);
    return;
  }

  usage();
  process.exit(command ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
