# CLAUDE.md — spec-runner

## What this project is

**Spec-Driven Multi-Agent Prototype Runner** — a CLI pipeline that takes a natural language prompt, locks it into a structured spec, then runs 3 independent Claude agents against that spec in parallel-sequential fashion. Each agent produces build artifacts; all are verified, recorded, and scored. The best candidate wins.

Pipeline stages (in order): **Provision → Build → Record → Debate → Submit**

---

## Commands

```bash
# Compile (type-check only — no emit needed, we run ts-node or dist/)
npx tsc --noEmit

# Compile to dist/
npx tsc

# Full pipeline from prompt
node dist/cli.js pipeline "Build a minimal Express REST API for a todo list in TypeScript"

# Lock a spec only (no execution)
node dist/cli.js run "..."

# Re-run pipeline against an existing locked spec
node dist/cli.js exec <runId>

# Inspect a run's artifacts
node dist/cli.js show <runId>
```

---

## Environment

```
ANTHROPIC_API_KEY   required for pipeline/run/exec with claude adapter
RUNS_DIR            override artifact storage path (default: ./runs)
```

Put secrets in `.env` — loaded automatically via `dotenv/config` at startup.

---

## Architecture

```
src/
  cli.ts                       — entry point, command dispatch
  types/index.ts               — ALL shared types (single source of truth)
  logger.ts                    — log(prefix, msg) → stderr
  events/                      — append-only JSONL event log per run
  orchestrator/
    pipeline.ts                — outer loop: 3 candidates, picks best
    candidate-runner.ts        — single candidate lifecycle coordinator
    spec-builder.ts            — prompt → locked RunSpec via Claude tool_use
    index.ts                   — Orchestrator interface
  environment/
    index.ts                   — EnvironmentManager interface + DEFAULT_ENVIRONMENT_CONFIG
  workspace/                   — filesystem workspace allocation
  candidate/                   — candidate record persistence (fs-manager)
  worker/
    adapter.ts                 — WorkerAdapter interface + registry
    stub-adapter.ts            — no-op stub (always succeeds, no files)
    claude-adapter.ts          — calls Claude to produce real implementation
  verifier/                    — static + runtime checks against spec criteria
  recorder/                    — Playwright headless demo recording + screenshots
  evaluator/                   — deterministic scoring across 6 dimensions → DebateResult
```

### Key invariants

- **RunSpec is immutable once locked.** `lockedAt` being set is the seal. Never mutate after.
- **All IDs are UUID v4.** All timestamps are ISO 8601 strings. Scores are 0–100 integers.
- **`NUM_CANDIDATES = 3`** in `pipeline.ts` — change here only.
- **Evaluator is deterministic** — no LLM calls, all scoring from structured artifacts.
- **`environmentManager` is optional** in `CandidateRunnerDeps` — when absent the flow is identical to V1. Wire it when adding Docker/VM backends.

---

## Module conventions

- ESM (`"type": "module"`), imports must use `.js` extensions even for `.ts` source files.
- `tsconfig.json` uses `NodeNext` module resolution and `exactOptionalPropertyTypes: true`.
- No test framework yet — verify with `npx tsc --noEmit` + manual pipeline smoke test.
- Log prefixes match pipeline stage: `[provision]`, `[arena]`, `[build]`, `[record]`, `[debate]`.

---

## Artifact layout

```
runs/
  <runId>/
    run.json           — RunRecord (status, prompt, timestamps)
    spec.json          — locked RunSpec
    events.jsonl       — append-only event log
    result.json        — PipelineResult (written on completion)
    candidates/
      <candidateId>/
        candidate.json
        result.json    — BuildResult
        debate.json    — DebateResult
        workspace/     — all files the worker produced
```

---

## Adding a new worker adapter

1. Implement `WorkerAdapter` from `src/worker/adapter.ts`
2. Register it: `workers.register(createMyAdapter(...))`  in `cli.ts` `buildOrchestrator()`
3. Set `workerConfig.adapterName` in spec or default config

## Adding a real EnvironmentManager backend

1. Implement `EnvironmentManager` from `src/environment/index.ts`
2. Pass it as `environmentManager` in `OrchestratorConfig` → threaded to `CandidateRunnerDeps`
3. Lifecycle: `provision` → `activate` (before build) → `release` (after debate)
