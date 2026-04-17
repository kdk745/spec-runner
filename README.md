# spec-runner

A pipeline that takes a natural-language prompt, locks it into a structured spec, runs three independent Claude agents against it in parallel, records each agent's working implementation, evaluates and debates the results across two independent reviewers, and delivers a structured submission for human review.

This document is written for engineers evaluating the design. It covers the decisions that were made, why, and what is still rough.

---

## For reviewers

| What | Where |
|------|-------|
| Full AI conversation history | [`conversation-history.md`](./conversation-history.md) |
| 15-minute walkthrough outline | [`submission/DEMO_WALKTHROUGH.md`](./submission/DEMO_WALKTHROUGH.md) |
| Environment variable reference | [`.env.example`](./.env.example) |
| All design rationale and rough edges | This document (sections below) |

**Quickest path to running it:**
```bash
cp .env.example .env          # add your ANTHROPIC_API_KEY
npm install && npm run compile
npx playwright install chromium
npm run arena -- "Build a minimal Express REST API for a todo list in TypeScript"
```

Artifacts land in `./runs/<runId>/`. The completion banner on stderr lists every path.

---

## Table of contents

1. [Pipeline overview](#pipeline-overview)
2. [Infrastructure and isolation model](#infrastructure-and-isolation-model)
3. [Teardown reliability](#teardown-reliability)
4. [Agent topology](#agent-topology)
5. [Self-verification and bounded repair](#self-verification-and-bounded-repair)
6. [Recording as proof of work](#recording-as-proof-of-work)
7. [Video ingestion for evaluation](#video-ingestion-for-evaluation)
8. [Evaluation and debate format](#evaluation-and-debate-format)
9. [Submission design](#submission-design)
10. [Running the pipeline](#running-the-pipeline)
11. [Rough edges and known gaps](#rough-edges-and-known-gaps)
12. [Artifact layout](#artifact-layout)
13. [Module map](#module-map)

---

## Pipeline overview

```
Prompt
  │
  ▼  PROVISION
  │  Claude parses prompt → locked RunSpec (goal, constraints, success criteria)
  │  Written to runs/<runId>/spec.json before any agent starts.
  │  The spec is immutable from this point forward.
  │
  ├──────────────────────────────────────────────────┐
  │  BUILD ×3 (parallel, Promise.allSettled)         │
  │  Each candidate:                                 │
  │    1. Claude writes implementation to workspace  │
  │    2. Playwright HTTP self-verification          │
  │    3. One bounded repair attempt if failed       │
  │    4. Playwright CRUD recording + screenshots    │
  │    5. Deterministic 6-dimension scoring          │
  │  One failure does not cancel the other two.      │
  └──────────────────────────────────────────────────┘
  │
  ▼  EVALUATE A  (API correctness + CRUD completeness lens)
  │  EVALUATE B  (response quality + UX consistency lens)
  │  Each evaluator reviews all 3 candidates simultaneously
  │  using api-trace.json + key screenshots.
  │
  ▼  DEBATE
  │  4-round structured transcript (A-open, B-open, A-rebut, B-rebut)
  │  Single Claude call, tool_use-forced structured output.
  │  Produces final winner + rationale grounded in evidence.
  │
  ▼  SUBMIT
     Payload assembled (winner, ranking, transcript, artifact links).
     Written to submission.json.
     POSTed to SUBMIT_WEBHOOK_URL if set, otherwise dry-run.
```

---

## Infrastructure and isolation model

### Default: local-process

By default every candidate runs as a child process on the host. Each candidate gets its own directory (`runs/<runId>/candidates/<id>/workspace/`) and its own server process (killed after recording). There is no container boundary.

**What is isolated:** filesystem (separate workspace directories), server process (spawned and killed per stage), Node.js working directory.

**What is not isolated:** host port space, Node modules cache, host network, host file descriptors. Three candidates run in parallel; all three servers start simultaneously and compete for ports. Port selection uses `waitForPort` polling with a preferred-port hint from the spec, but a race condition is possible if two candidates happen to select the same port before either binds.

**Practical implication:** local-process isolation is sufficient for well-behaved candidates that bind to a single port and don't write outside their workspace. It is not suitable for candidates that write to shared system paths or spawn background processes that outlive the kill signal.

### Optional: Docker (DOCKER_ENV=1)

Set `DOCKER_ENV=1` to run each candidate in an isolated container.

```bash
DOCKER_ENV=1 node dist/cli.js pipeline "..."
```

The Docker manager provisions one container per candidate from a pre-built image (`spec-runner-env:latest`). It allocates a free host port, bind-mounts the workspace at `/workspace`, routes `npm install` / `tsc` / server start through `docker exec`, and maps Playwright's recording traffic from the host to the container port.

**What Docker adds:** network namespace isolation, process tree isolation, no port collision between candidates. The container is removed in the `finally` block of candidate-runner (see Teardown section).

**What Docker costs:** ~10–30 s provisioning overhead per candidate; requires a running Docker daemon; the image must be built once (`bash docker/build.sh`). Parallel container provisioning means all three start simultaneously, which can stress the Docker daemon on low-resource machines.

**The trade-off is explicit in config:**

```typescript
// src/environment/index.ts
export const DEFAULT_ENVIRONMENT_CONFIG: EnvironmentConfig = {
  isolationType: "local-process",
};
```

Switching to Docker changes one environment variable. The pipeline code is identical.

---

## Teardown reliability

The previous version called `environmentManager.release()` at line 300 of `candidate-runner.ts` — reachable only if all preceding stages succeeded. Any stage throw skipped it.

The current version wraps all candidate execution in `try/finally`:

```typescript
// src/orchestrator/candidate-runner.ts
let currentEnv: Environment | null = null;

// provision happens before try — failure here is fatal and correct
if (environmentManager) {
  currentEnv = await withTimeout("env.provision", ..., TIMEOUT_MS.ENV_OPERATION);
}

try {
  // build, self-verify, repair, record, debate
} catch (err) {
  log("cleanup", `${tag} stage failed — ${msg}`);
  throw err;         // re-throw so the caller sees the original error
} finally {
  if (environmentManager && currentEnv) {
    await safeRelease(environmentManager, currentEnv, ...);
  }
}
```

`safeRelease` catches and logs errors from `release()` without propagating them — cleanup failure never masks the stage failure that caused it.

### Stage timeouts

Every async stage is wrapped with `withTimeout(label, promise, ms)` which races the operation against a `setTimeout` rejection:

| Stage | Timeout | Notes |
|-------|---------|-------|
| `build` | 5 min | Adapter has its own inner budget; this is the hard ceiling |
| `self-verify` | 45 s | Covers 15 s server wait + all HTTP checks |
| `record` | 2 min | Playwright video capture |
| `debate` | 30 s | Deterministic evaluator |
| `env.provision/activate/release` | 30 s each | Docker API calls |

Timeouts reject with `[timeout] <label> did not complete within <N>ms`, which appears in `events.jsonl` and stderr. No stage can hang silently.

### Server process cleanup in self-verifier

`serverHandle.kill()` was previously called after the Playwright block — unreachable if `ctx.dispose()` threw. It is now in its own `finally` with a catch that logs but does not propagate:

```typescript
try {
  // Playwright probes, ctx.dispose() in inner finally
} finally {
  try { serverHandle.kill(); }
  catch (err) { log("self-verify", `kill failed (non-fatal) — ${msg}`); }
}
```

**Known gap:** if the Node process itself receives SIGKILL (OOM, hard kill), `finally` blocks do not run and Docker containers will leak. Recovery requires `docker ps` inspection. This is a known limitation of process-model isolation.

---

## Agent topology

Three agents run concurrently via `Promise.allSettled`. They share no state during execution.

```typescript
// src/orchestrator/pipeline.ts
const settled = await Promise.allSettled(
  Array.from({ length: NUM_CANDIDATES }, () => runCandidate(spec, deps))
);
```

`Promise.allSettled` (not `Promise.all`) means one agent crashing does not cancel the other two. Each `CandidateRunnerDeps` object is shared (same event log, same worker registry) but each agent creates its own `Candidate` record and writes only to its own workspace path.

**The spec is locked before any agent starts.** All three agents receive an identical `RunSpec`. There is no coordination, no shared memory, and no way for agent 1 to observe what agent 2 is building. The only shared resource is the event log, which is append-only (JSONL) and safe for concurrent appends at the OS level (each `append` call is a single `appendFile` write).

**Worker registry** is a simple name-keyed map. The `claude` adapter is registered once; all three candidates call `workers.get("claude")` and get the same adapter instance. The adapter is stateless between calls — `execute(spec, workspace)` only writes to the provided workspace path.

---

## Self-verification and bounded repair

After each build, the agent self-verifies using Playwright's `APIRequestContext` (HTTP only — no browser, no video). The endpoint list is derived from the same `buildScript(spec)` call the recorder uses, so the same operations are checked at both stages.

```
Build completes
  │
  ▼
selfVerify(): probe each CRUD endpoint
  ├── all passed → continue to Record
  └── any failed →
        repairContext = { failedChecks, attempt: 1 }
        adapter.execute(spec, workspace, repairContext)
          │  Claude receives the original spec + list of failing endpoints + HTTP statuses
          │  Writes only changed files (workspace still has previous artifacts)
          ▼
        selfVerify() again
          ├── passed → continue to Record
          └── still failed → write escalation.json, continue to Record anyway
```

One repair cycle maximum (`MAX_REPAIR_ATTEMPTS = 1`). The escalation artifact is written to disk but does not abort the pipeline — a candidate with a failing self-verification still proceeds to recording and scoring. This is intentional: a partially working implementation may still produce useful signal for the evaluators.

**What self-verification catches:** server won't start, missing routes (404 instead of 200), wrong method handling, total crashes. **What it does not catch:** incorrect response bodies, non-idempotent behavior, subtle schema errors. Those are caught by the evaluators using the api-trace.

**ID substitution is naive.** The self-verifier replaces `:id` / `{id}` in paths with the `id` / `_id` / `uuid` field from the last POST response. If a candidate uses a different field name (e.g. `todoId`), the substitution falls back to `/1`, which may not exist. This is a known limitation documented in the Rough Edges section.

---

## Recording as proof of work

"Build succeeded" is a weak signal. A build can succeed while producing a server that returns 500 on every request. The recording stage runs a scripted 7-step CRUD narrative against the live server and captures every HTTP exchange:

```
Step 1: POST   /todos        { title: "Buy milk" }     → 201  ✓
Step 2: GET    /todos                                   → 200  ✓
Step 3: GET    /todos/:id                               → 200  ✓
Step 4: PUT    /todos/:id    { completed: true }        → 200  ✓
Step 5: GET    /todos/:id    (verify update persisted)  → 200  ✓
Step 6: DELETE /todos/:id                               → 204  ✓
Step 7: GET    /todos/:id    (verify deletion)          → 404  ✓
```

Each step produces a screenshot with a semantic overlay (step N/7, endpoint, HTTP status, description). The overlay is injected via `page.evaluate()` so it appears in the recorded video and all screenshots.

`api-trace.json` stores the full response body (up to 4 KB) and HTTP status for each step. This is the primary evidence source for the evaluators — not the video.

The video artifact (`.webm`) is captured via Playwright's built-in video recording. It exists as a human-inspectable artifact for the submission reviewer but is not fed directly into the LLM evaluation (see next section).

---

## Video ingestion for evaluation

Feeding raw video to an LLM evaluator is impractical: no mature vision API takes `.webm` directly, frame extraction requires ffmpeg (a heavy dependency), and most frames are visually identical between steps.

**The approach used here:** the screenshots already captured during recording — one per API step, with semantic overlays — serve as the "frames" for evaluation. They are indexed in `frame-index.json`:

```json
{
  "runId": "...",
  "keyFrameCount": 4,
  "frames": [
    {
      "stepIndex": 0, "description": "Create todo",
      "endpoint": "POST /todos", "httpStatus": 201,
      "passed": true, "screenshotPath": "...",
      "isKeyFrame": true
    }
  ]
}
```

Key-frame classification selects: the first step, all POST steps, any GET-after-mutation steps, any failures, and the last step. Up to 5 key frames per candidate are loaded at evaluation time via `loadFrames()`, which base64-encodes the PNGs for the multimodal Claude call.

**Trade-off:** this approach is cheap (no ffmpeg, no extra API), leverages screenshots that already exist, and produces information-dense frames (each one has the overlay labeling exactly what happened). The downside is it misses what happens between steps. For a CRUD API evaluation this is acceptable — the observable moments are the HTTP exchanges, not the transitions.

---

## Evaluation and debate format

### Why two independent evaluators

A single evaluator produces one perspective. The correctness evaluator will accept inconsistent response shapes as long as status codes are right; the quality evaluator will penalise a 500 where a 404 was expected. Both are valid signals. Running them independently means their disagreements surface explicitly rather than being averaged into silence.

| Evaluator | Lens | System prompt addendum |
|-----------|------|----------------------|
| A | API correctness + CRUD completeness | Status codes, missing operations, error handling, end-to-end flow |
| B | Response quality + UX consistency | Body structure, create→read agreement, behavioral surprises |

### Debate format

After both independent evaluations, one Claude call generates a 4-round transcript. The format and turn count are fixed before the call; the model cannot extend the debate.

```
Round 1 — Evaluator A opening
Round 2 — Evaluator B opening
Round 3 — Evaluator A rebuttal
Round 4 — Evaluator B rebuttal
→ consensusPoints, disputedPoints, finalWinner, finalRationale
```

Output is forced via `tool_choice: { type: "tool", name: "submit_debate_result" }`. Each round requires `evidenceRefs` (specific step/endpoint/status/excerpt) and `concessions` (points granted to the other side) — these are required fields in the schema, not optional. A round without evidence is structurally invalid.

**Why not freeform multi-turn:** without structural constraints the model restates its opening position at increasing length. The `evidenceRefs` requirement keeps every claim anchored to an observable artifact moment.

**Why not a single supervisor:** suppresses disagreements that are the actual signal. When A and B rank differently, the debate resolves it explicitly.

**Why not more rounds:** four is the minimum for open + rebut per side. Additional rounds in practice add repetition, not new signal. Cost is proportional to rounds; four keeps it bounded.

**When evaluators agree:** the prompt switches to stress-test mode — challenge the consensus, find what evidence would change it. This prevents rubber-stamp confirmation of an obvious winner.

**Cost:** 3 additional Claude API calls per run (Evaluate A, Evaluate B — both multimodal up to 15 images; Debate — text only). Evaluations run sequentially, not in parallel, because the debate requires both to complete first.

---

## Submission design

The `SubmissionPayload` is assembled by `buildSubmissionPayload()` from the completed `PipelineResult`. It is designed for a non-engineer reviewer who has no context about UUIDs, TypeScript, or HTTP.

Key design decisions:
- **Positional labels** ("Candidate 1", "Candidate 2") derived from final ranking, not internal IDs. UUIDs are present for traceability but are not the primary identifier.
- **One-sentence summary per candidate** generated from strengths/weaknesses rather than raw scores.
- **Debate transcript uses plain labels** ("Evaluator A (correctness)", role "Opening" / "Rebuttal") not internal enum values.
- **Workspace paths and video paths are absolute** so the reviewer can open them directly. This means the payload is machine-specific and won't transfer as-is to another machine — a known limitation.
- **Payload is always written to disk** (`submission.json`) before any network call, so the artifact exists regardless of webhook outcome.

### Destination routing

| `SUBMIT_WEBHOOK_URL` set? | Behaviour |
|--------------------------|-----------|
| No | `StubSubmitter` — writes `submission.json`, returns `status: "dry_run"` |
| Yes | `WebhookSubmitter` — POST `application/json`, 10 s timeout, query-string redacted from logs |

`WebhookSubmitter` accepts a `formatter` function for destination-specific shapes. `createSlackFormatter()` and `createDiscordFormatter()` are included as stubs — the structure is correct but the content is minimal. Fill in real Block Kit / Embed fields when wiring the destinations.

---

## Running the pipeline

### Prerequisites

```bash
npm install
npx playwright install chromium   # required for recording + self-verification
cp .env.example .env               # add ANTHROPIC_API_KEY
```

### One command

```bash
npm run compile
npm run arena -- "Build a minimal Express REST API for a todo list in TypeScript"
```

Or directly:

```bash
npx tsc && node dist/cli.js pipeline "Build a minimal Express REST API for a todo list in TypeScript"
```

### What you see

**stderr** — all progress output. Stage separators make phase boundaries visible:

```
══════════════════════════════════════════════════════════════
  SPEC RUNNER ARENA

  Prompt : Build a minimal Express REST API for a todo…
  Output : ./runs
  Adapter: claude
  Submit : dry-run (set SUBMIT_WEBHOOK_URL to send)

  Stages : provision → build ×3 → record → evaluate A+B → debate → submit
══════════════════════════════════════════════════════════════

── PROVISION ─────────────────────────────── locking spec
[14:23:01] [spec] Locking spec …

── BUILD ─────────────────────────── 3 candidates in parallel
[14:23:04] [arena] [abc12345] build starting (adapter: claude)
…

── EVALUATE ──────────────────────────────────── 3 candidates
── DEBATE ───────────────────────── 4-round structured transcript
── SUBMIT ────────────────────────────────────────────────────

══════════════════════════════════════════════════════════════
  PIPELINE COMPLETE

  Run ID   : abc12345-…
  Duration : 1m 28s
  Winner   : Candidate 2 (abc12345)
  Rationale: Strongest end-to-end CRUD flow — all 7 steps…

  Artifacts:
    Result     : ./runs/abc12345…/result.json
    Debate     : ./runs/abc12345…/ux-debate.json
    Submission : ./runs/abc12345…/submission.json  [dry_run]
══════════════════════════════════════════════════════════════
```

**stdout** — structured `PipelineResult` JSON only. Pipe-safe:

```bash
npm run arena -- "Build a REST API" | jq '.uxDebate.finalWinner'
npm run arena -- "Build a REST API" > result.json
```

**On failure:**

```
══════════════════════════════════════════════════════════════
  PIPELINE FAILED

  Error : [timeout] build did not complete within 300000ms

  Partial artifacts (if any) are in:
    ./runs/

  Check events.jsonl inside the run directory for the last stage reached.
══════════════════════════════════════════════════════════════
```

### Other commands

```bash
node dist/cli.js run  "<prompt>"   # lock a spec without executing
node dist/cli.js exec <runId>      # re-run pipeline against existing locked spec
node dist/cli.js show <runId>      # inspect run record, spec, candidate list
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | required | Spec builder, claude worker adapter, UX evaluators, debater |
| `RUNS_DIR` | `./runs` | Override artifact storage path |
| `DOCKER_ENV` | — | Set to `1` to enable Docker isolation |
| `SUBMIT_WEBHOOK_URL` | — | POST destination for submission payload |

---

## Rough edges and known gaps

These are real limitations, not future-work hand-waving.

**Port contention in parallel local execution.** Three candidates start servers simultaneously. Port selection polls for a free port with a preferred hint from the spec. If two candidates select the same port in the window between detection and bind, one will fail to start. In practice this is rare but not impossible. Docker mode eliminates this by giving each container a dedicated network namespace.

**Naive `:id` substitution.** Self-verification and recording substitute `:id` in paths using `body.id ?? body._id ?? body.uuid` from the last POST response. Candidates that use a different ID field name (e.g. `todoId`, `data.id`) will get fallback path `/1`, which may not exist. This causes false negative self-verification failures.

**No streaming on build.** The Claude adapter blocks until the full response returns. Long builds (complex specs, many files) can take 60–90 seconds with no progress indication. The 5-minute timeout is the only visibility into a hung build.

**No Claude API retry.** Rate-limit errors, transient 529s, and network timeouts on the Claude API are not retried. A build failure due to a rate limit looks identical to a model refusing to produce output.

**The per-candidate "debate" is not the LLM debate.** `DebateResult` (in `evaluator/`) is a deterministic 6-dimension weighted scorer that produces a 0–100 score from structured artifacts. The name is a historical artifact from an earlier design. The LLM debate lives in `ux-evaluator/debate.ts` and runs at the pipeline level after all candidates complete. These are two different things and the naming is confusing.

**Submission payload contains absolute paths.** `workspacePath`, `videoPath`, and `payloadPath` are absolute local paths. The payload is not portable to another machine without path rewriting.

**Docker backend requires manual image build.** `spec-runner-env:latest` must be built before `DOCKER_ENV=1` works. There is no automatic pull or build trigger.

**`finally` does not run on SIGKILL.** If the host OOM-kills the Node process, Docker containers will not be released. Run `docker ps -a | grep spec-runner` to find and remove leaked containers.

**Evaluations run sequentially, not in parallel.** Evaluate A and Evaluate B are sequential Claude calls. They could run concurrently (`Promise.all`) to save ~10–20 s per run. Not implemented.

**Frame index uses recording screenshots only.** The `.webm` video file is captured and referenced in the submission but never decoded for frame extraction. Evaluation uses the pre-existing screenshots with overlays. If Playwright's screenshot capture fails for a step, that step has no visual representation in the evaluation.

---

## Artifact layout

```
runs/
└── <runId>/
    ├── run.json                   ← RunRecord (status, timestamps)
    ├── spec.json                  ← locked RunSpec (immutable after lockedAt)
    ├── events.jsonl               ← append-only stage event log
    ├── result.json                ← full PipelineResult
    ├── ux-evaluation.json         ← Evaluator A (correctness lens)
    ├── ux-evaluation-b.json       ← Evaluator B (quality lens)
    ├── ux-debate.json             ← 4-round transcript + final winner
    ├── submission.json            ← SubmissionPayload (always written)
    └── candidates/
        └── <candidateId>/
            ├── candidate.json
            ├── result.json            ← BuildResult
            ├── self-verification.json ← SelfVerificationResult
            ├── repair-attempt.json    ← present if repair ran
            ├── escalation.json        ← present if repair exhausted
            ├── verification.json      ← static + runtime checks
            ├── debate.json            ← deterministic 6-dim score
            ├── environment.json       ← Docker: containerId, hostPort
            └── recording/
                ├── demo.webm
                ├── api-trace.json         ← per-step HTTP trace + response bodies
                ├── frame-index.json       ← screenshot index + key-frame flags
                ├── recording-manifest.json
                └── screenshots/
                    └── step-api-N.png
```

---

## Module map

```
src/
  cli.ts                         entry point, command dispatch, startup/completion banners
  types/index.ts                 single source of truth for all domain types
  logger.ts                      log() / logStage() / logBanner() → stderr
  events/                        append-only JSONL event log per run
  orchestrator/
    pipeline.ts                  outer loop: parallel candidates, evaluate, debate, submit
    candidate-runner.ts          single candidate lifecycle + try/finally cleanup
    spec-builder.ts              prompt → locked RunSpec via Claude tool_use
    index.ts                     OrchestratorConfig interface
  environment/
    index.ts                     EnvironmentManager interface + DEFAULT_ENVIRONMENT_CONFIG
    docker-manager.ts            Docker backend (provision/activate/release)
  workspace/                     filesystem workspace allocation
  candidate/                     candidate record persistence (fs-manager)
  worker/
    adapter.ts                   WorkerAdapter interface + registry
    stub-adapter.ts              no-op stub
    claude-adapter.ts            Claude build + repair prompt construction
  verifier/
    default-verifier.ts          static + runtime checks
    self-verifier.ts             Playwright HTTP self-verification, server kill in finally
  recorder/
    default-recorder.ts          Playwright CRUD demo, api-trace, frame-index
    video-ingest.ts              buildFrameIndex(), loadFrames(), key-frame classification
    server.ts                    server spawn, port polling
  evaluator/
    default-evaluator.ts         deterministic 6-dimension weighted scorer
    dimensions.ts                individual dimension functions
  ux-evaluator/
    index.ts                     UXEvaluator + UXDebater interfaces
    claude-evaluator.ts          multimodal Claude review, persona: correctness | quality
    debate.ts                    4-round structured debate via tool_use, single API call
  submitter/
    index.ts                     Submitter interface
    payload-builder.ts           PipelineResult → SubmissionPayload (human-readable)
    stub-submitter.ts            writes submission.json, status: dry_run
    webhook-submitter.ts         POST to SUBMIT_WEBHOOK_URL, formatter hook for Slack/Discord
```
