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
  | "self.verify.started"
  | "self.verify.completed"
  | "repair.started"
  | "ux.review.started"
  | "ux.review.completed"
  | "ux.debate.started"
  | "ux.debate.completed"
  | "submit.started"
  | "submit.completed"
  | "submit.failed"
  | "repair.completed"
  | "escalation.emitted"
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

// ─── Self-Verification ────────────────────────────────────────────────────────

/**
 * Result of one Playwright HTTP probe against the candidate's running server.
 */
export interface SelfVerificationCheck {
  /** Human-readable label, e.g. "POST /todos" */
  description: string;
  /** Endpoint string: "METHOD /path" */
  endpoint: string;
  passed: boolean;
  /** HTTP status returned, if the request reached the server */
  httpStatus?: number;
  /** One-line explanation of pass/fail */
  reason: string;
  durationMs: number;
}

/**
 * Aggregate result of the candidate's self-verification phase.
 * Written to candidates/<id>/self-verification.json.
 */
export interface SelfVerificationResult {
  runId: RunId;
  /** true only when serverStarted && every check passed */
  passed: boolean;
  serverStarted: boolean;
  checks: SelfVerificationCheck[];
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
  /** Absolute path to recording-manifest.json */
  manifestPath?: string;
  /** Absolute path to api-trace.json */
  tracePath?: string;
  /** Absolute path to frame-index.json (video ingestion index) */
  frameIndexPath?: string;
  completedAt: string;
}

// ─── Recording Manifest ───────────────────────────────────────────────────────

export interface RecordingStepEntry {
  index: number;
  description: string;
  /** true when the step completed with exit code 0 */
  passed: boolean;
  durationMs: number;
}

// ─── Video Ingestion ──────────────────────────────────────────────────────────

/**
 * V1 video ingestion strategy: screenshot frame index.
 *
 * The recorder already captures a screenshot at every API step with a contextual
 * overlay (method, path, status, response preview). Instead of extracting raw
 * video frames (requires ffmpeg) or running vision models at record time
 * (expensive), we index these screenshots into a structured manifest.
 *
 * Evaluators call loadFrames() to selectively read + base64-encode only the
 * frames they want — typically key frames (first, failures, verify steps).
 * Loaded frames map directly to Claude's image block format.
 */

/**
 * One indexed screenshot frame from a recording session.
 * Corresponds 1-to-1 with an api-trace step that has a screenshot.
 */
export interface VideoFrame {
  /** 1-indexed position within the API steps */
  stepIndex: number;
  description: string;
  /** "METHOD /resolved-path", e.g. "POST /todos" */
  endpoint: string;
  httpStatus?: number;
  passed: boolean;
  /** Absolute path to the PNG screenshot */
  screenshotPath: string;
  /**
   * true for frames that are especially informative for evaluation:
   * - first frame (baseline state before any mutations)
   * - POST frames (resource just created)
   * - verify frames (GET after PUT or DELETE)
   * - any failed frame
   * - last frame (final state)
   */
  isKeyFrame: boolean;
}

/**
 * Lightweight index of all extractable frames from a recording.
 * Written to recording/frame-index.json.
 * Load images on demand via loadFrames() — nothing is base64-encoded here.
 */
export interface VideoFrameIndex {
  runId: RunId;
  /** Absolute path to the video file, if captured */
  videoPath?: string;
  frames: VideoFrame[];
  /** Count of frames flagged as key frames */
  keyFrameCount: number;
  createdAt: string;
}

/**
 * A frame with its image content loaded and ready for a multimodal LLM call.
 * base64 + mediaType map directly to Claude's image block source format.
 */
export interface LoadedVideoFrame extends VideoFrame {
  base64: string;
  mediaType: "image/png";
  sizeBytes: number;
}

// ─── API Trace ────────────────────────────────────────────────────────────────

/**
 * One HTTP interaction captured during recording.
 * Includes full request/response and the path to the screenshot taken at that moment.
 * Structured so a debate agent can evaluate each step independently.
 */
export interface ApiTraceStep {
  /** 1-indexed position within the API steps (not the overall demoLog index) */
  index: number;
  description: string;
  method: string;
  /** Resolved path with :id substituted, e.g. /todos/3 */
  path: string;
  /** JSON request body sent, if any */
  requestBody?: string;
  httpStatus?: number;
  /** Full response body text (up to 4 KB) */
  responseBody?: string;
  passed: boolean;
  /** Absolute path to the screenshot captured with the overlay visible */
  screenshotPath?: string;
  durationMs: number;
}

/**
 * Machine-readable trace of the full recording scenario.
 * Written as api-trace.json alongside the video.
 * Primary input for future debate agents doing multimodal review.
 */
export interface ApiTrace {
  runId: RunId;
  /** Spec goal — what the scenario is demonstrating */
  scenarioTitle: string;
  serverStarted: boolean;
  baseUrl: string;
  steps: ApiTraceStep[];
  summary: {
    totalSteps: number;
    passed: number;
    failed: number;
    /** Unique "METHOD /path-template" strings exercised in this scenario */
    endpointsCovered: string[];
  };
  completedAt: string;
}

