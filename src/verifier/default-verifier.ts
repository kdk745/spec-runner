/**
 * DefaultVerifier — dispatches criteria to check implementations and writes
 * verification.json to the candidate directory.
 *
 * Output path: dirname(workspace.rootPath)/verification.json
 * i.e. runs/<runId>/candidates/<candidateId>/verification.json
 *
 * Always resolves — check failures are encoded in the result, not thrown.
 */

import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { prepareWorkspace } from "../recorder/server.js";
import { log } from "../logger.js";
import { runStaticCheck } from "./checks/static.js";
import { runRuntimeCheck } from "./checks/runtime.js";
import { runLlmCheck } from "./checks/llm.js";
import type { Verifier } from "./index.js";
import type {
  RunSpec,
  Workspace,
  CheckResult,
  VerificationResult,
  VerificationState,
  ExecFn,
} from "../types/index.js";

export class DefaultVerifier implements Verifier {
  async verify(spec: RunSpec, workspace: Workspace, execFn?: ExecFn): Promise<VerificationResult> {
    // Install dependencies before running any checks — runtime checks (npx tsc,
    // npm start, curl) will fail if node_modules is missing.
    log("build", "Preparing workspace (npm install + tsc)...");
    if (execFn) {
      // Run prep commands inside the isolated environment
      const hasPkg = (await execFn("test -f package.json", undefined, 5_000)).exitCode === 0;
      if (hasPkg) {
        const install = await execFn("npm install 2>&1", undefined, 120_000);
        log("build", `  npm install → exit ${install.exitCode}`);
        const hasTsc = (await execFn("test -f tsconfig.json", undefined, 5_000)).exitCode === 0;
        if (hasTsc) {
          const tsc = await execFn("npx tsc 2>&1", undefined, 60_000);
          log("build", `  npx tsc → exit ${tsc.exitCode}`);
        }
      }
    } else if (existsSync(join(workspace.rootPath, "package.json"))) {
      await prepareWorkspace(workspace.rootPath);
    }

    const checks: CheckResult[] = [];

    for (const criterion of spec.successCriteria) {
      let check: CheckResult;
      switch (criterion.checkKind) {
        case "static":
          check = await runStaticCheck(criterion, workspace);
          break;
        case "runtime":
          check = await runRuntimeCheck(criterion, workspace, execFn);
          break;
        case "llm":
          check = await runLlmCheck(criterion, workspace);
          break;
      }
      const icon = check.skipped ? "~" : check.passed ? "✓" : "✗";
      log("build", `  ${icon} [${criterion.checkKind}] ${criterion.description.slice(0, 80)}`);
      if (!check.passed && !check.skipped) {
        log("build", `    reason: ${check.reason.slice(0, 120)}`);
      }
      checks.push(check);
    }

    const state = deriveState(checks);
    const verificationResult: VerificationResult = {
      runId: spec.id,
      passed: state === "passed",
      state,
      checks,
      completedAt: new Date().toISOString(),
    };

    // Write alongside result.json in the candidate directory
    const candidateDir = dirname(workspace.rootPath);
    await writeFile(
      join(candidateDir, "verification.json"),
      JSON.stringify(verificationResult, null, 2),
      "utf8"
    );

    return verificationResult;
  }
}

function deriveState(checks: CheckResult[]): VerificationState {
  const active = checks.filter((c) => !c.skipped);
  if (active.length === 0) return "failed"; // nothing was actually checked

  const passCount = active.filter((c) => c.passed).length;
  if (passCount === active.length) return "passed";
  if (passCount > 0) return "partial";
  return "failed";
}

export function createVerifier(): Verifier {
  return new DefaultVerifier();
}
