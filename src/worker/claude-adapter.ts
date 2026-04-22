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
import type { WorkerAdapter, WorkerExecuteOptions } from "./adapter.js";
import type { RunSpec, Workspace, BuildResult, Artifact, TokenUsage, RepairContext, ExecFn } from "../types/index.js";
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
- For React/Vite projects: always write src/App.tsx as the root component imported by src/main.tsx

Runtime contract — the platform starts your app in one of two modes only:

  static: a single-page app with an index.html at the workspace root.
          The platform serves it with \`npx serve . -l tcp://0.0.0.0:3000\`.
          You do NOT write a server. No package.json start script needed.

  node:   a Node.js server. Requires package.json with a \`"start"\` script.
          The platform runs \`npm install\` then \`npm start\` and injects
          HOST=0.0.0.0 and PORT=3000. Your server MUST:
            • read process.env.PORT (default 3000) and process.env.HOST (default 0.0.0.0)
            • bind to HOST:PORT (e.g. \`app.listen(PORT, HOST)\`)
            • NEVER hard-code 127.0.0.1 — it will not be reachable from the recorder.

Rules:
- Pick exactly one mode. Do not ship both an index.html AND a conflicting package.json start.
- Static mode is correct for frontend-only prototypes (HTML/CSS/JS, local storage).
- Node mode is correct when you need a real backend (REST API, SSR, etc.).
- Optionally write \`candidate-runtime.json\` to declare mode explicitly:
    {"mode":"static"}                           — override auto-detect
    {"mode":"node","start":"node dist/index.js"} — override npm start
- The recorder opens http://localhost:3000/ in a real browser. The main UI
  must render fully at that URL with no fatal JS errors.`;

export class ClaudeWorkerAdapter implements WorkerAdapter {
  readonly name = "claude";

  private readonly client: Anthropic;
  private readonly model: string;

  constructor(apiKey: string, model = "claude-haiku-4-5-20251001") {
    // apiKey may be empty when DOCKER_ENV=1 — the SDK is only called in the
    // non-Docker path; Docker builds use claude-cli inside the container.
    this.client = new Anthropic({ apiKey: apiKey || "docker-mode-no-key", maxRetries: 5 });
    this.model = model;
  }

  async execute(spec: RunSpec, workspace: Workspace, repairContext?: RepairContext, opts?: WorkerExecuteOptions): Promise<BuildResult> {
    if (opts?.execFn) {
      return this._executeInContainer(spec, workspace, opts.execFn, repairContext);
    }
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

  // ─── Container execution path (Docker mode) ────────────────────────────────
  // Runs `claude -p` inside the container via execFn. The container authenticates
  // through the ~/.claude bind-mount — no API key env var required.
  // Claude is prompted to emit files as <file path="...">...</file> XML blocks
  // which we parse on the host and write to the workspace.

  private async _executeInContainer(
    spec: RunSpec,
    workspace: Workspace,
    execFn: ExecFn,
    repairContext?: RepairContext,
  ): Promise<BuildResult> {
    const startedAt = Date.now();
    const phase = repairContext ? `repair attempt ${repairContext.attempt}` : "initial build";
    log("build", `Starting ${phase} via docker claude-cli`);

    const prompt = repairContext
      ? buildRepairPromptCli(spec, repairContext)
      : buildUserPromptCli(spec);

    let output = "";
    let errorMsg = "";
    try {
      const timeoutMs = spec.workerConfig.timeoutMs;
      // Pipe prompt via stdin — no host→workspace file write, works on all platforms.
      const result = await execFn("claude -p", "/workspace", timeoutMs, prompt);
      output = result.stdout;
      log("build", `claude -p exit=${result.exitCode} timedOut=${result.timedOut} stdout=${output.length}b stderr=${result.stderr.length}b`);
      if (result.stderr.trim()) {
        log("build", `  stderr preview: ${result.stderr.slice(0, 300).replace(/\n/g, " ↵ ")}`);
      }
      if (output.trim()) {
        log("build", `  stdout preview: ${output.slice(0, 300).replace(/\n/g, " ↵ ")}`);
      }
      if (result.timedOut) {
        errorMsg = `claude -p timed out after ${timeoutMs / 1000}s`;
      } else if (result.exitCode !== 0 && !output.trim()) {
        errorMsg = `claude -p exited ${result.exitCode}: ${result.stderr.slice(0, 300)}`;
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err);
    }

    if (errorMsg) {
      log("build", `Container build failed: ${errorMsg}`);
      return { success: false, artifacts: [], durationMs: Date.now() - startedAt, error: errorMsg };
    }

    // Parse <file path="...">...</file> blocks from stdout
    const writtenFiles: Array<{ path: string; sizeBytes: number }> = [];
    const fileRe = /<file path="([^"]+)">([\s\S]*?)<\/file>/g;
    let match: RegExpExecArray | null;