/**
 * Human-reviewable summary of a recording session.
 * Written alongside demo-log.json as recording-manifest.json.
 * Designed for quick scan: did the scenario pass, which steps failed, where is the video.
 */
export interface RecordingManifest {
  runId: RunId;
  /** Spec goal — the one-sentence description of what's being demonstrated */
  scenarioTitle: string;
  serverStarted: boolean;
  totalSteps: number;
  stepsPassed: number;
  stepsFailed: number;
  totalDurationMs: number;
  videoPath?: string;
  screenshotCount: number;
  steps: RecordingStepEntry[];
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

/**
 * Deterministic scoring output for a single candidate.
 * Produced by the Evaluator (6-dimension weighted scorer, no LLM calls).
 * Written to candidates/<id>/debate.json.
 *
 * Naming note: this is NOT the LLM debate between evaluators.
 * That is UXDebateResult (ux-debate.json at the run level).
 * The "Debate" name here is a historical artifact from an earlier design.
 */
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

// ─── Repair & Escalation ─────────────────────────────────────────────────────

/**
 * Passed to a worker adapter when a repair cycle is triggered.
 * Contains only what the worker needs to understand the failure and fix it.
 */
export interface RepairContext {
  /** The Playwright checks that failed, triggering this repair */
  failedChecks: SelfVerificationCheck[];
  /** Attempt number (1-indexed). V1 max is 1. */
  attempt: number;
}

/**
 * Result of one bounded repair cycle: the repair build and its re-verification.
 * Written to candidates/<id>/repair-attempt.json.
 */
export interface RepairAttemptResult {
  attempt: number;
  build: BuildResult;
  selfVerification: SelfVerificationResult;
  completedAt: string;
}

/**
 * Emitted when all repair attempts are exhausted and self-verification still fails.
 * Written to candidates/<id>/escalation.json.
 */
export interface EscalationResult {
  runId: RunId;
  candidateId: string;
  /** Summary of why escalation was triggered */
  reason: string;
  /** Checks still failing after the final repair attempt */
  failedChecks: SelfVerificationCheck[];
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
  timeoutMs?: number,
  /** Optional stdin to pipe into the command — avoids host→container file writes */
  stdin?: string,
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
  /** Initial build output */
  build: BuildResult;
  /** Static + runtime checks (independent of server) */
  verification: VerificationResult;
  /** Initial Playwright self-verification against the running server */
  selfVerification: SelfVerificationResult;
  /** Present when initial self-verification failed and a repair was attempted */
  repairAttempt?: RepairAttemptResult;
  /** Present when all repair attempts were exhausted and the candidate still fails */
  escalation?: EscalationResult;
  recording: RecordingResult;
  /** Deterministic 6-dimension score for this candidate. See DebateResult note above. */
  debate: DebateResult;
}

// ─── UX Evaluation ───────────────────────────────────────────────────────────

/**
 * Per-candidate recording artifacts passed to the UX evaluator.
 * Paths are optional — absent when a candidate's recording failed or was skipped.
 */
export interface CandidateUXInput {
  candidateId: string;
  /** Path to recording/frame-index.json */
  frameIndexPath?: string;
  /** Path to recording/api-trace.json */
  tracePath?: string;
  /** Whether the candidate passed Playwright self-verification */
  selfVerificationPassed: boolean;
  /** Design philosophy injected into this candidate's build prompt (used by builder debate) */
  styleHint?: string;
}

/**
 * Per-candidate UX assessment produced by an independent evaluator.
 */
export interface CandidateUXAssessment {
  candidateId: string;
  /** 1 = best among candidates reviewed */
  rank: number;
  /** 0–100 UX quality score */
  score: number;
  strengths: string[];
  weaknesses: string[];
  /**
   * Specific observable moments referenced during evaluation:
   * step descriptions, endpoint+status pairs, response body observations.
   * e.g. "Step 5 (Verify update) — GET /todos/1 → 200, body shows {completed:true}"
   */
  observedMoments: string[];
}

/**
 * Output of independent UX evaluation across all candidates.
 * Written to runs/<runId>/ux-evaluation.json.
 */
export interface UXEvaluation {
  runId: RunId;
  /** Assessments sorted by rank ascending (rank 1 first) */
  ranking: CandidateUXAssessment[];
  /** Cross-candidate tradeoff observations */
  tradeoffs: string[];
  /** candidateId of the recommended winner */
  recommendedWinner: string;
  /** One-paragraph rationale grounded in observable evidence */
  rationale: string;
  completedAt: string;
}

// ─── UX Debate ────────────────────────────────────────────────────────────────

/** One turn in the bounded UX evaluation debate. */
export interface DebateRound {
  /** Speaker ID — "A"/"B" for judge evaluators, "builder-N" for builder agents */
  evaluatorId: string;
  /** 1-based round index */
  roundIndex: number;
  /** The evaluator's argument this turn */
  position: string;
  /** Specific observable moments cited as evidence (step, endpoint, status, excerpt) */
  evidenceRefs: string[];
  /** Points conceded to the opposing evaluator this round */
  concessions: string[];
}

/**
 * Output of the bounded debate phase between two independent UX evaluators.
 * Written to runs/<runId>/ux-debate.json.
 */
export interface UXDebateResult {
  runId: RunId;
  rounds: DebateRound[];
  /** Points both evaluators agreed on */
  consensusPoints: string[];
  /** Points that remained disputed after all rounds */
  disputedPoints: string[];
  /** candidateId of the final recommended winner */
  finalWinner: string;
  /** Paragraph explaining the final verdict grounded in debate evidence */
  finalRationale: string;
  completedAt: string;
}

// ─── Submission ───────────────────────────────────────────────────────────────

export type SubmissionStatus = "submitted" | "queued" | "dry_run" | "failed";

/**
 * Per-candidate block inside a SubmissionPayload.
 * Written for a non-engineer reviewer — avoids internal IDs and raw numbers.
 */
export interface SubmissionCandidateSummary {
  /** "Candidate 1", "Candidate 2", "Candidate 3" — label by rank */
  label: string;
  candidateId: string;
  /** Overall position in the final ranking */
  position: number;
  /** Single sentence: what this candidate did well or where it fell short */
  summary: string;
  strengths: string[];
  weaknesses: string[];
  /** Specific observable moments cited by evaluators */
  observedMoments: string[];
  selfVerificationPassed: boolean;
  /** Absolute path to the recorded demo video (webm) */
  videoPath?: string;
  /** Absolute path to the candidate's workspace (source code) */
  workspacePath: string;
  /** Relative paths of all files the candidate produced */
  files: string[];
  buildDurationMs: number;
  /** Scores assigned by each independent evaluator (0–100) */
  scores: {
    evaluatorA: { score: number; rank: number };
    evaluatorB: { score: number; rank: number };
  };
}

/**
 * One turn in the human-readable debate transcript.
 * Field names are plain English for non-engineer readers.
 */
export interface SubmissionDebateTurn {
  round: number;
  /** Plain label: "Evaluator A (correctness)" or "Evaluator B (quality)" */
  evaluator: string;
  /** "Opening" for rounds 1–2, "Rebuttal" for rounds 3–4 */
  role: "Opening" | "Rebuttal";
  position: string;
  /** Specific UX moments cited as evidence */
  evidenceRefs: string[];
  /** Points granted to the opposing evaluator */
  concessions: string[];
}

/**
 * The complete human-review package for one pipeline run.
 * Written to runs/<runId>/submission.json and sent to the submission destination.
 *
 * Designed to be understood by a non-engineer reviewer:
 * - Plain-English labels instead of UUIDs
 * - Narrative rationale for the winner
 * - Full ranking with evidence per candidate
 * - Complete debate transcript
 * - Links to all artifacts (video + source)
 */
export interface SubmissionPayload {
  title: string;
  runId: RunId;
  specGoal: string;
  constraints: string[];
  successCriteria: Array<{ kind: string; description: string }>;

