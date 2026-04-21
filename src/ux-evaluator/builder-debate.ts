/**
 * BuilderDebater — adversarial debate where the agents that built each candidate
 * defend their own implementation against the other two.
 *
 * Phase 1 (parallel): Each builder makes an opening case, citing their own screenshots.
 * Phase 2 (parallel): Each builder rebuts the other two's opening arguments.
 * Phase 3 (single):   A judge reviews all arguments + independent evaluations → picks winner.
 *
 * Each builder is seeded with their style hint as their design philosophy, so their
 * arguments reflect the intent behind their implementation choices.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type {
  RunSpec,
  CandidateUXInput,
  UXEvaluation,
  UXDebateResult,
  DebateRound,
  VideoFrameIndex,
} from "../types/index.js";
import type { UXDebater } from "./index.js";
import { loadFrames } from "../recorder/video-ingest.js";
import { log } from "../logger.js";

const MODEL = "claude-sonnet-4-6";
const MAX_FRAMES_PER_BUILDER = 4;
const MAX_TOKENS_BUILDER = 2048;
const MAX_TOKENS_JUDGE  = 6144;

// ─── Tools ────────────────────────────────────────────────────────────────────

const OPENING_TOOL: Anthropic.Tool = {
  name: "submit_opening",
  description: "Submit your opening argument defending your implementation.",
  input_schema: {
    type: "object",
    properties: {
      argument: {
        type: "string",
        description: "Your main argument for why your implementation is the best choice. Be specific and honest.",
      },
      evidenceRefs: {
        type: "array",
        items: { type: "string" },
        description: "Specific observable moments from your screenshots that support your argument.",
      },
      acknowledgedWeaknesses: {
        type: "array",
        items: { type: "string" },
        description: "Genuine weaknesses in your implementation that you concede up front.",
      },
    },
    required: ["argument", "evidenceRefs", "acknowledgedWeaknesses"],
  },
};

const REBUTTAL_TOOL: Anthropic.Tool = {
  name: "submit_rebuttal",
  description: "Submit your rebuttal responding to the other builders' opening arguments.",
  input_schema: {
    type: "object",
    properties: {
      argument: {
        type: "string",
        description: "Your rebuttal — respond to the other builders' claims and reinforce your position.",
      },
      evidenceRefs: {
        type: "array",
        items: { type: "string" },
        description: "Observable moments from your screenshots that counter or contextualize their claims.",
      },
      concessions: {
        type: "array",
        items: { type: "string" },
        description: "Valid points from other builders that you grant as correct.",
      },
    },
    required: ["argument", "evidenceRefs", "concessions"],
  },
};

const VERDICT_TOOL: Anthropic.Tool = {
  name: "submit_verdict",
  description: "Submit the final verdict after reviewing the builder debate.",
  input_schema: {
    type: "object",
    properties: {
      consensusPoints: {
        type: "array",
        items: { type: "string" },
        description: "Claims that multiple builders agreed on, or that went unchallenged.",
      },
      disputedPoints: {
        type: "array",
        items: { type: "string" },
        description: "Claims that were genuinely contested in the debate.",
      },
      finalWinner: {
        type: "string",
        description: "The full candidateId of the recommended winner.",
      },
      finalRationale: {
        type: "string",
        description: "Paragraph explaining the verdict, grounded in debate evidence and independent evaluations.",
      },
    },
    required: ["consensusPoints", "disputedPoints", "finalWinner", "finalRationale"],
  },
};

// ─── Screenshot loading ───────────────────────────────────────────────────────

async function loadScreenshots(input: CandidateUXInput): Promise<Anthropic.ImageBlockParam[]> {
  if (!input.frameIndexPath || !existsSync(input.frameIndexPath)) return [];
  try {
    const raw = await readFile(input.frameIndexPath, "utf8");
    const index = JSON.parse(raw) as VideoFrameIndex;
    const frames = await loadFrames(index, { keyFramesOnly: true, maxFrames: MAX_FRAMES_PER_BUILDER });
    return frames.map((f) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: f.mediaType, data: f.base64 },
    }));
  } catch {
    return [];
  }
}

// ─── Phase 1: Opening arguments ───────────────────────────────────────────────

async function builderOpening(
  client: Anthropic,
  spec: RunSpec,
  input: CandidateUXInput,
  evalA: UXEvaluation,
  evalB: UXEvaluation,
  builderIndex: number,
): Promise<DebateRound> {
  const screenshots = await loadScreenshots(input);
  const id = input.candidateId.slice(0, 8);
  const styleHint = input.styleHint ?? "No specific design philosophy provided.";

  // Summaries of the other candidates from independent evaluations
  const otherSummaries = [...evalA.ranking, ...evalB.ranking]
    .filter((a) => a.candidateId !== input.candidateId)
    .reduce<Record<string, string[]>>((acc, a) => {
      const k = a.candidateId.slice(0, 8);
      if (!acc[k]) acc[k] = [];
      acc[k]!.push(`score ${a.score}/100: ${a.strengths.slice(0,2).join(", ")} | weaknesses: ${a.weaknesses.slice(0,2).join(", ")}`);
      return acc;
    }, {});

  const otherBlock = Object.entries(otherSummaries)
    .map(([cid, lines]) => `- Candidate ${cid}: ${lines.join(" | ")}`)
    .join("\n");

  const systemPrompt =
    `You are the engineer who built Candidate ${id} in a multi-agent code generation competition.\n` +
    `Your design philosophy: ${styleHint}\n\n` +
    `You are now defending your implementation in a structured debate against 2 other engineers.\n` +
    `Rules:\n` +
    `- Cite specific observable moments from your screenshots as evidence\n` +
    `- Be honest about genuine weaknesses — the judge will see through overclaiming\n` +
    `- Do not claim superiority over code you haven't seen — reference only what's visible in recordings\n` +
    `- Your design philosophy is your strongest differentiator; argue from it`;

  const userPrompt = [
    `# Debate: ${spec.goal}`,
    ``,
    `**Your candidate:** ${id} (builder-${builderIndex})`,
    `**Your screenshots:** ${screenshots.length} frame(s) attached`,
    ``,
    `**Other candidates' independent evaluations:**`,
    otherBlock || "No evaluations available.",
    ``,
    `Make your opening argument. Call submit_opening.`,
  ].join("\n");

  const content: Anthropic.MessageParam["content"] = [
    { type: "text", text: userPrompt },
    ...screenshots,
  ];

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS_BUILDER,
      system: systemPrompt,
      messages: [{ role: "user", content }],
      tools: [OPENING_TOOL],
      tool_choice: { type: "tool", name: "submit_opening" },
    });

    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const raw = (block?.input ?? {}) as Record<string, unknown>;

    return {
      evaluatorId: `builder-${builderIndex}`,
      roundIndex: 1,
      position: String(raw["argument"] ?? ""),
      evidenceRefs: toStringArray(raw["evidenceRefs"]),
      concessions: toStringArray(raw["acknowledgedWeaknesses"]),
    };
  } catch {
    return { evaluatorId: `builder-${builderIndex}`, roundIndex: 1, position: "Opening unavailable.", evidenceRefs: [], concessions: [] };
  }
}

// ─── Phase 2: Rebuttals ───────────────────────────────────────────────────────

async function builderRebuttal(
  client: Anthropic,
  spec: RunSpec,
  input: CandidateUXInput,
  openings: DebateRound[],
  builderIndex: number,
): Promise<DebateRound> {
  const screenshots = await loadScreenshots(input);
  const id = input.candidateId.slice(0, 8);
  const styleHint = input.styleHint ?? "No specific design philosophy provided.";

  const otherOpenings = openings
    .filter((r) => r.evaluatorId !== `builder-${builderIndex}`)
    .map((r) => `**${r.evaluatorId}:** ${r.position}\n  Evidence: ${r.evidenceRefs.join("; ")}`)
    .join("\n\n");

  const myOpening = openings.find((r) => r.evaluatorId === `builder-${builderIndex}`);

  const systemPrompt =
    `You are the engineer who built Candidate ${id}.\n` +
    `Your design philosophy: ${styleHint}\n\n` +
    `You are now delivering your rebuttal in the debate. Respond to the other builders' claims.\n` +
    `Rules:\n` +
    `- Grant valid points honestly — concessions strengthen your credibility\n` +
    `- Counter weak claims with specific screenshot evidence\n` +
    `- Stay focused on observable UX quality, not abstract design preferences`;

  const userPrompt = [
    `# Rebuttal Round`,
    ``,
    `**Your opening argument:**`,
    myOpening?.position ?? "(unavailable)",
    ``,
    `**Other builders' openings:**`,
    otherOpenings || "No other openings available.",
    ``,
    `Deliver your rebuttal. Call submit_rebuttal.`,
  ].join("\n");

  const content: Anthropic.MessageParam["content"] = [
    { type: "text", text: userPrompt },
    ...screenshots,
  ];

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS_BUILDER,
      system: systemPrompt,
      messages: [{ role: "user", content }],
      tools: [REBUTTAL_TOOL],
      tool_choice: { type: "tool", name: "submit_rebuttal" },
    });

    const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const raw = (block?.input ?? {}) as Record<string, unknown>;

    return {
      evaluatorId: `builder-${builderIndex}`,
      roundIndex: 2,
      position: String(raw["argument"] ?? ""),
      evidenceRefs: toStringArray(raw["evidenceRefs"]),
      concessions: toStringArray(raw["concessions"]),
    };
  } catch {
    return { evaluatorId: `builder-${builderIndex}`, roundIndex: 2, position: "Rebuttal unavailable.", evidenceRefs: [], concessions: [] };
  }
}

// ─── Phase 3: Judge verdict ───────────────────────────────────────────────────

async function judgeVerdict(
  client: Anthropic,
  spec: RunSpec,
  evalA: UXEvaluation,
  evalB: UXEvaluation,
  openings: DebateRound[],
  rebuttals: DebateRound[],
  inputs: CandidateUXInput[],
): Promise<{ consensusPoints: string[]; disputedPoints: string[]; finalWinner: string; finalRationale: string }> {
  const debateTranscript = [...openings, ...rebuttals]
    .sort((a, b) => a.roundIndex - b.roundIndex || a.evaluatorId.localeCompare(b.evaluatorId))
    .map((r) => [
      `### ${r.evaluatorId} (Round ${r.roundIndex})`,
      r.position,
      r.evidenceRefs.length > 0 ? `Evidence: ${r.evidenceRefs.join("; ")}` : "",
      r.concessions.length > 0 ? `Concedes: ${r.concessions.join("; ")}` : "",
    ].filter(Boolean).join("\n"))
    .join("\n\n");

  const evalSummary = [
    `**Evaluator A (correctness):** winner=${evalA.recommendedWinner.slice(0,8)} — ${evalA.rationale.slice(0,200)}`,
    `**Evaluator B (quality):** winner=${evalB.recommendedWinner.slice(0,8)} — ${evalB.rationale.slice(0,200)}`,
  ].join("\n");

  const candidateMap = inputs.map((inp, i) =>
    `- builder-${i} → candidateId: ${inp.candidateId} (${inp.candidateId.slice(0,8)})`
  ).join("\n");

  const userPrompt = [
    `# Judge Verdict: ${spec.goal}`,
    ``,
    `**Candidate mapping:**`,
    candidateMap,
    ``,
    `## Builder Debate Transcript`,
    debateTranscript || "No debate rounds available.",
    ``,
    `## Independent Evaluations`,
    evalSummary,
    ``,
    `Review the debate and evaluations. Pick the best candidate. Call submit_verdict.`,
    `Use the FULL candidateId (not the short form) in finalWinner.`,
  ].join("\n");

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS_JUDGE,
    system:
      "You are the final judge of a debate between engineers who built competing implementations of the same spec. " +
      "Review their arguments, concessions, and independent evaluations to pick the winner. " +
      "Ground your verdict in observable evidence from the debate transcript.",
    messages: [{ role: "user", content: userPrompt }],
    tools: [VERDICT_TOOL],
    tool_choice: { type: "tool", name: "submit_verdict" },
  });

  const block = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  const raw = (block?.input ?? {}) as Record<string, unknown>;

  return {
    consensusPoints: toStringArray(raw["consensusPoints"]),
    disputedPoints:  toStringArray(raw["disputedPoints"]),
    finalWinner:     String(raw["finalWinner"] ?? evalA.recommendedWinner),
    finalRationale:  String(raw["finalRationale"] ?? ""),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map(String);
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class BuilderDebater implements UXDebater {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 3 });
  }

  async debate(
    spec: RunSpec,
    evalA: UXEvaluation,
    evalB: UXEvaluation,
    inputs?: CandidateUXInput[],
  ): Promise<UXDebateResult> {
    if (!inputs || inputs.length === 0) {
      log("builder-debate", "No candidate inputs — falling back to empty debate");
      return {
        runId: spec.id,
        rounds: [],
        consensusPoints: [],
        disputedPoints: ["No candidate inputs provided to builder debate."],
        finalWinner: evalA.recommendedWinner,
        finalRationale: "Fallback: no builder inputs. Winner from evaluator A.",
        completedAt: new Date().toISOString(),
      };
    }

    log("builder-debate", `Starting builder debate — ${inputs.length} candidates`);

    // Phase 1: Parallel openings
    log("builder-debate", "Phase 1 — builder openings (parallel)");
    const openings = await Promise.all(
      inputs.map((inp, i) => builderOpening(this.client, spec, inp, evalA, evalB, i))
    );

    // Phase 2: Parallel rebuttals
    log("builder-debate", "Phase 2 — builder rebuttals (parallel)");
    const rebuttals = await Promise.all(
      inputs.map((inp, i) => builderRebuttal(this.client, spec, inp, openings, i))
    );

    // Phase 3: Judge verdict
    log("builder-debate", "Phase 3 — judge verdict");
    let verdict: { consensusPoints: string[]; disputedPoints: string[]; finalWinner: string; finalRationale: string };
    try {
      verdict = await judgeVerdict(this.client, spec, evalA, evalB, openings, rebuttals, inputs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("builder-debate", `Judge verdict failed — ${msg}`);
      verdict = {
        consensusPoints: [],
        disputedPoints: [`Judge call failed: ${msg}`],
        finalWinner: evalA.recommendedWinner,
        finalRationale: `Judge unavailable. Fallback to evaluator A winner: ${evalA.recommendedWinner.slice(0,8)}.`,
      };
    }

    const allRounds = [...openings, ...rebuttals];
    log("builder-debate", `Debate complete — winner: ${verdict.finalWinner.slice(0,8)}`);

    return {
      runId: spec.id,
      rounds: allRounds,
      consensusPoints: verdict.consensusPoints,
      disputedPoints:  verdict.disputedPoints,
      finalWinner:     verdict.finalWinner,
      finalRationale:  verdict.finalRationale,
      completedAt:     new Date().toISOString(),
    };
  }
}

export function createBuilderDebater(apiKey: string): UXDebater {
  return new BuilderDebater(apiKey);
}