    while ((match = fileRe.exec(output)) !== null) {
      const rawPath = match[1]!;
      const content  = match[2]!.replace(/^\n/, "").replace(/\n$/, "");

      let safePath: string;
      try { safePath = sanitizePath(rawPath); } catch { continue; }

      const absPath = join(workspace.rootPath, safePath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, "utf8");
      const sizeBytes = Buffer.byteLength(content, "utf8");
      writtenFiles.push({ path: safePath, sizeBytes });
      log("build", `  wrote ${safePath} (${(sizeBytes / 1024).toFixed(1)} KB)`);
    }

    if (writtenFiles.length === 0) {
      log("build", "Container build produced no parseable files");
      log("build", `Raw output (first 500 chars): ${output.slice(0, 500)}`);
      return {
        success: false, artifacts: [],
        durationMs: Date.now() - startedAt,
        error: "claude -p returned no <file> blocks",
      };
    }

    // Write build-manifest
    const manifest = {
      schemaVersion: "1", runId: spec.id, generatedBy: "claude-cli",
      model: "claude-cli", filesWritten: writtenFiles.map((f) => f.path),
      generatedAt: new Date().toISOString(),
    };
    const manifestContent = JSON.stringify(manifest, null, 2);
    await writeFile(join(workspace.rootPath, "build-manifest.json"), manifestContent, "utf8");
    writtenFiles.push({ path: "build-manifest.json", sizeBytes: Buffer.byteLength(manifestContent) });

    log("build", `Container build done — ${writtenFiles.length} file(s) in ${Date.now() - startedAt}ms`);
    return { success: true, artifacts: writtenFiles.map(toArtifact), durationMs: Date.now() - startedAt };
  }
} // end ClaudeWorkerAdapter

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

// ─── CLI prompt builders (Docker / no-API-key path) ───────────────────────────
// Claude is instructed to emit every file as an XML block so the host can parse
// and write them. No tool_use — output is parsed from stdout.

const CLI_SYSTEM_SUFFIX = `
Output EVERY file you create using this exact XML format (no other text):

<file path="relative/path/to/file">
file content here
</file>

Rules:
- Use one <file> block per file
- Paths must be relative (no leading slash, no ..)
- Include ALL files needed to run the app
- Include a README.md with a single run command
- Follow the runtime contract above: pick EITHER static (bare index.html, no start script needed) OR node (package.json with a start script that binds HOST:PORT from env)
- Node-mode servers MUST read process.env.PORT and process.env.HOST and bind to them — never hard-code 127.0.0.1
- The recorder opens http://localhost:3000/ in a real browser`;

function buildUserPromptCli(spec: RunSpec): string {
  const lines: string[] = [SYSTEM_PROMPT, CLI_SYSTEM_SUFFIX, "", buildUserPrompt(spec)];
  return lines.join("\n");
}

function buildRepairPromptCli(spec: RunSpec, ctx: RepairContext): string {
  const lines: string[] = [SYSTEM_PROMPT, CLI_SYSTEM_SUFFIX, "", buildRepairPrompt(spec, ctx)];
  return lines.join("\n");
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createClaudeWorkerAdapter(
  apiKey: string,
  model?: string
): WorkerAdapter {
  return new ClaudeWorkerAdapter(apiKey, model);
}