  /** The recommended winner — first thing a reviewer sees */
  winner: SubmissionCandidateSummary;

  /**
   * All candidates ranked, winner first.
   * A reviewer can scan this to understand the relative quality of each solution.
   */
  ranking: SubmissionCandidateSummary[];

  debate: {
    /** true when both independent evaluators agreed on the winner before debating */
    evaluatorsAgreed: boolean;
    /** What both evaluators found to be unambiguously true */
    consensusPoints: string[];
    /** Points the evaluators argued about — useful signal for close calls */
    disputedPoints: string[];
    /** Full 4-round transcript, plain-English labels */
    transcript: SubmissionDebateTurn[];
    /** Final verdict paragraph from the debate synthesis */
    finalRationale: string;
  };

  /** Summary of each independent evaluation for context */
  evaluations: {
    A: { focus: string; recommendedWinner: string; tradeoffs: string[] };
    B: { focus: string; recommendedWinner: string; tradeoffs: string[] };
  };

  pipelineStats: {
    totalDurationMs: number;
    /** Human-readable: "2 min 34 sec" */
    totalDuration: string;
    candidateCount: number;
    completedAt: string;
  };
}

/** What the Submitter returns after sending or persisting a payload. */
export interface SubmissionResult {
  submissionId: string;
  status: SubmissionStatus;
  /** Where the payload was sent (URL, queue name, file path, etc.) */
  destination: string;
  /** Absolute path to the persisted payload JSON — always written */
  payloadPath: string;
  submittedAt: string;
}

/** Complete output of a full arena pipeline run (3 candidates by default). */
export interface PipelineResult {
  runId: RunId;
  spec: RunSpec;
  /** One entry per agent/candidate that ran, in execution order. */
  candidates: CandidateRecord[];
  recommendation: Recommendation;
  /** Primary independent UX evaluation (API correctness + CRUD completeness focus) */
  uxEvaluation?: UXEvaluation;
  /** Secondary independent UX evaluation (response quality + consistency focus) */
  uxEvaluationB?: UXEvaluation;
  /** Bounded debate between the two independent evaluators */
  uxDebate?: UXDebateResult;
  /** Submission result — present when a Submitter is configured */
  submission?: SubmissionResult;
  totalDurationMs: number;
  completedAt: string;
}
