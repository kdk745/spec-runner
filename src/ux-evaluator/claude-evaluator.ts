/**
 * ClaudeUXEvaluator — multimodal independent UX review.
 *
 * For each candidate:
 *   1. Loads key frames from frame-index.json (base64 PNG, already captured by recorder)
 *   2. Reads API trace summary from api-trace.json (endpoint+status+response excerpts)
 *
 * Sends one Claude call with all candidates interleaved (text + images) and forces
 * structured output via tool_use so the result can be parsed reliably.
 *
 * Focus: observable UX quality from recording artifacts only.
 * Not evaluated: code quality, file structure, implementation choices.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { UXEvaluator } from "./index.js";
import type {
  RunSpec,
  CandidateUXInput,
  UXEvaluation,
  CandidateUXAssessment,
  ApiTrace,
  VideoFrameIndex,
} from "../types/index.js";
import { loadFrames } from "../recorder/video-ingest.js";
import { log } from "../logger.js";

const MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 4096;
const MAX_KEY_FRAMES_PER_CANDIDATE = 5;

// ─── Persona ──────────────────────────────────────────────────────────────────

export type EvaluatorPersona = "correctness" | "quality";

const PERSONA_ADDENDUM: Record<EvaluatorPersona, string> = {
  correctness: `
Your PRIMARY LENS is API CORRECTNESS AND CRUD COMPLETENESS:
- Are all required CRUD operations present and returning appropriate status codes?
- Do HTTP status codes match spec expectations (201 for create, 200/204 for update/delete, 404 for missing)?
- Does the end-to-end CRUD flow succeed without gaps or broken links?
- Are error cases handled (missing resource returns 404, not 500)?`,
  quality: `
Your PRIMARY LENS is RESPONSE QUALITY AND UX CONSISTENCY:
- Are response bodies well-formed and consistently shaped across endpoints?
- Do related operations agree (create returns an id → read that id returns matching data)?
- Is response structure predictable and free of unexpected fields or inconsistent naming?
- Are there behavioral surprises: extra data in 404s, empty bodies where content expected, silent failures?`,
};

// ─── System prompt ────────────────────────────────────────────────────────────

const BASE_SYSTEM_PROMPT = `You are a UX evaluator reviewing candidate API implementations.
You will receive recording artifacts — screenshots with HTTP overlay and API trace summaries — for multiple candidates that built the same specification.

Your focus is VISIBLE UX QUALITY observable from the recording artifacts:
- Are API responses correct, well-structured, and appropriately shaped?
- Do HTTP status codes match expected behavior (2xx success, 404 for missing, etc.)?
- Do CRUD operations form a coherent, working end-to-end flow?
- Are responses consistent across related operations (create → read → verify)?
- Are there observable failures, missing operations, or unexpected behaviors?

When referencing evidence, be specific:
- Use step descriptions: "Step 5 (Verify update persisted) — GET /todos/1 → 200"
- Cite what is visible in screenshots: "Response body shows {completed: true} after the update"
- Note HTTP status codes and response excerpt patterns from the trace

Do NOT evaluate: code quality, file structure, naming, or implementation choices.
Evaluate ONLY what is observable from the recording artifacts.`;

function buildSystemPrompt(persona?: EvaluatorPersona): string {
  if (!persona) return BASE_SYSTEM_PROMPT;
  return BASE_SYSTEM_PROMPT + "\n" + PERSONA_ADDENDUM[persona];
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const SUBMIT_TOOL: Anthropic.Tool = {
  name: "submit_ux_evaluation",
  description: "Submit the structured UX evaluation of all reviewed candidates.",
  input_schema: {
    type: "object",
    properties: {
      assessments: {
        type: "array",
        description: "One assessment per candidate. Order by rank ascending (rank 1 = best).",
        items: {
          type: "object",
          properties: {
            candidateId:     { type: "string" },
            rank:            { type: "integer", minimum: 1 },
            score:           { type: "integer", minimum: 0, maximum: 100 },
            strengths:       { type: "array", items: { type: "string" } },
            weaknesses:      { type: "array", items: { type: "string" } },
            observedMoments: {
              type: "array",
              items: { type: "string" },
              description: "Specific observable moments — step name, endpoint, status, response excerpt.",
            },
          },
          required: ["candidateId", "rank", "score", "strengths", "weaknesses", "observedMoments"],
        },
      },
      tradeoffs: {
        type: "array",
        items: { type: "string" },
        description: "Cross-candidate observations: differences, tradeoffs, notable contrasts.",
      },
      recommendedWinner: {
        type: "string",
        description: "candidateId of the recommended winner.",
      },
      rationale: {
        type: "string",
        description: "One paragraph explaining the recommendation with grounded evidence.",
      },
    },
    required: ["assessments", "tradeoffs", "recommendedWinner", "rationale"],
  },
};

// ─── Implementation ───────────────────────────────────────────────────────────

export class ClaudeUXEvaluator implements UXEvaluator {
  private readonly client: Anthropic;
  private readonly systemPrompt: string;

  constructor(apiKey: string, persona?: EvaluatorPersona) {
    this.client = new Anthropic({ apiKey });
    this.systemPrompt = buildSystemPrompt(persona);
  }

  async evaluate(spec: RunSpec, candidates: CandidateUXInput[]): Promise<UXEvaluation> {
    log("ux-eval", `Evaluating ${candidates.length} candidate(s) — model: ${MODEL}`);

    const content = await buildContent(spec, candidates);
    const totalImages = content.filter((b) => b.type === "image").length;
    log("ux-eval", `Prompt built — ${content.length} blocks, ${totalImages} image(s)`);

    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: this.systemPrompt,
        messages: [{ role: "user", content }],
        tools: [SUBMIT_TOOL],
        tool_choice: { type: "tool", name: "submit_ux_evaluation" },
      });

      const toolBlock = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      if (!toolBlock) {
        throw new Error("Claude did not return a tool_use block");
      }

      return parseToolInput(spec.id, toolBlock.input as Record<string, unknown>);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("ux-eval", `Evaluation failed — ${msg}`);
      return fallbackResult(spec.id, candidates, msg);
    }
  }
}

// ─── Prompt construction ──────────────────────────────────────────────────────

async function buildContent(
  spec: RunSpec,
  candidates: CandidateUXInput[]
): Promise<Anthropic.ContentBlockParam[]> {
  const blocks: Anthropic.ContentBlockParam[] = [];

  blocks.push({
    type: "text",
    text: [
      `# UX Evaluation Task`,
      ``,
      `**Specification goal:** ${spec.goal}`,
      spec.constraints.length > 0
        ? `**Constraints:** ${spec.constraints.join("; ")}`
        : "",
      ``,
      `**Success criteria:**`,
      ...spec.successCriteria.map((c, i) => `  ${i + 1}. [${c.checkKind}] ${c.description}`),
      ``,
      `Review ${candidates.length} candidate(s) below. Each section shows the API trace`,
      `summary and key screenshots from the recording session.`,
    ].filter((l) => l !== undefined).join("\n"),
  });

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const label = `Candidate ${i + 1}`;
    const idShort = c.candidateId.slice(0, 8);

    blocks.push({
      type: "text",
      text: `\n---\n## ${label} (id: ${idShort})\n\n**Self-verification:** ${c.selfVerificationPassed ? "PASSED" : "FAILED"}`,
    });

    // API trace summary
    if (c.tracePath && existsSync(c.tracePath)) {
      const traceSummary = await buildTraceSummary(c.tracePath);
      blocks.push({ type: "text", text: traceSummary });
    } else {
      blocks.push({ type: "text", text: "\n_No API trace available._" });
    }

    // Key frame images
    if (c.frameIndexPath && existsSync(c.frameIndexPath)) {
      const raw = await readFile(c.frameIndexPath, "utf8");
      const frameIndex = JSON.parse(raw) as VideoFrameIndex;
      const frames = await loadFrames(frameIndex, {
        keyFramesOnly: true,
        maxFrames: MAX_KEY_FRAMES_PER_CANDIDATE,
      });

      if (frames.length > 0) {
        blocks.push({
          type: "text",
          text: `\n**Key frames (${frames.length}/${frameIndex.keyFrameCount} key, ${frameIndex.frames.length} total):**`,
        });
        for (const frame of frames) {
          const status = frame.httpStatus !== undefined ? ` → HTTP ${frame.httpStatus}` : "";
          const flag = frame.passed ? "✓" : "✗";
          blocks.push({
            type: "text",
            text: `\nStep ${frame.stepIndex}: ${frame.description} (${frame.endpoint}${status}) ${flag}`,
          });
          blocks.push({
            type: "image",
            source: { type: "base64", media_type: "image/png", data: frame.base64 },
          });
        }
      } else {
        blocks.push({ type: "text", text: "\n_No screenshots available._" });
      }
    } else {
      blocks.push({ type: "text", text: "\n_No frame index available._" });
    }
  }

  blocks.push({
    type: "text",
    text: `\n---\nNow call submit_ux_evaluation with your ranked assessment of all ${candidates.length} candidate(s).`,
  });

  return blocks;
}

async function buildTraceSummary(tracePath: string): Promise<string> {
  try {
    const raw = await readFile(tracePath, "utf8");
    const trace = JSON.parse(raw) as ApiTrace;
    const lines: string[] = [
      ``,
      `**API Trace** (${trace.summary.passed}/${trace.summary.totalSteps} passed, base: ${trace.baseUrl}):`,
    ];
    for (const step of trace.steps) {
      const status = step.httpStatus !== undefined ? ` → ${step.httpStatus}` : "";
      const flag   = step.passed ? "✓" : "✗";
      const body   = step.responseBody ? `  \`${step.responseBody.slice(0, 80).replace(/\n/g, " ")}\`` : "";
      lines.push(`  ${flag} Step ${step.index}: ${step.description} — ${step.method} ${step.path}${status}${body}`);
    }
    return lines.join("\n");
  } catch {
    return "\n_Could not read API trace._";
  }
}

// ─── Result parsing ───────────────────────────────────────────────────────────

interface RawToolInput {
  assessments?: unknown[];
  tradeoffs?: unknown[];
  recommendedWinner?: unknown;
  rationale?: unknown;
}

interface RawAssessment {
  candidateId?: unknown;
  rank?: unknown;
  score?: unknown;
  strengths?: unknown;
  weaknesses?: unknown;
  observedMoments?: unknown;
}

function parseToolInput(runId: string, input: Record<string, unknown>): UXEvaluation {
  const raw = input as RawToolInput;

  const ranking: CandidateUXAssessment[] = ((raw.assessments as RawAssessment[]) ?? [])
    .map((a) => ({
      candidateId:     String(a.candidateId ?? ""),
      rank:            Number(a.rank ?? 0),
      score:           Math.min(100, Math.max(0, Number(a.score ?? 0))),
      strengths:       toStringArray(a.strengths),
      weaknesses:      toStringArray(a.weaknesses),
      observedMoments: toStringArray(a.observedMoments),
    }))
    .sort((a, b) => a.rank - b.rank);

  return {
    runId,
    ranking,
    tradeoffs:         toStringArray(raw.tradeoffs),
    recommendedWinner: String(raw.recommendedWinner ?? ""),
    rationale:         String(raw.rationale ?? ""),
    completedAt:       new Date().toISOString(),
  };
}

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map(String);
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function fallbackResult(
  runId: string,
  candidates: CandidateUXInput[],
  error: string
): UXEvaluation {
  const ranking: CandidateUXAssessment[] = candidates.map((c, i) => ({
    candidateId:     c.candidateId,
    rank:            i + 1,
    score:           c.selfVerificationPassed ? 50 : 10,
    strengths:       [],
    weaknesses:      [`UX evaluation unavailable: ${error}`],
    observedMoments: [],
  }));

  return {
    runId,
    ranking,
    tradeoffs:         [],
    recommendedWinner: ranking[0]?.candidateId ?? "",
    rationale:         `UX evaluation failed: ${error}. Ranking is a placeholder based on self-verification status only.`,
    completedAt:       new Date().toISOString(),
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createClaudeUXEvaluator(apiKey: string, persona?: EvaluatorPersona): UXEvaluator {
  return new ClaudeUXEvaluator(apiKey, persona);
}
