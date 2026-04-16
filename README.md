# Spec-Driven Multi-Agent Prototype Runner

A production-minded pipeline that takes a natural-language prototype request,
converts it to a locked specification, then runs **3 independent Claude agents**
against that spec. Each candidate is verified, recorded, and scored. The best
candidate wins.

Designed for: traceability, isolation, reproducibility, and explicit agent
boundaries.

---

## Pipeline stages

```
User Prompt
     │
     ▼
┌─────────────────────────────────────────────┐
│  PROVISION                                  │
│  SpecBuilder: prompt → locked RunSpec       │
│  (LLM call, tool_use, written to spec.json) │
└────────────────────┬────────────────────────┘
                     │  × 3 candidates (sequential)
                     ▼
┌─────────────────────────────────────────────┐
│  BUILD                                      │
│  WorkerAdapter: spec → artifacts in         │
│  candidates/<id>/workspace/                 │
│  (bounded by timeoutMs + maxTokenBudget)    │
└────────────────────┬────────────────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│  BUILD VERIFY                               │
│  Verifier: reads workspace only →           │
│  CheckResult per SuccessCriterion           │
│  (static file checks + runtime exec)        │
└────────────────────┬────────────────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│  RECORD                                     │
│  Recorder: starts server → Playwright demo  │
│  → DemoLog + demo.webm + screenshots        │
└────────────────────┬────────────────────────┘
                     ▼
┌─────────────────────────────────────────────┐
│  DEBATE                                     │
│  Evaluator: structured artifacts → 6-dim    │
│  weighted score → DebateResult              │
│  (deterministic, no LLM calls)              │
└────────────────────┬────────────────────────┘
                     ▼
             PipelineResult
       best candidate → recommendation
       (runs/<runId>/result.json)
```

---

## Key design decisions

| Concern | Decision |
|---|---|
| Spec mutability | `RunSpec` is locked on creation; `lockedAt` is write-once |
| Event log | Append-only JSONL at `runs/<id>/events.jsonl`; never mutated |
| Multi-candidate | 3 agents run sequentially against the same spec; best debate score wins |
| Worker isolation | Worker writes only inside its workspace; no callbacks to orchestrator |
| Verifier independence | Reads spec + workspace only; cannot call the worker |
| Recorder determinism | Demo script derived from spec; same spec = same script |
| Evaluator | Deterministic, no LLM; all scores trace to `EvaluationEvidence` |
| Compute isolation | Optional Docker backend: one container per candidate, bind-mounted workspace |

---

## Evaluation rubric

| Dimension | Weight | Signal source |
|---|---|---|
| Correctness | 30 | VerificationResult pass rate (non-skipped checks) |
| Runtime stability | 20 | Server start + runtime criteria pass rate |
| Reproducibility | 15 | Artifacts produced + server started + video captured |
| Implementation simplicity | 15 | File count, total size, build-manifest present |
| Demo quality | 10 | Server started + video + screenshots |
| Evidence confidence | 10 | Worker claim vs. independent verification |

Thresholds: `>= 75` → **accept** · `50–74` → **needs-revision** · `< 50` → **reject**

---

## Setup

```bash
npm install
npx tsc                          # compile to dist/
npx playwright install chromium  # enables video + screenshots
cp .env.example .env             # add ANTHROPIC_API_KEY
```

---

## Commands

### Full pipeline

```bash
node dist/cli.js pipeline "Build a minimal Express REST API for a todo list in TypeScript"
```

Runs all 5 stages for 3 candidates and prints `PipelineResult` as JSON.

### Two-step (spec then execute)

```bash
# Lock a spec without executing
node dist/cli.js run "Build a minimal Express REST API for a todo list in TypeScript"

# Re-run pipeline against an existing locked spec
node dist/cli.js exec <runId>
```

`exec` is useful for re-running after inspecting the spec or changing adapters.

### Inspect a run

```bash
node dist/cli.js show <runId>
```

---

## Docker environment (optional)

Each candidate can run in an isolated Docker container instead of the host process.

**Build the image once:**

```bash
bash docker/build.sh
```

The image (`spec-runner-env:latest`) is based on
`mcr.microsoft.com/playwright:v1.49.0-noble` and includes Node 20, Chromium,
TypeScript, and ts-node.

**Enable Docker isolation:**

```bash
DOCKER_ENV=1 node dist/cli.js pipeline "Build a minimal Express REST API..."
```

Per candidate, the manager will:
1. Provision a container with the workspace bind-mounted at `/workspace`
2. Allocate a free host port mapped to container port 3000
3. Route `npm install`, `tsc`, and runtime verification commands via `docker exec`
4. Start the app server inside the container; Playwright connects from the host
5. Stop and remove the container after the Debate stage completes

Without `DOCKER_ENV=1`, all commands run on the host as before.

---

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | yes (for `pipeline`, `run`, claude `exec`) | — | Spec builder + claude worker adapter |
| `RUNS_DIR` | no | `./runs` | Override artifact storage path |
| `DOCKER_ENV` | no | — | Set to `1` to enable Docker environment isolation |

---

## Artifact layout

```
runs/
├── .env-index/
│   └── <envId>.json              ← Docker environment lookup index
└── <runId>/
    ├── run.json                  ← RunRecord (status, prompt, timestamps)
    ├── spec.json                 ← locked RunSpec (immutable after lockedAt)
    ├── events.jsonl              ← append-only stage event log
    ├── result.json               ← PipelineResult (best candidate + all scores)
    └── candidates/
        └── <candidateId>/
            ├── candidate.json        ← status, adapterName, environmentId
            ├── environment.json      ← EnvironmentRecord (Docker: containerId, hostPort)
            ├── workspace/            ← all files written by the worker
            │   ├── build-manifest.json
            │   └── ...
            ├── result.json           ← BuildResult (success, artifacts, tokens)
            ├── verification.json     ← VerificationResult (checks, state)
            ├── debate.json           ← DebateResult (dimensions, score, recommendation)
            └── recording/
                ├── demo-log.json     ← DemoStep[] with exit codes
                ├── demo.webm         ← video (when server started + Playwright available)
                └── screenshots/
                    └── step-api-N.png
```

---

## Module map

```
src/
  cli.ts                       — entry point, command dispatch
  types/index.ts               — all shared types (single source of truth)
  logger.ts                    — log(prefix, msg) → stderr
  events/                      — append-only JSONL event log
  environment/
    index.ts                   — EnvironmentManager interface, ExecFn/ServerSpawnFn types
    docker-manager.ts          — Docker backend (provision/activate/release/get)
  orchestrator/
    pipeline.ts                — outer loop: 3 candidates, picks best by debate score
    candidate-runner.ts        — single candidate lifecycle coordinator
    spec-builder.ts            — prompt → locked RunSpec via Claude tool_use
    index.ts                   — OrchestratorConfig interface
  workspace/                   — filesystem workspace allocation
  candidate/                   — candidate record persistence
  worker/
    adapter.ts                 — WorkerAdapter interface + registry
    stub-adapter.ts            — no-op stub (always succeeds)
    claude-adapter.ts          — calls Claude to produce implementation
  verifier/
    default-verifier.ts        — dispatches to check implementations
    checks/static.ts           — file existence checks
    checks/runtime.ts          — shell command + exit code checks
    checks/llm.ts              — stub (skipped in V1)
  recorder/
    default-recorder.ts        — Playwright demo: server start → API calls → video
    server.ts                  — server spawn, port polling, workspace prep
  evaluator/
    default-evaluator.ts       — weighted aggregate of 6 dimensions
    dimensions.ts              — deterministic scorer functions
```
