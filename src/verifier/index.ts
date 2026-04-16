/**
 * Verifier interface.
 *
 * The verifier runs entirely independently of the worker — it reads only from
 * the workspace and the locked spec. It never writes artifacts.
 *
 * Each SuccessCriterion in the spec maps to exactly one CheckResult.
 * Verification passes only when all criteria pass.
 */

import type { RunSpec, Workspace, VerificationResult, ExecFn } from "../types/index.js";

export type { ExecFn };

export interface Verifier {
  /**
   * Verify all success criteria in the spec against the current workspace state.
   * Must resolve (not reject) — encode failures inside VerificationResult.
   *
   * execFn: when provided, shell commands (npm install, tsc, etc.) are routed
   *   through the isolated environment instead of running on the host directly.
   */
  verify(spec: RunSpec, workspace: Workspace, execFn?: ExecFn): Promise<VerificationResult>;
}

// ─── Check kinds ──────────────────────────────────────────────────────────────

/**
 * "static"  — file existence, syntax checks, linting
 * "runtime" — run a command inside the workspace and check exit code / output
 * "llm"     — send artifact content + criterion to an LLM judge (bounded prompt)
 *
 * TODO: implement each kind in src/verifier/checks/
 */

// ─── Factory ─────────────────────────────────────────────────────────────────

export { createVerifier } from "./default-verifier.js";
