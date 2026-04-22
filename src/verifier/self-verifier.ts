/**
 * SelfVerifier — Playwright-based self-verification for a single candidate.
 *
 * After the build stage, each candidate is responsible for verifying its own
 * running server. This module:
 *   1. Derives the API endpoints to probe from the locked spec (same logic as
 *      the recorder's buildScript — spec drives the test plan, not the code)
 *   2. Starts the app server (routing through execFn/spawnServerFn when in Docker)
 *   3. Uses Playwright's APIRequestContext to probe each endpoint
 *   4. Returns a structured SelfVerificationResult (pass/fail per check)
 *
 * No browser launch, no video, no screenshots — those are the recorder's job.
 * Persists to candidates/<id>/self-verification.json.
 */

import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";

const execAsync = promisify(exec);
import type {
  RunSpec,
  Workspace,
  SelfVerificationResult,
  SelfVerificationCheck,
  ExecFn,
  ServerSpawnFn,
} from "../types/index.js";
import {
  spawnServer,
  waitForPort,
  extractPortFromText,
} from "../recorder/server.js";
import { resolveRuntime, summarizeRuntime, captureServerDiagnostics } from "../runtime/runtime-resolver.js";
import { createRecorder } from "../recorder/index.js";
import { log } from "../logger.js";

const SERVER_WAIT_MS = 15_000;

export interface SelfVerifyOptions {
  execFn?: ExecFn;
  spawnServerFn?: ServerSpawnFn;
  overridePort?: number;
}

