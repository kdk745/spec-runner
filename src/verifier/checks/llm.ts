/**
 * LLM checks — V1 stub.
 *
 * LLM-judged criteria require sending workspace artifact content to a model
 * with the criterion as the evaluation prompt. This is deferred to Phase 2.
 *
 * V1 behaviour: mark as skipped with an explicit reason. The criterion is
 * recorded in the CheckResult so downstream evaluation can still observe it.
 *
 * Phase 2 implementation notes:
 *   - Load relevant artifacts from workspace (identified by file type or
 *     build-manifest.json filesWritten list)
 *   - Send a bounded prompt: criterion description + artifact content (truncated)
 *   - Parse a structured pass/fail response from the model
 *   - Set skipped:false, passed:true/false based on model response
 */

import type { CheckResult, SuccessCriterion, Workspace } from "../../types/index.js";

export async function runLlmCheck(
  criterion: SuccessCriterion,
  _workspace: Workspace
): Promise<CheckResult> {
  return {
    criterionId: criterion.id,
    name: criterion.description,
    passed: false,
    skipped: true,
    reason: "LLM judge not implemented in V1 — criterion skipped. Will be evaluated in Phase 2.",
    durationMs: 0,
  };
}
