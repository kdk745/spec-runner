/**
 * ClaudeWorkerAdapter — real code-generating worker.
 *
 * Uses an agentic tool-use loop: we send the spec, Claude calls `write_file`
 * for each file, we execute each call and return tool_result blocks, and the
 * loop continues until stop_reason is "end_turn" or "max_tokens".
 *
 * After writing, we produce build-manifest.json ourselves with token usage
 * and file metadata — this is the structured output downstream stages read.
 *
 * Token budget:
 *   MAX_OUTPUT_TOKENS caps each individual API call.
 *   If any turn's stop_reason is "max_tokens", we persist whatever was written
 *   and return success:false with a clear budget-exceeded error.
 *
 * Path safety:
 *   All paths from Claude are sanitized to strip traversal sequences and
 *   absolute references before any writeFile call.
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { WorkerAdapter } from "./adapter.js";
import type { RunSpec, Workspace, BuildResult, Artifact, TokenUsage, RepairContext } from "../types/index.js";
import { log } from "../logger.js";

interface WriteFileInput {
  path: string;
  content: string;
}

interface BuildManifest {
  schemaVersion: "1";
  runId: string;
  generatedBy: "claude";
  model: string;
  filesWritten: string[];
  tokenUsage: TokenUsage;
  stopReason: string;
  generatedAt: string;
}

// Output token cap per turn — large enough for multi-file React/Vite apps.
const MAX_OUTPUT_TOKENS = 8192;
// Maximum agentic turns before we stop and return whatever was written.
const MAX_TURNS = 20;

const SYSTEM_PROMPT = `You are a code generator. Produce a minimal, runnable implementation.

Use the write_file tool for every file you create. Write files only — no prose, no explanation.

Rules:
- Write as many files as the spec requires — do not artificially limit file count
- Every file must have correct syntax and working imports
- Include a README.md with a single run command
- Honour every constraint in the spec exactly
- Prefer plain Node.js or the specified runtime — no unnecessary frameworks
- For TypeScript projects: set "start" script to \`node dist/index.js\` and "build" to \`tsc\`
- Never use ts-node in package.json scripts — always compile first with tsc, then run with node
- tsconfig.json must include \`"outDir": "dist"\` and \`"rootDir": "src"\`
- For React/Vite projects: do NOT set outDir/rootDir in tsconfig; use the default Vite tsconfig
- For React/Vite projects: always write src/App.tsx as the root component imported by src/main.tsx`;

export class ClaudeWorkerAdapter implements WorkerAdapter {
  readonly name = "claude";

  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model = "claude-haiku-4-5-20251001") {
    // maxRetries=5: SDK handles 429/5xx with exponential backoff automatically
    this.client = new Anthropic({ apiKey, maxRetries: 5 });
    this.model = model;
  }

  async execute(spec: RunSpec, workspace: Workspace, repairContext?: RepairContext): Promise<BuildResult> {
    const startedAt = Date.now();
    const writtenFiles: Array<{ path: string; sizeBytes: number }> = [];
    const timeoutMs = spec.workerConfig.timeoutMs;
    const overallDeadline = startedAt + timeoutMs;

    const phase = repairContext ? `repair attempt ${repairContext.attempt}` : "initial build";
    log("build", `Starting ${phase} (model: ${this.model}, budget: ${spec.workerConfig.maxTokenBudget} tokens, timeout: ${timeoutMs / 1000}s)`);

    try {
      const maxTokens = Math.min(
        spec.workerConfig.maxTokenBudget,
        MAX_OUTPUT_TOKENS
      );

      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: repairContext ? buildRepairPrompt(spec, repairContext) : buildUserPrompt(spec) },
      ];

      let totalInputTokens = 0;
      let totalOutputTokens = 0;
      let finalStopReason = "end_turn";

      // Agentic loop: continue until the model stops requesting tool calls
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const remainingMs = overallDeadline - Date.now();
        if (remainingMs <= 0) {
          log("build", `Timeout exceeded after ${turn} turn(s) — stopping`);
          finalStopReason = "timeout";
          break;
        }

        log("build", `Turn ${turn + 1} — calling Claude...`);
        const signal = AbortSignal.timeout(remainingMs);

        const response = await this.client.messages.create(
          {
            model: this.model,
            max_tokens: maxTokens,
            system: SYSTEM_PROMPT,
            messages,
            tools: [WRITE_FILE_TOOL],
            tool_choice: { type: "auto" },
          },
          { signal }
        );

        totalInputTokens += response.usage.input_tokens;
        totalOutputTokens += response.usage.output_tokens;
        finalStopReason = response.stop_reason ?? "end_turn";

        // Budget exceeded mid-loop — stop, keep what we have
        if (finalStopReason === "max_tokens") {
          log("build", "Token budget exhausted");
          break;
        }

        // Execute all write_file calls in this turn
        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use" || block.name !== "write_file") continue;

          const input = block.input as WriteFileInput;
          let safePath: string;
          try {
            safePath = sanitizePath(input.path);
          } catch (e) {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Error: invalid path — ${e instanceof Error ? e.message : e}`,
              is_error: true,
            });
            continue;
          }

          const absPath = join(workspace.rootPath, safePath);
          await mkdir(dirname(absPath), { recursive: true });
          await writeFile(absPath, input.content, "utf8");
          const sizeBytes = Buffer.byteLength(input.content, "utf8");
          writtenFiles.push({ path: safePath, sizeBytes });
          log("build", `  wrote ${safePath} (${(sizeBytes / 1024).toFixed(1)} KB)`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Written: ${safePath}`,
          });
        }

        if (finalStopReason !== "tool_use") {
          log("build", `Done (stop_reason: ${finalStopReason}, turns: ${turn + 1}, files: ${writtenFiles.length})`);
          break;
        }

        // Feed results back so the model can continue
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
      }

      const tokenUsage: TokenUsage = {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
      };

      log("build", `Total tokens: ${tokenUsage.inputTokens} in / ${tokenUsage.outputTokens} out`);

      if (finalStopReason === "timeout") {
        return {
          success: false,
          artifacts: writtenFiles.map(toArtifact),
          durationMs: Date.now() - startedAt,
          tokenUsage,
          error: `Worker timed out after ${timeoutMs / 1000}s. Partial output with ${writtenFiles.length} file(s).`,
        };
      }

      if (finalStopReason === "max_tokens") {
        return {
          success: false,
          artifacts: writtenFiles.map(toArtifact),
          durationMs: Date.now() - startedAt,
          tokenUsage,
          error: `Token budget exhausted (max_tokens). Partial output with ${writtenFiles.length} file(s).`,
        };
      }

      if (writtenFiles.length === 0) {
        return {
          success: false,
          artifacts: [],
          durationMs: Date.now() - startedAt,
          tokenUsage,
          error: `Worker produced no files (stop_reason: ${finalStopReason}).`,
        };
      }

      // Write build-manifest.json — downstream stages read this
      const manifest: BuildManifest = {
        schemaVersion: "1",
        runId: spec.id,
        generatedBy: "claude",
        model: this.model,
        filesWritten: writtenFiles.map((f) => f.path),
        tokenUsage,
        stopReason: finalStopReason,
        generatedAt: new Date().toISOString(),
      };
      const manifestContent = JSON.stringify(manifest, null, 2);
      await writeFile(
        join(workspace.rootPath, "build-manifest.json"),
        manifestContent,
        "utf8"
      );
      writtenFiles.push({
        path: "build-manifest.json",
        sizeBytes: Buffer.byteLength(manifestContent, "utf8"),
      });

      return {
        success: true,
        artifacts: writtenFiles.map(toArtifact),
        durationMs: Date.now() - startedAt,
        tokenUsage,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = err instanceof Error && err.name === "TimeoutError";
      log("build", `${isTimeout ? "Timed out" : "Error"}: ${msg}`);
      return {
        success: false,
        artifacts: writtenFiles.map(toArtifact),
        durationMs: Date.now() - startedAt,
        error: isTimeout ? `API call timed out after ${timeoutMs / 1000}s` : msg,
      };
    }
  }
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const WRITE_FILE_TOOL: Anthropic.Tool = {
  name: "write_file",
  description:
    "Write a file to the candidate workspace. Call once per file. Path must be relative (no leading slash, no ..).",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative file path from workspace root, e.g. src/index.ts",
      },
      content: {
        type: "string",
        description: "Full file content.",
      },
    },
    required: ["path", "content"],
  },
};

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildUserPrompt(spec: RunSpec): string {
  const lines: string[] = [];

  lines.push(`Goal: ${spec.goal}`);
  lines.push("");

  if (spec.constraints.length > 0) {
    lines.push("Constraints:");
    for (const c of spec.constraints) lines.push(`- ${c}`);
    lines.push("");
  }

  lines.push("Success criteria (each will be verified after you write the files):");
  for (let i = 0; i < spec.successCriteria.length; i++) {
    const c = spec.successCriteria[i]!;
    lines.push(`${i + 1}. [${c.checkKind}] ${c.description}`);
  }
  lines.push("");
  lines.push("Write the minimum files needed to satisfy all criteria.");

  const styleHint = spec.workerConfig.options?.["styleHint"];
  if (typeof styleHint === "string" && styleHint.length > 0) {
    lines.push("");
    lines.push("Style guidance (follow this throughout your implementation):");
    lines.push(styleHint);
  }

  return lines.join("\n");
}

function buildRepairPrompt(spec: RunSpec, ctx: RepairContext): string {
  const lines: string[] = [];

  lines.push(`Goal: ${spec.goal}`);
  lines.push("");

  if (spec.constraints.length > 0) {
    lines.push("Constraints:");
    for (const c of spec.constraints) lines.push(`- ${c}`);
    lines.push("");
  }

  lines.push("Success criteria:");
  for (let i = 0; i < spec.successCriteria.length; i++) {
    const c = spec.successCriteria[i]!;
    lines.push(`${i + 1}. [${c.checkKind}] ${c.description}`);
  }
  lines.push("");

  lines.push(`REPAIR ATTEMPT ${ctx.attempt}: Your previous implementation failed self-verification.`);
  lines.push("The workspace still contains your previous files.");
  lines.push("");
  lines.push("Failing checks:");
  for (const check of ctx.failedChecks) {
    const status = check.httpStatus !== undefined ? ` (HTTP ${check.httpStatus})` : "";
    lines.push(`- ${check.endpoint}${status}: ${check.reason}`);
  }
  lines.push("");
  lines.push("Use write_file to overwrite or add files to fix these failures.");
  lines.push("Write only what needs to change — do not re-write files that are already correct.");

  return lines.join("\n");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strip traversal sequences and absolute path prefixes.
 * Throws if the result would be empty (e.g. path was only "..").
 */
function sanitizePath(raw: string): string {
  const parts = raw
    .replace(/\\/g, "/")   // normalise Windows separators
    .replace(/^\/+/, "")   // strip leading slashes
    .split("/")
    .filter((p) => p !== "" && p !== "." && p !== "..");

  if (parts.length === 0) {
    throw new Error(`Invalid or unsafe path: ${raw}`);
  }
  return parts.join("/");
}

function toArtifact(f: { path: string; sizeBytes: number }): Artifact {
  return { path: f.path, kind: "file", sizeBytes: f.sizeBytes };
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createClaudeWorkerAdapter(
  apiKey: string,
  model?: string
): WorkerAdapter {
  return new ClaudeWorkerAdapter(apiKey, model);
}
