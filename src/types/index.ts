/**
 * Core domain model — Arena pipeline.
 *
 * Stages: Provision → Build → Record → Debate → Submit
 *
 * Design rules:
 * - RunSpec is immutable once locked. Never mutate after lockedAt is set.
 * - All timestamps are ISO 8601 strings.
 * - All IDs are UUID v4.
 * - Scores are 0–100 integers.
 */

// ─── Identity ────────────────────────────────────────────────────────────────

export type RunId = string;
export type ArtifactPath = string; // relative to workspace root

// ─── Run Spec ────────────────────────────────────────────────────────────────

export interface SuccessCriterion {
  id: string;
  description: string;
  /** How this criterion will be checked: static analysis, runtime probe, or LLM eval */
  checkKind: "static" | "runtime" | "llm";
}

export interface WorkerConfig {
  /** Which registered adapter to use */
  adapterName: string;
  /** Max tokens the worker may consume across all LLM calls */
  maxTokenBudget: number;
  /** Wall-clock timeout in milliseconds */
  timeoutMs: number;
  /** Arbitrary adapter-specific options (must be serialisable) */
  options: Record<string, unknown>;
}

/**
 * The locked specification for a single run.
 * Produced once from a user prompt; never modified after lockedAt is set.
 */
export interface RunSpec {
  id: RunId;
  schemaVersion: "1";
  createdAt: string;
  lockedAt: string | null; // null until spec-builder finalises it
  prompt: string;          // original user prompt, verbatim
  goal: string;            // one-sentence distillation
  constraints: string[];
  successCriteria: SuccessCriterion[];
  workerConfig: WorkerConfig;
}

// ─── Events (append-only log) ─────────────────────────────────────────────────

export type EventKind =
  | "provision.started"
  | "provision.completed"
  | "workspace.created"
  | "build.started"
  | "build.completed"
  | "build.failed"
  | "build.verify.started"
  | "build.verify.completed"
  | "build.verify.failed"
  | "record.started"
  | "record.completed"
  | "record.failed"
  | "debate.started"
  | "debate.completed"
  | "run.completed"
  | "run.failed";

export interface RunEvent<P = Record<string, unknown>> {
  id: string;
  runId: RunId;
  kind: EventKind;
  timestamp: string;
  payload: P;
}

// ─── Workspace & Artifacts ────────────────────────────────────────────────────

/**
 * Filesystem view of the compute environment allocated to a candidate.
 * Always provisioned inside an Environment — do not use standalone.
 */
export interface Workspace {
  runId: RunId;
  /** Absolute path to the isolated candidate directory */
  rootPath: string;
  createdAt: string;
}

export interface Artifact {
  /** Path relative to workspace.rootPath */
  path: ArtifactPath;
  kind: "file" | "directory";
  sizeBytes?: number;
  /** SHA-256 hex digest for reproducibility checks */
  sha256?: string;
}

// ─── Build ────────────────────────────────────────────────────────────────────

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Output of the Build stage (worker execution). */
export interface BuildResult {
  success: boolean;
  artifacts: Artifact[];
  durationMs: number;
  tokenUsage?: TokenUsage;
  /** Present only on failure */
  error?: string;
}

// ─── Verification ─────────────────────────────────────────────────────────────

export interface CheckResult {
  criterionId: string;
  name: string;
  passed: boolean;
  /** True when the check was intentionally not executed (e.g. LLM checks in V1) */
  skipped: boolean;
  reason: string;
  durationMs: number;
}

export type VerificationState =
  | "passed"   // all non-skipped checks passed
  | "partial"  // at least one passed, at least one failed
  | "failed";  // no non-skipped checks passed, or workspace was empty

export interface VerificationResult {
  runId: RunId;
  /** true only when state === "passed" */
  passed: boolean;
  state: VerificationState;
  checks: CheckResult[];
  completedAt: string;
}

// ─── Recording ───────────────────────────────────────────────────────────────

