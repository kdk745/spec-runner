/**
 * ClaudeUXDebater — bounded structured debate between two independent UX evaluations.
 *
 * Takes the outputs of Evaluator A (correctness-focused) and Evaluator B
 * (quality-focused) and generates a 4-round debate transcript in a single
 * Claude call via tool_use, then synthesizes a final winner.
 *
 * Debate structure (MAX_DEBATE_ROUNDS = 4):
 *   Round 1 — Evaluator A opening:  present ranking with specific UX evidence
 *   Round 2 — Evaluator B opening:  present ranking with specific UX evidence
 *   Round 3 — Evaluator A rebuttal: respond to B's key claims, grant or refute
 *   Round 4 — Evaluator B rebuttal: respond to A's key claims, grant or refute
 *
 * Every claim must reference an observable UX moment (step, endpoint, status, excerpt).
 * No claims about code quality or implementation style are permitted.
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  RunSpec,
  UXEvaluation,
  UXDebateResult,
  DebateRound,
} from "../types/index.js";
import { log } from "../logger.js";

const MODEL = "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS = 8192;
const MAX_DEBATE_ROUNDS = 4;

// ─── Interface ────────────────────────────────────────────────────────────────

export interface UXDebater {
  debate(
    spec: RunSpec,
    evalA: UXEvaluation,
    evalB: UXEvaluation,
  ): Promise<UXDebateResult>;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the moderator of a structured UX evaluation debate.

Two independent evaluators reviewed the same candidate API implementations from recording artifacts.
- Evaluator A focused on API CORRECTNESS and CRUD completeness
- Evaluator B focused on RESPONSE QUALITY and UX consistency

Generate a structured debate transcript with exactly ${MAX_DEBATE_ROUNDS} rounds:
  Round 1 — Evaluator A opening:  present their ranking with specific observable evidence
  Round 2 — Evaluator B opening:  present their ranking with specific observable evidence
  Round 3 — Evaluator A rebuttal: respond to B's key claims — grant what is valid, refute with evidence
  Round 4 — Evaluator B rebuttal: respond to A's key claims — grant what is valid, refute with evidence

Strict rules:
- Every claim MUST cite a specific observable moment: step name, endpoint, HTTP status, or response excerpt
- No claims about code quality, file structure, implementation style, or naming conventions
- Concessions must be honest — grant valid points the other evaluator made
- Each round: 2–4 substantive points maximum (no padding, no repetition)
- If evaluators agree on the winner, the debate should challenge that consensus to stress-test it

After all rounds, synthesize a final winner from the weight of evidence in the transcript.`;

// ─── Tool definition ──────────────────────────────────────────────────────────

const DEBATE_TOOL: Anthropic.Tool = {
  name: "submit_debate_result",
  description: "Submit the structured debate transcript and final verdict.",
  input_schema: {
    type: "object",
    properties: {
      rounds: {
        type: "array",
        description: `Exactly ${MAX_DEBATE_ROUNDS} rounds in order: A-open, B-open, A-rebut, B-rebut.`,
        items: {
          type: "object",
          properties: {
            evaluatorId: {
              type: "string",
              enum: ["A", "B"],
              description: "Which evaluator is speaking.",
            },
            roundIndex: {
              type: "integer",
              minimum: 1,
              maximum: MAX_DEBATE_ROUNDS,
            },
            position: {
              type: "string",
              description: "The evaluator's argument this turn.",
            },
            evidenceRefs: {
              type: "array",
              items: { type: "string" },
              description: "Observable moments cited: step name, endpoint, HTTP status, response excerpt.",
            },
            concessions: {
              type: "array",
              items: { type: "string" },
              description: "Points granted to the opposing evaluator this round.",
            },
          },
          required: ["evaluatorId", "roundIndex", "position", "evidenceRefs", "concessions"],
        },
      },
      consensusPoints: {
        type: "array",
        items: { type: "string" },
        description: "Points both evaluators agreed on across the debate.",
      },
      disputedPoints: {
        type: "array",
        items: { type: "string" },
        description: "Points that remained genuinely disputed after all rounds.",
      },
      finalWinner: {
        type: "string",
        description: "candidateId of the final recommended winner.",
      },
      finalRationale: {
        type: "string",
        description: "Paragraph explaining the final verdict, grounded in debate evidence.",
      },
    },
    required: ["rounds", "consensusPoints", "disputedPoints", "finalWinner", "finalRationale"],
  },
};

// ─── Prompt construction ──────────────────────────────────────────────────────

function buildDebatePrompt(spec: RunSpec, evalA: UXEvaluation, evalB: UXEvaluation): string {
  const lines: string[] = [
    `# Debate Setup`,
    ``,
    `**Specification goal:** ${spec.goal}`,
    ...(spec.constraints.length > 0 ? [`**Constraints:** ${spec.constraints.join("; ")}`] : []),
    ``,
    `**Success criteria:**`,
    ...spec.successCriteria.map((c, i) => `  ${i + 1}. [${c.checkKind}] ${c.description}`),
    ``,
    `---`,
    `## Evaluator A — API Correctness & CRUD Completeness`,
    `**Recommended winner:** ${evalA.recommendedWinner}`,
    `**Rationale:** ${evalA.rationale}`,
    ``,
    `**Rankings:**`,
  ];

  for (const a of evalA.ranking) {
    lines.push(`- ${a.candidateId.slice(0, 8)} — rank ${a.rank}, score ${a.score}/100`);
    if (a.strengths.length > 0) lines.push(`  Strengths: ${a.strengths.join("; ")}`);
    if (a.weaknesses.length > 0) lines.push(`  Weaknesses: ${a.weaknesses.join("; ")}`);
    const moments = a.observedMoments.slice(0, 3);
    if (moments.length > 0) lines.push(`  Evidence: ${moments.join(" | ")}`);
  }
  if (evalA.tradeoffs.length > 0) {
    lines.push(``, `**Cross-candidate tradeoffs (A):** ${evalA.tradeoffs.join("; ")}`);
  }

  lines.push(
    ``,
    `---`,
    `## Evaluator B — Response Quality & UX Consistency`,
    `**Recommended winner:** ${evalB.recommendedWinner}`,
    `**Rationale:** ${evalB.rationale}`,
    ``,
    `**Rankings:**`,
  );

  for (const a of evalB.ranking) {
    lines.push(`- ${a.candidateId.slice(0, 8)} — rank ${a.rank}, score ${a.score}/100`);
    if (a.strengths.length > 0) lines.push(`  Strengths: ${a.strengths.join("; ")}`);
    if (a.weaknesses.length > 0) lines.push(`  Weaknesses: ${a.weaknesses.join("; ")}`);
    const moments = a.observedMoments.slice(0, 3);
    if (moments.length > 0) lines.push(`  Evidence: ${moments.join(" | ")}`);
  }
  if (evalB.tradeoffs.length > 0) {
    lines.push(``, `**Cross-candidate tradeoffs (B):** ${evalB.tradeoffs.join("; ")}`);
  }

  const agree = evalA.recommendedWinner === evalB.recommendedWinner;
  lines.push(
    ``,
    `---`,
    agree
      ? `**Evaluators AGREE** on winner: ${evalA.recommendedWinner.slice(0, 8)}. Debate should stress-test this consensus — what evidence challenges it?`
      : `**Evaluators DISAGREE**: A recommends ${evalA.recommendedWinner.slice(0, 8)}, B recommends ${evalB.recommendedWinner.slice(0, 8)}. Debate must resolve this with evidence.`,
    ``,
    `Generate the ${MAX_DEBATE_ROUNDS}-round debate now and call submit_debate_result.`,
  );

  return lines.join("\n");
}

// ─── Result parsing ───────────────────────────────────────────────────────────

interface RawDebateInput {
  rounds?: unknown[];
  consensusPoints?: unknown[];
  disputedPoints?: unknown[];
  finalWinner?: unknown;
  finalRationale?: unknown;
}

interface RawRound {
  evaluatorId?: unknown;
  roundIndex?: unknown;
  position?: unknown;
  evidenceRefs?: unknown;
  concessions?: unknown;
}

function parseDebateInput(runId: string, input: Record<string, unknown>): UXDebateResult {
  const raw = input as RawDebateInput;

  const rounds: DebateRound[] = ((raw.rounds as RawRound[]) ?? []).map((r) => ({
    evaluatorId: (r.evaluatorId === "A" || r.evaluatorId === "B") ? r.evaluatorId : "A",
    roundIndex:  Number(r.roundIndex ?? 0),
    position:    String(r.position ?? ""),
    evidenceRefs: toStringArray(r.evidenceRefs),
    concessions:  toStringArray(r.concessions),
  }));

  return {
    runId,
    rounds,
    consensusPoints: toStringArray(raw.consensusPoints),
    disputedPoints:  toStringArray(raw.disputedPoints),
    finalWinner:     String(raw.finalWinner ?? ""),
    finalRationale:  String(raw.finalRationale ?? ""),
    completedAt:     new Date().toISOString(),
  };
}

function toStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.map(String);
}

// ─── Fallback ─────────────────────────────────────────────────────────────────

function fallbackDebate(
  runId: string,
  evalA: UXEvaluation,
  evalB: UXEvaluation,
  error: string,
): UXDebateResult {
  // Best-effort: use whichever evaluation had a higher top score as tiebreaker
  const topA = evalA.ranking[0]?.score ?? 0;
  const topB = evalB.ranking[0]?.score ?? 0;
  const winner = topA >= topB ? evalA.recommendedWinner : evalB.recommendedWinner;

  return {
    runId,
    rounds: [],
    consensusPoints: [],
    disputedPoints: [`Debate unavailable: ${error}`],
    finalWinner: winner,
    finalRationale: `Debate failed: ${error}. Winner selected from higher evaluation score as fallback.`,
    completedAt: new Date().toISOString(),
  };
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class ClaudeUXDebater implements UXDebater {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async debate(spec: RunSpec, evalA: UXEvaluation, evalB: UXEvaluation): Promise<UXDebateResult> {
    const agree = evalA.recommendedWinner === evalB.recommendedWinner;
    log("ux-debate", `Starting ${MAX_DEBATE_ROUNDS}-round debate — A:${evalA.recommendedWinner.slice(0,8)} vs B:${evalB.recommendedWinner.slice(0,8)} (${agree ? "agree" : "DISAGREE"})`);

    const userPrompt = buildDebatePrompt(spec, evalA, evalB);

    try {
      const response = await this.client.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        tools: [DEBATE_TOOL],
        tool_choice: { type: "tool", name: "submit_debate_result" },
      });

      const toolBlock = response.content.find(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      if (!toolBlock) {
        throw new Error("Claude did not return a tool_use block");
      }

      const result = parseDebateInput(spec.id, toolBlock.input as Record<string, unknown>);
      log("ux-debate", `Debate complete — ${result.rounds.length} rounds, winner: ${result.finalWinner.slice(0,8)}`);
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("ux-debate", `Debate failed — ${msg}`);
      return fallbackDebate(spec.id, evalA, evalB, msg);
    }
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createClaudeUXDebater(apiKey: string): UXDebater {
  return new ClaudeUXDebater(apiKey);
}
