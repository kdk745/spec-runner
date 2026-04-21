# Graph Report - src  (2026-04-19)

## Corpus Check
- Corpus is ~29,189 words - fits in a single context window. You may not need a graph.

## Summary
- 217 nodes · 483 edges · 13 communities detected
- Extraction: 77% EXTRACTED · 23% INFERRED · 0% AMBIGUOUS · INFERRED: 109 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Playwright Demo Recorder|Playwright Demo Recorder]]
- [[_COMMUNITY_Claude Worker Adapter|Claude Worker Adapter]]
- [[_COMMUNITY_CLI and Orchestrator Entry|CLI and Orchestrator Entry]]
- [[_COMMUNITY_Module Definitions and Types|Module Definitions and Types]]
- [[_COMMUNITY_Candidate Runner and Docker Env|Candidate Runner and Docker Env]]
- [[_COMMUNITY_Verification and Runtime Checks|Verification and Runtime Checks]]
- [[_COMMUNITY_Claude UX Evaluator|Claude UX Evaluator]]
- [[_COMMUNITY_Scoring Dimensions|Scoring Dimensions]]
- [[_COMMUNITY_Submission Payload Builder|Submission Payload Builder]]
- [[_COMMUNITY_Candidate Persistence|Candidate Persistence]]
- [[_COMMUNITY_Debate Engine|Debate Engine]]
- [[_COMMUNITY_Stub Worker Adapter|Stub Worker Adapter]]
- [[_COMMUNITY_Event Log|Event Log]]

## God Nodes (most connected - your core abstractions)
1. `cmdPipeline()` - 23 edges
2. `log()` - 22 edges
3. `runCandidate()` - 20 edges
4. `buildOrchestrator()` - 17 edges
5. `selfVerify()` - 11 edges
6. `DockerEnvironmentManager` - 10 edges
7. `FsCandidateManager` - 8 edges
8. `cmdRun()` - 6 edges
9. `cmdExec()` - 6 edges
10. `main()` - 6 edges

## Surprising Connections (you probably didn't know these)
- `cmdRun()` --calls--> `log()`  [INFERRED]
  src\cli.ts → src\logger.ts
- `cmdPipeline()` --calls--> `logBanner()`  [INFERRED]
  src\cli.ts → src\logger.ts
- `cmdPipeline()` --calls--> `logStage()`  [INFERRED]
  src\cli.ts → src\logger.ts
- `cmdPipeline()` --calls--> `log()`  [INFERRED]
  src\cli.ts → src\logger.ts
- `cmdExec()` --calls--> `log()`  [INFERRED]
  src\cli.ts → src\logger.ts

## Communities

### Community 0 - "Playwright Demo Recorder"
Cohesion: 0.13
Nodes (22): DefaultRecorder, extractApiOperations(), findResourcePath(), guessBaseUrl(), guessStartCommand(), importPlaywright(), inferCrudOps(), logStep() (+14 more)

### Community 1 - "Claude Worker Adapter"
Cohesion: 0.09
Nodes (12): buildRepairPrompt(), buildUserPrompt(), ClaudeWorkerAdapter, sanitizePath(), FsWorkspaceManager, walk(), log(), SpecBuilder (+4 more)

### Community 2 - "CLI and Orchestrator Entry"
Cohesion: 0.11
Nodes (27): createClaudeWorkerAdapter(), createClaudeUXEvaluator(), buildOrchestrator(), cmdExec(), cmdPipeline(), cmdRun(), cmdShow(), formatMs() (+19 more)

### Community 3 - "Module Definitions and Types"
Cohesion: 0.26
Nodes (0): 

### Community 4 - "Candidate Runner and Docker Env"
Cohesion: 0.17
Nodes (11): runCandidate(), safeRelease(), withTimeout(), createDockerExecFn(), createDockerSpawnServerFn(), DockerEnvironmentManager, dockerRemove(), dockerRun() (+3 more)

### Community 5 - "Verification and Runtime Checks"
Cohesion: 0.2
Nodes (12): DefaultVerifier, deriveState(), runLlmCheck(), extractCommand(), runCommand(), runRuntimeCheck(), truncate(), countFiles() (+4 more)

### Community 6 - "Claude UX Evaluator"
Cohesion: 0.21
Nodes (10): buildContent(), buildSystemPrompt(), buildTraceSummary(), ClaudeUXEvaluator, fallbackResult(), parseToolInput(), toStringArray(), buildFrameIndex() (+2 more)

### Community 7 - "Scoring Dimensions"
Cohesion: 0.19
Nodes (4): buildRationale(), DefaultEvaluator, deriveRecommendation(), extractEvidence()

### Community 8 - "Submission Payload Builder"
Cohesion: 0.31
Nodes (7): buildCandidateSummary(), buildDebateBlock(), buildOneSentenceSummary(), buildSubmissionPayload(), deriveRankedIds(), formatDuration(), ordinal()

### Community 9 - "Candidate Persistence"
Cohesion: 0.46
Nodes (1): FsCandidateManager

### Community 10 - "Debate Engine"
Cohesion: 0.39
Nodes (5): buildDebatePrompt(), ClaudeUXDebater, fallbackDebate(), parseDebateInput(), toStringArray()

### Community 11 - "Stub Worker Adapter"
Cohesion: 0.53
Nodes (4): buildApproachSummary(), buildDemoNotes(), StubWorkerAdapter, verifyInstruction()

### Community 12 - "Event Log"
Cohesion: 0.5
Nodes (1): FileEventLog

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `log()` connect `Claude Worker Adapter` to `Playwright Demo Recorder`, `CLI and Orchestrator Entry`, `Module Definitions and Types`, `Candidate Runner and Docker Env`, `Verification and Runtime Checks`, `Claude UX Evaluator`, `Debate Engine`?**
  _High betweenness centrality (0.137) - this node is a cross-community bridge._
- **Why does `runCandidate()` connect `Candidate Runner and Docker Env` to `Playwright Demo Recorder`, `Claude Worker Adapter`, `Module Definitions and Types`, `Verification and Runtime Checks`, `Claude UX Evaluator`, `Submission Payload Builder`, `Candidate Persistence`, `Stub Worker Adapter`, `Event Log`?**
  _High betweenness centrality (0.111) - this node is a cross-community bridge._
- **Why does `cmdPipeline()` connect `CLI and Orchestrator Entry` to `Claude Worker Adapter`, `Module Definitions and Types`, `Candidate Runner and Docker Env`?**
  _High betweenness centrality (0.075) - this node is a cross-community bridge._
- **Are the 18 inferred relationships involving `cmdPipeline()` (e.g. with `logBanner()` and `createFileEventLog()`) actually correct?**
  _`cmdPipeline()` has 18 INFERRED edges - model-reasoned connections that need verification._
- **Are the 21 inferred relationships involving `log()` (e.g. with `cmdRun()` and `cmdPipeline()`) actually correct?**
  _`log()` has 21 INFERRED edges - model-reasoned connections that need verification._
- **Are the 17 inferred relationships involving `runCandidate()` (e.g. with `.create()` and `.provision()`) actually correct?**
  _`runCandidate()` has 17 INFERRED edges - model-reasoned connections that need verification._
- **Are the 15 inferred relationships involving `buildOrchestrator()` (e.g. with `createWorkerRegistry()` and `.register()`) actually correct?**
  _`buildOrchestrator()` has 15 INFERRED edges - model-reasoned connections that need verification._