# 15-Minute Walkthrough

A suggested sequence for demoing the system to a reviewer. Each section has a time budget, the specific file or artifact to open, and the key point to land.

Have two terminal windows ready: one in the repo root, one showing `runs/` (or a pre-baked run directory if you'd rather not wait for a live run).

---

## 0:00 – 1:30 | The problem this solves

**Open:** `README.md` → Pipeline overview diagram

The core premise: natural-language prompts produce ambiguous implementations. This system locks the spec *before* any agent starts, runs three independent implementations in parallel, then evaluates them not by reading code but by watching them work. The evaluation is multimodal, grounded in HTTP traces and screenshots, and adversarial (two evaluators with different lenses who then debate).

Key point to land: **the spec is immutable from the moment it's locked**. No agent can change what it's being evaluated against.

---

## 1:30 – 3:30 | Spec provisioning

**Open:** `src/orchestrator/spec-builder.ts`, then a real `runs/<runId>/spec.json`

Show that `buildScript(spec)` in `src/recorder/default-recorder.ts` derives the CRUD script from the spec — the same function the recorder and self-verifier both call. The spec determines the endpoints; no agent invents its own test plan.

Point out: `lockedAt` is set once. Anything reading the spec after that gets the same value.

**Likely question:** *What if the LLM parses the prompt wrong?*
→ The spec is written to `spec.json` before execution. You can run `node dist/cli.js run "<prompt>"` to inspect the spec without executing, then `exec <runId>` to proceed.

---

## 3:30 – 6:30 | Parallel agents + teardown reliability

**Open:** `src/orchestrator/candidate-runner.ts`

Walk the structure:
1. Environment provisioned *before* the `try` block — failure here is fast and fatal
2. All stages run inside `try/finally` — the environment is released on success, failure, and timeout
3. `withTimeout(label, promise, ms)` at the top of the file — every stage has a hard ceiling; no silent hangs
4. `safeRelease` swallows cleanup errors so they never mask the original failure

Show the timeout constants:
```typescript
const TIMEOUT_MS = {
  BUILD:        300_000,
  SELF_VERIFY:   45_000,
  RECORD:       120_000,
  DEBATE:        30_000,
  ENV_OPERATION: 30_000,
};
```

Point out `Promise.allSettled` in `pipeline.ts` — one agent crashing does not cancel the other two.

**Likely question:** *What if Docker is unavailable?*
→ Default is local-process. `DOCKER_ENV=1` enables Docker. The pipeline code is identical either way.

---

## 6:30 – 8:30 | Self-verification and bounded repair

**Open:** `src/verifier/self-verifier.ts`

Show the flow:
- Playwright `APIRequestContext` (no browser launch) probes each CRUD endpoint
- Same endpoint list as the recorder — both call `createRecorder().buildScript(spec)`
- `serverHandle.kill()` is in a `finally` block — the process is always killed
- One repair cycle: Claude receives `repairContext = { failedChecks, attempt: 1 }` and the original spec

If you have a run with a repair attempt, open `candidates/<id>/repair-attempt.json`. If there's an escalation, open `escalation.json`.

**Likely question:** *Does the agent know it's being self-verified?*
→ No. It gets the spec on the initial build. On repair it gets the spec plus a list of which endpoints failed and their HTTP statuses. It doesn't know about the parallel candidates or the evaluation pipeline.

---

## 8:30 – 10:30 | Recording as proof of work

**Open:** `runs/<runId>/candidates/<id>/recording/api-trace.json`, then a screenshot

Show that `api-trace.json` contains per-step HTTP method, path, status, and up to 4 KB of response body — this is the primary evidence source for evaluators, not the video.

Open a screenshot to show the overlay (step N/7, endpoint, HTTP status, description). The overlay is injected via `page.evaluate()` so it appears in the `.webm` as well.

Point out the 7-step CRUD narrative in `src/recorder/default-recorder.ts`: create → read → update → verify update persisted → delete → verify deleted → list final state. This is not configurable — it's derived deterministically from the spec.

**Likely question:** *Why not just check the exit code of the build?*
→ A build can succeed and produce a server that returns 500 on every endpoint. The recording captures whether the implementation actually works end-to-end.

---

## 10:30 – 12:30 | Evaluation and debate

**Open:** `src/ux-evaluator/claude-evaluator.ts` (persona addendum), then `src/ux-evaluator/debate.ts` (tool schema)

Show the two persona addenda — Evaluator A (correctness + CRUD completeness) and Evaluator B (response quality + consistency). These are appended to the same base system prompt, producing genuinely different assessments from the same underlying model.

Show the `DEBATE_TOOL` schema: `rounds` is an array of exactly 4, each requiring `evidenceRefs` and `concessions` as non-optional fields. A round without evidence citations is structurally invalid.

If you have a `ux-debate.json`, open it and read a rebuttal round aloud. The concessions are usually the most interesting part — where the model actually grants a valid point.

**Likely question:** *Why not run the debate as a real multi-turn conversation?*
→ Single call = bounded cost, fixed turn count, no sycophantic convergence (later speakers echoing earlier ones). The transcript is generated all at once; the adversarial structure is in the prompt, not in actual turn-by-turn exchange.

---

## 12:30 – 13:30 | Submission

**Open:** `runs/<runId>/submission.json`

Point out: plain positional labels ("Candidate 1", "Candidate 2") not UUIDs. One-sentence summary per candidate. Absolute workspace and video paths. Full debate transcript with human-readable evaluator labels.

Show the `Submitter` interface in `src/submitter/index.ts` — `submit(payload): Promise<SubmissionResult>`. The stub writes to disk and returns `dry_run`. Set `SUBMIT_WEBHOOK_URL` to POST to any endpoint. `createSlackFormatter()` and `createDiscordFormatter()` are stubs in `webhook-submitter.ts` ready to fill in.

---

## 13:30 – 15:00 | Live run or Q&A

**If running live:**
```bash
npm run compile
npm run arena -- "Build a minimal Express REST API for a todo list in TypeScript"
```

Point out the stage separators on stderr as they appear. When the completion banner prints, show how stdout is clean JSON and pipeable.

**If showing a pre-baked result:**
```bash
cat runs/<runId>/result.json | jq '{winner: .uxDebate.finalWinner, rationale: .uxDebate.finalRationale}'
cat runs/<runId>/submission.json | jq '{title, winner: .winner.label, summary: .winner.summary}'
```

**Expected questions:**
- *How would you scale this to more than 3 candidates?* → Change `NUM_CANDIDATES` in `pipeline.ts`. The rest is already parallel.
- *What's the weakest part?* → Port contention in local-process mode; naive `:id` substitution in self-verifier; no Claude API retry. All documented in README rough edges.
- *Why not just use the video directly?* → Screenshots with semantic overlays are more information-dense per token than raw frames, and avoid the ffmpeg dependency. The `.webm` is kept for human review.

---

## Files a reviewer should read first

In order of importance:

1. `README.md` — full design rationale, rough edges, artifact layout
2. `src/orchestrator/candidate-runner.ts` — single candidate lifecycle + cleanup guarantees
3. `src/ux-evaluator/debate.ts` — the debate format and why
4. `src/submitter/payload-builder.ts` — what the submission payload contains and how it's assembled
5. `conversation-history.md` — full AI chat history showing how the system was built