export async function selfVerify(
  spec: RunSpec,
  workspace: Workspace,
  opts?: SelfVerifyOptions
): Promise<SelfVerificationResult> {
  const now = () => new Date().toISOString();
  const candidateDir = dirname(workspace.rootPath);

  // ── Determine verification strategy ─────────────────────────────────────
  // If the spec has shell-command criteria (grep, tsc, npx, etc.) and no HTTP
  // endpoint criteria, run those commands directly — no server needed.
  const hasShellCriteria = spec.successCriteria.some((c) =>
    /run\s+`[^`]+`/i.test(c.description) || c.checkKind === "static"
  );
  const hasHttpCriteria = spec.successCriteria.some((c) =>
    /\b(GET|POST|PUT|PATCH|DELETE)\s+\//.test(c.description)
  );

  if (hasShellCriteria && !hasHttpCriteria) {
    log("self-verify", `[${spec.id.slice(0, 8)}] Detected shell-command criteria — running checks directly${opts?.execFn ? " (via docker exec)" : ""}`);
    return runShellCriteria(spec, workspace.rootPath, candidateDir, now, opts?.execFn);
  }

  // ── REST API path: derive steps from recorder's buildScript ──────────────
  const script = createRecorder().buildScript(spec);
  const apiSteps = script.steps.filter((s) => s.kind === "browser-api-call");

  // ── Workspace preparation (Docker mode: run inside container) ─────────────
  // In local-process mode prepareWorkspace is called by the recorder; in Docker
  // mode the self-verifier starts the server first so we must install deps here.
  if (opts?.execFn) {
    log("self-verify", `[${spec.id.slice(0, 8)}] Preparing workspace via docker exec...`);
    const hasPkg = (await opts.execFn("test -f package.json", undefined, 5_000)).exitCode === 0;
    if (hasPkg) {
      const install = await opts.execFn("npm install --prefer-offline 2>&1", undefined, 120_000);
      log("self-verify", `[${spec.id.slice(0, 8)}] npm install → exit ${install.exitCode}`);
      const hasTsc = (await opts.execFn("test -f tsconfig.json", undefined, 5_000)).exitCode === 0;
      if (hasTsc) {
        const build = await opts.execFn("npx tsc 2>&1", undefined, 60_000);
        log("self-verify", `[${spec.id.slice(0, 8)}] npx tsc → exit ${build.exitCode}`);
      }
    }
  }

  // ── Server start ──────────────────────────────────────────────────────────

  const runtime = await resolveRuntime(workspace.rootPath);
  log("self-verify", `[${spec.id.slice(0, 8)}] Runtime: ${summarizeRuntime(runtime)}`);
  if (!runtime) {
    return persist(candidateDir, {
      runId: spec.id,
      passed: false,
      serverStarted: false,
      checks: [],
      completedAt: now(),
    });
  }

  const spawnFn = opts?.spawnServerFn ?? spawnServer;
  const serverHandle = spawnFn(runtime.startCmd, workspace.rootPath);
  const preferPort = opts?.overridePort
    ?? extractPortFromText(spec.successCriteria.map((c) => c.description).join(" "));
  const portResult = await waitForPort(SERVER_WAIT_MS, preferPort);

  if (!portResult) {
    log("self-verify", `[${spec.id.slice(0, 8)}] Server did not respond within ${SERVER_WAIT_MS / 1000}s`);
    if (opts?.execFn) {
      const diag = await captureServerDiagnostics(opts.execFn);
      log("self-verify", `[${spec.id.slice(0, 8)}] diagnostics:\n${diag}`);
    }
    serverHandle.kill();
    return persist(candidateDir, {
      runId: spec.id,
      passed: false,
      serverStarted: false,
      checks: [],
      completedAt: now(),
    });
  }

  const baseUrl = portResult.url.replace(/\/$/, "");
  log("self-verify", `[${spec.id.slice(0, 8)}] Server ready at ${portResult.url} — probing ${apiSteps.length} endpoint(s)`);

  // ── Playwright API probes ─────────────────────────────────────────────────
  // The outer finally guarantees the server is killed even if Playwright throws.

  const checks: SelfVerificationCheck[] = [];

  try {
    const pw = await importPlaywrightRequest();

    if (pw && apiSteps.length > 0) {
      let lastCreatedId: string | number | null = null;
      const ctx = await pw.request.newContext({ baseURL: baseUrl });

      try {
        for (const step of apiSteps) {
          const [method, rawPath] = step.command.split(" ") as [string, string];

          // Substitute :id placeholder with the ID returned by the last POST
          const resolvedPath = lastCreatedId !== null
            ? rawPath.replace(/:id\b|\{id\}/g, String(lastCreatedId))
            : rawPath.replace(/\/:[^/]+/g, "/1");

          const endpoint = `${method} ${resolvedPath}`;
          const t = Date.now();
          let passed = false;
          let httpStatus: number | undefined;
          let reason: string;

          try {
            const fetchOpts: PlaywrightFetchOptions = { method };
            if (step.body) {
              fetchOpts.headers = { "Content-Type": "application/json" };
              fetchOpts.data = step.body;
            }

            const res = await ctx.fetch(resolvedPath, fetchOpts);
            httpStatus = res.status();
            passed = httpStatus >= 200 && httpStatus < 300;

            // Track the ID returned by a successful POST so DELETE/PUT/:id can use it
            if (passed && method === "POST") {
              try {
                const body = await res.json() as Record<string, unknown>;
                const id = body["id"] ?? body["_id"] ?? body["uuid"];
                if (id !== undefined) lastCreatedId = id as string | number;
              } catch { /* non-JSON or no id field */ }
            }

            reason = passed ? `HTTP ${httpStatus}` : `HTTP ${httpStatus} — expected 2xx`;
          } catch (err) {
            reason = err instanceof Error ? err.message : String(err);
          }

          log("self-verify", `  ${endpoint} → ${passed ? "PASS" : "FAIL"}${httpStatus !== undefined ? ` (${httpStatus})` : ""}`);

          checks.push({
            description: step.description,
            endpoint,
            passed,
            ...(httpStatus !== undefined ? { httpStatus } : {}),
            reason,
            durationMs: Date.now() - t,
          });
        }
      } finally {
        await ctx.dispose();
      }
    } else if (!pw) {
      log("self-verify", `[${spec.id.slice(0, 8)}] Playwright not available — no API checks run`);
    } else {
      log("self-verify", `[${spec.id.slice(0, 8)}] No API steps derived from spec — no checks run`);
    }
  } finally {
    // Kill the server regardless of Playwright success or failure.
    try {
      serverHandle.kill();
      log("self-verify", `[${spec.id.slice(0, 8)}] Server process killed`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("self-verify", `[${spec.id.slice(0, 8)}] Server kill failed (non-fatal) — ${msg}`);
    }
  }

  const passed = checks.length > 0 && checks.every((c) => c.passed);
  const passCount = checks.filter((c) => c.passed).length;
  log("self-verify", `[${spec.id.slice(0, 8)}] ${passed ? "PASSED" : "FAILED"} — ${passCount}/${checks.length} checks passed`);

  return persist(candidateDir, {
    runId: spec.id,
    passed,
    serverStarted: true,
    checks,
    completedAt: now(),
  });
}

// ─── Shell-criteria verification (frontend / static apps) ────────────────────

async function runShellCriteria(
  spec: RunSpec,
  workspaceRoot: string,
  candidateDir: string,
  now: () => string,
  execFn?: ExecFn,
): Promise<SelfVerificationResult> {
  const checks: SelfVerificationCheck[] = [];

  for (const criterion of spec.successCriteria) {
    const t = Date.now();
    let passed = false;
    let reason = "";

    // Extract file paths from backtick spans (no spaces = looks like a file path)
    const filePaths = [...criterion.description.matchAll(/`([^`]+)`/g)]
      .map(m => m[1]!)
      .filter(p => /[\w.-]+\.\w+/.test(p) && !p.includes(" "));

    // Extract a shell command from "run `command`" pattern
    const cmdMatch = criterion.description.match(/run\s+`([^`]+)`/i);
    const shellCmd = cmdMatch?.[1];

    if (filePaths.length > 0 && !shellCmd) {
      // Pure file-existence check — use host existsSync (bind mount is visible on host)
      const missing = filePaths.filter(p => !existsSync(join(workspaceRoot, p)));
      passed = missing.length === 0;
      reason = passed
        ? `All file(s) present: ${filePaths.join(", ")}`
        : `Missing file(s): ${missing.join(", ")}. Present: ${filePaths.filter(p => existsSync(join(workspaceRoot, p))).join(", ")}`;

    } else if (shellCmd) {
      // Shell command — run inside container (execFn) or on host (bash)
      const isDevServer = /\b(vite|webpack(?:-dev-server)?|react-scripts\s+start|npm\s+run\s+dev)\b/.test(shellCmd)
        || shellCmd.trimEnd().endsWith("&");

      if (isDevServer) {
        passed = true;
        reason = "Dev server command skipped — recorder handles server startup";
        log("self-verify", `  ~ [skip] ${shellCmd.slice(0, 80)} (dev server)`);
      } else {
        log("self-verify", `  > ${execFn ? "[container]" : "[host]"} ${shellCmd.slice(0, 80)}`);
        const { exitCode, output } = await runCmd(shellCmd, workspaceRoot, execFn);
        passed = exitCode === 0;
        reason = passed
          ? `Exit 0: ${output.slice(0, 200)}`
          : `Command exited ${exitCode}: ${shellCmd} | stdout: ${output.slice(0, 200)}`;
        log("self-verify", `  < exit ${exitCode}${output ? " — " + output.slice(0, 60) : ""}`);
      }

    } else {
      // No file path and no shell command — nothing to check, mark skipped
      passed = true;
      reason = "No file path or shell command to check";
    }

    const description = criterion.description.slice(0, 120);
    if (passed) {
      log("self-verify", `  ✓ [${criterion.checkKind}] ${description.slice(0, 80)}`);
    } else {
      log("self-verify", `  ✗ [${criterion.checkKind}] ${description.slice(0, 80)}`);
      log("self-verify", `    reason: ${reason.slice(0, 160)}`);
    }

    checks.push({
      description: criterion.description,
      endpoint: criterion.checkKind === "static" ? "static-check" : "shell-command",
      passed,
      reason,
      durationMs: Date.now() - t,
    });
  }

  const passCount = checks.filter(c => c.passed).length;
  const passed = checks.length > 0 && checks.every(c => c.passed);
  log("self-verify", `[${spec.id.slice(0, 8)}] ${passed ? "PASSED" : "FAILED"} — ${passCount}/${checks.length} checks passed`);

  return persist(candidateDir, {
    runId: spec.id,
    passed,
    serverStarted: false,
    checks,
    completedAt: now(),
  });
}

// ─── Command runner — routes through execFn (Docker) or host bash ─────────────

async function runCmd(
  cmd: string,
  cwd: string,
  execFn?: ExecFn,
): Promise<{ exitCode: number; output: string }> {
  if (execFn) {
    const r = await execFn(cmd, cwd, 60_000);
    return { exitCode: r.exitCode, output: (r.stdout + (r.stderr ? "\n" + r.stderr : "")).trim() };
  }
  try {
    const r = await execAsync(cmd, { cwd, timeout: 30_000, shell: "bash" });
    return { exitCode: 0, output: (r.stdout + r.stderr).trim() };
  } catch (err: unknown) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { exitCode: e.code ?? 1, output: ((e.stdout ?? "") + (e.stderr ?? "")).trim() };
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

async function persist(
  candidateDir: string,
  result: SelfVerificationResult
): Promise<SelfVerificationResult> {
  await writeFile(
    join(candidateDir, "self-verification.json"),
    JSON.stringify(result, null, 2),
    "utf8"
  );
  return result;
}

// ─── Playwright request-only dynamic import ───────────────────────────────────
// We only need APIRequestContext — no browser launch required.

interface PlaywrightFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  data?: string;
}

interface PlaywrightAPIResponse {
  status(): number;
  ok(): boolean;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

interface PlaywrightRequestContext {
  fetch(url: string, opts?: PlaywrightFetchOptions): Promise<PlaywrightAPIResponse>;
  dispose(): Promise<void>;
}

interface PlaywrightWithRequest {
  request: {
    newContext(opts?: { baseURL?: string }): Promise<PlaywrightRequestContext>;
  };
}

async function importPlaywrightRequest(): Promise<PlaywrightWithRequest | null> {
  try {
    const pw = await import("playwright");
    return pw as unknown as PlaywrightWithRequest;
  } catch {
    return null;
  }
}
