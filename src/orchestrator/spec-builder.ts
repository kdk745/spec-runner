/**
 * Converts a user prompt into a locked RunSpec.
 *
 * Flow:
 *   1. Generate runId
 *   2. Create runs/<runId>/ directory
 *   3. Write initial run.json (status: initializing)
 *   4. Emit spec.created event
 *   5. Call Claude with tool_use to extract structured spec fields
 *   6. Assemble RunSpec, set lockedAt
 *   7. Write spec.json
 *   8. Update run.json (status: spec_locked)
 *   9. Emit spec.locked event
 *  10. Return locked RunSpec
 */

import Anthropic from "@anthropic-ai/sdk";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  RunSpec,
  RunRecord,
  WorkerConfig,
  SuccessCriterion,
} from "../types/index.js";
import type { EventLog } from "../events/index.js";
import { log } from "../logger.js";

const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  adapterName: "claude",
  maxTokenBudget: 16_000,
  timeoutMs: 300_000, // 5 minutes — multi-file React apps need 20+ turns
  options: {},
};

const SPEC_TOOL_NAME = "define_run_spec";

// Shape returned by the LLM tool call
interface ParsedSpec {
  goal: string;
  constraints: string[];
  successCriteria: Array<{
    description: string;
    checkKind: "static" | "runtime" | "llm";
  }>;
}

export interface SpecBuilderOptions {
  llmApiKey: string;
  model?: string;
  defaultWorkerConfig?: Partial<WorkerConfig>;
}

export class SpecBuilder {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly workerConfig: WorkerConfig;

  constructor(
    private readonly runsDir: string,
    private readonly events: EventLog,
    options: SpecBuilderOptions
  ) {
    this.client = new Anthropic({ apiKey: options.llmApiKey });
    this.model = options.model ?? "claude-sonnet-4-6";
    this.workerConfig = {
      ...DEFAULT_WORKER_CONFIG,
      ...options.defaultWorkerConfig,
    };
  }

  async build(prompt: string): Promise<RunSpec> {
    const runId = randomUUID();
    const now = new Date().toISOString();
    const runDir = join(this.runsDir, runId);

    await mkdir(runDir, { recursive: true });

    // Write initial run record
    const runRecord: RunRecord = {
      id: runId,
      status: "initializing",
      prompt,
      createdAt: now,
      updatedAt: now,
    };
    await this._writeJson(runDir, "run.json", runRecord);

    await this.events.append({
      runId,
      kind: "provision.started",
      payload: { prompt },
    });

    // Call Claude to parse the prompt into structured spec fields
    log("provision", `Parsing prompt (run: ${runId.slice(0, 8)})...`);
    const parsed = await this._parsePrompt(prompt);

    const lockedAt = new Date().toISOString();
    const spec: RunSpec = {
      id: runId,
      schemaVersion: "1",
      createdAt: now,
      lockedAt,
      prompt,
      goal: parsed.goal,
      constraints: parsed.constraints,
      successCriteria: parsed.successCriteria.map((c) => ({
        id: randomUUID(),
        description: c.description,
        checkKind: c.checkKind,
      })) satisfies SuccessCriterion[],
      workerConfig: this.workerConfig,
    };

    await this._writeJson(runDir, "spec.json", spec);
    log("provision", `Locked — goal: "${spec.goal.slice(0, 80)}"`);
    log("provision", `  ${spec.successCriteria.length} criteria: ${spec.successCriteria.map(c => `[${c.checkKind}]`).join(" ")}`);

    // Update run record to provisioned
    const updated: RunRecord = {
      ...runRecord,
      status: "provisioned",
      updatedAt: new Date().toISOString(),
    };
    await this._writeJson(runDir, "run.json", updated);

    await this.events.append({
      runId,
      kind: "provision.completed",
      payload: { criteriaCount: spec.successCriteria.length },
    });

    return spec;
  }

  private async _parsePrompt(prompt: string): Promise<ParsedSpec> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: `You are a spec analyst. Convert a prototype request into a structured run specification.

Rules:
- goal: one clear sentence describing what the prototype must do
- constraints: concrete technical constraints only (language, framework, size limits, performance). Omit vague goals.
- successCriteria: 3–5 checks that can be verified without running the app subjectively.
  Prefer "static" (file existence, syntax) and "runtime" (executable command + exit code) over "llm".
  Each description must say what to check AND how to verify it.
  For runtime criteria, always wrap the exact runnable shell command in backticks, e.g.:
    "TypeScript compiles without errors: run \`npx tsc --noEmit\` and confirm exit code 0."
    "Server starts: run \`npm start\` and confirm it binds to a port."
  For static criteria, name the exact file path to check, e.g.: "File src/index.ts exists."`,
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          name: SPEC_TOOL_NAME,
          description:
            "Output the structured run specification derived from the user prompt.",
          input_schema: {
            type: "object" as const,
            properties: {
              goal: {
                type: "string",
                description: "One sentence: what the prototype must do.",
              },
              constraints: {
                type: "array",
                items: { type: "string" },
                description: "Concrete technical constraints.",
              },
              successCriteria: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    description: {
                      type: "string",
                      description: "What to check and how to verify it.",
                    },
                    checkKind: {
                      type: "string",
                      enum: ["static", "runtime", "llm"],
                    },
                  },
                  required: ["description", "checkKind"],
                },
              },
            },
            required: ["goal", "constraints", "successCriteria"],
          },
        },
      ],
      tool_choice: { type: "tool", name: SPEC_TOOL_NAME },
    });

    const toolUse = response.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new Error("Claude did not return a tool_use block for spec parsing");
    }

    const input = toolUse.input as Record<string, unknown>;
    return {
      goal: String(input.goal ?? ""),
      constraints: Array.isArray(input.constraints) ? (input.constraints as string[]) : [],
      successCriteria: Array.isArray(input.successCriteria)
        ? (input.successCriteria as ParsedSpec["successCriteria"])
        : [],
    };
  }

  private async _writeJson(dir: string, filename: string, data: unknown): Promise<void> {
    await writeFile(
      join(dir, filename),
      JSON.stringify(data, null, 2),
      "utf8"
    );
  }
}

export function createSpecBuilder(
  runsDir: string,
  events: EventLog,
  options: SpecBuilderOptions
): SpecBuilder {
  return new SpecBuilder(runsDir, events, options);
}
