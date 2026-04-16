/**
 * StubWorkerAdapter — V1 deterministic worker.
 *
 * Produces pitch.json and DEMO_NOTES.md derived entirely from the locked spec.
 * No LLM calls. No external I/O beyond writing to workspace.rootPath.
 * Always succeeds (unless the workspace directory is missing).
 *
 * Outputs are intentionally structured to match what a real Claude-based
 * adapter would produce, making it easy to swap in the real adapter later.
 *
 * ─── How to plug in a real Claude adapter ──────────────────────────────────
 *
 * 1. Implement WorkerAdapter with name: "claude"
 * 2. In execute():
 *    a. Build a system prompt from spec.goal + spec.constraints
 *    b. Stream a Messages API response with tool_use for file writes
 *    c. For each tool_use block, write the file to workspace.rootPath/<path>
 *    d. Track token usage — abort if spec.workerConfig.maxTokenBudget is reached
 *    e. Enforce spec.workerConfig.timeoutMs via AbortSignal
 *    f. Always return BuildResult (success:false + error on failure)
 * 3. Register it: registry.register(createClaudeWorkerAdapter(apiKey))
 * 4. Set spec.workerConfig.adapterName = "claude" in the spec builder defaults
 *
 * The WorkerAdapter contract guarantees the adapter never touches anything
 * outside workspace.rootPath and never calls back into the orchestrator.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerAdapter } from "./adapter.js";
import type { RunSpec, Workspace, BuildResult, Artifact } from "../types/index.js";

/** Shape of pitch.json written to every candidate workspace. */
interface PitchDocument {
  schemaVersion: "1";
  runId: string;
  goal: string;
  constraints: string[];
  approachSummary: string;
  successCriteriaCount: number;
  generatedBy: string;
  generatedAt: string;
}

export class StubWorkerAdapter implements WorkerAdapter {
  readonly name = "stub";

  async execute(spec: RunSpec, workspace: Workspace): Promise<BuildResult> {
    const startedAt = Date.now();

    try {
      const artifacts: Artifact[] = [];

      // ── pitch.json ────────────────────────────────────────────────────────
      const pitch: PitchDocument = {
        schemaVersion: "1",
        runId: spec.id,
        goal: spec.goal,
        constraints: spec.constraints,
        approachSummary: buildApproachSummary(spec),
        successCriteriaCount: spec.successCriteria.length,
        generatedBy: "stub",
        generatedAt: new Date().toISOString(),
      };

      const pitchContent = JSON.stringify(pitch, null, 2);
      await writeFile(join(workspace.rootPath, "pitch.json"), pitchContent, "utf8");
      artifacts.push({
        path: "pitch.json",
        kind: "file",
        sizeBytes: Buffer.byteLength(pitchContent, "utf8"),
      });

      // ── DEMO_NOTES.md ─────────────────────────────────────────────────────
      const demoContent = buildDemoNotes(spec);
      await writeFile(
        join(workspace.rootPath, "DEMO_NOTES.md"),
        demoContent,
        "utf8"
      );
      artifacts.push({
        path: "DEMO_NOTES.md",
        kind: "file",
        sizeBytes: Buffer.byteLength(demoContent, "utf8"),
      });

      return {
        success: true,
        artifacts,
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        success: false,
        artifacts: [],
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildApproachSummary(spec: RunSpec): string {
  const constraintNote =
    spec.constraints.length > 0
      ? ` using ${spec.constraints.slice(0, 3).join(", ")}`
      : "";
  return `Implement: ${spec.goal}${constraintNote}. Verification will check ${spec.successCriteria.length} criterion/criteria.`;
}

function buildDemoNotes(spec: RunSpec): string {
  const lines: string[] = [];

  lines.push("# Demo Notes");
  lines.push("");
  lines.push(`**Goal:** ${spec.goal}`);
  lines.push("");

  if (spec.constraints.length > 0) {
    lines.push("## Constraints");
    for (const c of spec.constraints) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  lines.push("## Success Criteria");
  lines.push("");
  for (let i = 0; i < spec.successCriteria.length; i++) {
    const c = spec.successCriteria[i]!;
    lines.push(`### ${i + 1}. [${c.checkKind}] ${c.description}`);
    lines.push("");
    lines.push(`**How to verify:** ${verifyInstruction(c.checkKind)}`);
    lines.push("");
  }

  lines.push("## Demo Steps");
  lines.push("");
  lines.push("1. Navigate to the candidate workspace root.");
  lines.push("2. Review `pitch.json` for the intended approach.");

  const runtimeCriteria = spec.successCriteria.filter(
    (c) => c.checkKind === "runtime"
  );
  if (runtimeCriteria.length > 0) {
    lines.push("3. Run the following commands to verify runtime criteria:");
    for (const c of runtimeCriteria) {
      lines.push(`   - ${c.description}`);
    }
  }

  lines.push("");
  lines.push("---");
  lines.push(`*Generated by stub adapter from locked spec ${spec.id}*`);

  return lines.join("\n");
}

function verifyInstruction(checkKind: "static" | "runtime" | "llm"): string {
  switch (checkKind) {
    case "static":
      return "Check file existence or run a linter/syntax checker against the workspace.";
    case "runtime":
      return "Execute the described command in the workspace root; assert exit code 0.";
    case "llm":
      return "Submit the relevant artifact content to an LLM judge with the criterion as the evaluation prompt.";
  }
}

export function createStubWorkerAdapter(): WorkerAdapter {
  return new StubWorkerAdapter();
}