export interface DemoStep {
  stepIndex: number;
  description: string;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface RecordingResult {
  runId: RunId;
  /** Absolute path to the recorded video file (webm), if capture succeeded */
  videoPath?: string;
  /** Absolute paths to screenshots taken during the demo, in order */
  screenshotPaths: string[];
  demoLog: DemoStep[];
  completedAt: string;
}

// ─── Debate ───────────────────────────────────────────────────────────────────

export interface ScoreDimension {
  name: string;
  weight: number; // contribution to totalScore (all weights sum to 100)
  score: number;  // raw score for this dimension, 0–100
  rationale: string;
}

export type Recommendation = "accept" | "reject" | "needs-revision";

/**
 * Explicit signals extracted from artifacts before scoring.
 * Every dimension score must trace back to one of these fields.
 */
export interface EvaluationEvidence {
  criteriaTotal: number;
  criteriaActive: number;   // non-skipped
  criteriaPassed: number;
  runtimeCriteriaTotal: number;
  runtimeCriteriaPassed: number;
  staticCriteriaTotal: number;
  staticCriteriaPassed: number;
  serverStarted: boolean;
  videoRecorded: boolean;
  screenshotCount: number;
  artifactCount: number;
  totalArtifactBytes: number;
  hasBuildManifest: boolean;
  /** True when the Build stage worker reported success */
  buildSuccess: boolean;
  verificationState: VerificationState;
}

/** Output of the Debate stage (evaluation and scoring). */
export interface DebateResult {
  runId: RunId;
  /** Weighted aggregate of all dimension scores, 0–100 */
  totalScore: number;
  dimensions: ScoreDimension[];
  recommendation: Recommendation;
  /** One-sentence summary grounded in evidence */
  rationale: string;
  /** Raw signals used to compute every score — for traceability */
  evidence: EvaluationEvidence;
  completedAt: string;
}

// ─── Execution primitives ─────────────────────────────────────────────────────

/**
 * Runs a shell command inside an isolated environment (e.g. docker exec).
 * When undefined, callers fall back to local child_process.spawn.
 */
export type ExecFn = (
  command: string,
  /** Working directory inside the environment. Docker default: /workspace */
  cwd?: string,
  timeoutMs?: number
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>;

/**
 * Spawns a long-running server process inside an environment.
 * Returns a handle with a kill() method and a startupLog accessor.
 */
export type ServerSpawnFn = (command: string, cwd: string) => {
  port: number;
  url: string;
  readonly startupLog: string;
  kill(): void;
};

// ─── Environment ──────────────────────────────────────────────────────────────

export type EnvironmentStatus =
  | "provisioning"        // being allocated
  | "ready"               // allocated, awaiting work
  | "running"             // a stage is actively executing
  | "teardown_requested"  // teardown initiated, cleanup in progress
  | "terminated";         // fully released

export interface EnvironmentConfig {
  /** Isolation strategy — only "local-process" is implemented in V1 */
  isolationType: "local-process" | "docker" | "vm";
  /** Environment variables to inject into the isolated process */
  env?: Record<string, string>;
  /** Wall-clock limit for the entire environment lifetime, ms */
  lifetimeLimitMs?: number;
}

/**
 * An isolated compute context for one candidate execution.
 * The Workspace (filesystem) is provisioned inside the Environment.
 */
export interface Environment {
  id: string;
  runId: RunId;
  candidateId: string;
  config: EnvironmentConfig;
  status: EnvironmentStatus;
  /** Absolute path to the filesystem workspace allocated within this environment */
  workspacePath: string;
  createdAt: string;
  updatedAt: string;
  readyAt?: string;
  terminatedAt?: string;
  /** Docker container ID — set when isolationType === "docker" */
  containerId?: string;
  /** Host-side port mapped into the container — set when isolationType === "docker" */
  hostPort?: number;
}

// ─── Candidate ────────────────────────────────────────────────────────────────

export type CandidateStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed";

/**
 * A single execution attempt for a run.
 * V1: one candidate per run. The schema supports multiple.
 *
 * Persisted at runs/<runId>/candidates/<candidateId>/candidate.json.
 */
export interface Candidate {
  id: string;
  runId: RunId;
  /** Absolute path to this candidate's workspace root */
  workspacePath: string;
  adapterName: string;
  status: CandidateStatus;
  /** ID of the compute environment provisioned for this candidate */
  environmentId?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

// ─── Run Record ───────────────────────────────────────────────────────────────

/** The explicit stage the arena run is currently in. */
export type ArenaStage = "provision" | "build" | "record" | "debate" | "submit";

export type RunStatus =
  | "initializing"
  | "provisioned"   // spec locked
  | "building"      // worker executing
  | "build_done"    // build + verification complete
  | "recording"     // record stage in progress
  | "record_done"   // record stage complete
  | "debating"      // debate stage in progress
  | "completed"
  | "failed";

/**
 * Lightweight metadata record written to runs/<runId>/run.json.
 * Updated in-place as the pipeline advances. Not append-only (use events.jsonl for that).
 */
export interface RunRecord {
  id: RunId;
  status: RunStatus;
  prompt: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Arena Run Result ─────────────────────────────────────────────────────────

/**
 * Per-candidate result bundle — one per agent that ran against the spec.
 * Each candidate has its own isolated workspace and independent stage outputs.
 */
export interface CandidateRecord {
  candidateId: string;
  build: BuildResult;
  verification: VerificationResult;
  recording: RecordingResult;
  debate: DebateResult;
}

/** Complete output of a full arena pipeline run (3 candidates by default). */
export interface PipelineResult {
  runId: RunId;
  spec: RunSpec;
  /** One entry per agent/candidate that ran, in execution order. */
  candidates: CandidateRecord[];
  recommendation: Recommendation;
  totalDurationMs: number;
  completedAt: string;
}
