/**
 * Runtime checks — execute a command derived from the criterion description
 * inside the candidate workspace and assert exit code 0.
 *
 * Command extraction heuristics (applied in order):
 *   1. Backtick-quoted text: `npx tsc --noEmit`
 *   2. Text before "exits", "returns", "outputs", "should" (when line starts
 *      with a known CLI prefix: node/npm/npx/python/bash/sh/pnpm/yarn/bun)
 *   3. Entire description when it starts with a known CLI prefix
 *
 * If no command can be extracted, the check is marked failed with a
 * clear reason — never silently skipped.
 *
 * Timeout: 30 seconds. Commands that time out are failed, not errored.
 */

import { spawn } from "node:child_process";
import type { CheckResult, SuccessCriterion, Workspace, ExecFn } from "../../types/index.js";
import { log } from "../../logger.js";

const TIMEOUT_MS = 30_000;
const CLI_PREFIX = /^(node|npm|npx|python|python3|bash|sh|pnpm|yarn|bun)\b/;

/**
 * Commands that start a long-running server process — these never exit on their
 * own, so running them in the verifier would always hang until the 30s timeout.
 * Server-start behaviour is verified by the recorder stage instead.
 */
const SERVER_START_PATTERN = /^(npm\s+start|npm\s+run\s+start|node\s+(?:dist|src|\.)\/.+\.js|node\s+\w+\.js|ts-node\b)/i;

/**
 * Commands that probe a live HTTP server (curl, wget, http) — these require
 * the server to already be running, which is the recorder's job, not the verifier's.
 */
const LIVE_PROBE_PATTERN = /^(curl|wget|http\b)|\$\((curl|wget)\b/i;

export async function runRuntimeCheck(
  criterion: SuccessCriterion,
  workspace: Workspace,
  execFn?: ExecFn
): Promise<CheckResult> {
  const started = Date.now();
  const command = extractCommand(criterion.description);

  if (!command) {
    log("build", `  ? [runtime] no command extracted from: "${criterion.description.slice(0, 80)}"`);
    return {
      criterionId: criterion.id,
      name: criterion.description,
      passed: false,
      skipped: false,
      reason: `Could not extract a runnable command from: "${criterion.description}"`,
      durationMs: Date.now() - started,
    };
  }

  // Skip server-start commands — they never exit and are covered by the recorder
  if (SERVER_START_PATTERN.test(command)) {
    log("build", `  ~ [runtime] skipping server-start command (handled by recorder): ${command}`);
    return {
      criterionId: criterion.id,
      name: criterion.description,
      passed: false,
      skipped: true,
      reason: `Skipped: "${command}" is a long-running server process. Server behaviour is verified by the recorder stage.`,
      durationMs: Date.now() - started,
    };
  }

  // Skip live-probe commands — they need a running server, which the recorder provides
  if (LIVE_PROBE_PATTERN.test(command)) {
    log("build", `  ~ [runtime] skipping live-probe command (requires running server): ${command.slice(0, 80)}`);
    return {
      criterionId: criterion.id,
      name: criterion.description,
      passed: false,
      skipped: true,
      reason: `Skipped: "${command.slice(0, 60)}" requires a live server. HTTP responses are verified by the recorder stage.`,
      durationMs: Date.now() - started,
    };
  }

  log("build", `  > running: ${command}${execFn ? " [docker exec]" : ""}`);
  const { exitCode, stdout, stderr, timedOut } = execFn
    ? await execFn(command, undefined, TIMEOUT_MS)
    : await runCommand(command, workspace.rootPath, TIMEOUT_MS);
  log("build", `  < exit ${exitCode}${timedOut ? " (timed out)" : ""}${stderr ? ` | stderr: ${stderr.slice(0, 80)}` : ""}`);

  const passed = !timedOut && exitCode === 0;

  let reason: string;
  if (timedOut) {
    reason = `Command timed out after ${TIMEOUT_MS}ms: ${command}`;
  } else if (passed) {
    reason = `Command exited 0: ${command}`;
    if (stdout.trim()) reason += ` | stdout: ${truncate(stdout)}`;
  } else {
    reason = `Command exited ${exitCode}: ${command}`;
    if (stderr.trim()) reason += ` | stderr: ${truncate(stderr)}`;
    if (stdout.trim()) reason += ` | stdout: ${truncate(stdout)}`;
  }

  return {
    criterionId: criterion.id,
    name: criterion.description,
    passed,
    skipped: false,
    reason,
    durationMs: Date.now() - started,
  };
}

// ─── Command extraction ───────────────────────────────────────────────────────

export function extractCommand(description: string): string | null {
  // 1. Backtick-quoted: `npx tsc --noEmit`
  const backtick = description.match(/`([^`]+)`/);
  if (backtick) return backtick[1]!.trim();

  // 2. Single-quoted after "run": run 'npx tsc --noEmit'
  const singleAfterRun = description.match(/\brun\s+'([^']+)'/i);
  if (singleAfterRun) return singleAfterRun[1]!.trim();

  // 3. Double-quoted after "run": run "npx tsc --noEmit"
  const doubleAfterRun = description.match(/\brun\s+"([^"]+)"/i);
  if (doubleAfterRun) return doubleAfterRun[1]!.trim();

  // 4. After "verify with:" — extract the CLI command before exits/returns/equals
  const verifyWith = description.match(/verify with:\s*([`']?)(.+?)\1\s*(?:exits?|returns?|equals?|$)/i);
  if (verifyWith) {
    const candidate = verifyWith[2]!.trim();
    if (CLI_PREFIX.test(candidate)) return candidate;
  }

  // 5. Starts with a known CLI prefix — take up to the first "exits/returns/outputs/should"
  if (CLI_PREFIX.test(description)) {
    const trimmed = description
      .replace(/\s+(exits?|returns?|outputs?|should\b|when\b).*$/i, "")
      .trim();
    if (trimmed.length > 0) return trimmed;
  }

  // 5. Contains a CLI prefix somewhere — extract from that point
  const cliIdx = description.search(CLI_PREFIX);
  if (cliIdx > 0) {
    const fromCli = description.slice(cliIdx)
      .replace(/\s+(exits?|returns?|outputs?|should\b|when\b).*$/i, "")
      .trim();
    if (fromCli.length > 0) return fromCli;
  }

  return null;
}

// ─── Command runner ───────────────────────────────────────────────────────────

interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, NODE_ENV: "test" },
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? 1,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: "", stderr: err.message, timedOut: false });
    });
  });
}

function truncate(s: string, max = 200): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}
