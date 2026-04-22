/**
 * Server lifecycle helpers for the recorder and self-verifier.
 *
 * Runtime resolution has moved to src/runtime/runtime-resolver.ts — this file
 * only handles workspace prep, server spawning, port polling, and freeing.
 *
 * spawnServer — spawns the command, collects startup output, returns a handle
 *   with a kill() method. Caller is responsible for calling kill() when done.
 *
 * waitForPort — polls http://localhost:PORT/ with 500ms intervals until the
 *   server responds or the timeout elapses.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";

export interface ServerHandle {
  port: number;
  url: string;
  startupLog: string;
  kill(): void;
}

// ─── Workspace preparation ────────────────────────────────────────────────────

/**
 * Run npm install + build before trying to start the server.
 * Safe to call even if package.json doesn't exist — returns immediately.
 * Errors are captured in the log rather than thrown.
 */
export async function prepareWorkspace(workspaceRoot: string): Promise<string> {
  if (!existsSync(join(workspaceRoot, "package.json"))) return "";

  const lines: string[] = [];

  const install = await runToCompletion("npm install", workspaceRoot, 120_000);
  lines.push(`[prep] npm install → exit ${install.exitCode}`);
  if (install.stderr.trim()) lines.push(install.stderr.slice(0, 400));

  if (existsSync(join(workspaceRoot, "tsconfig.json"))) {
    const build = await runToCompletion("npx tsc", workspaceRoot, 60_000);
    lines.push(`[prep] npx tsc → exit ${build.exitCode}`);
    if (build.stderr.trim()) lines.push(build.stderr.slice(0, 400));
  }

  return lines.join("\n");
}

function runToCompletion(
  command: string,
  cwd: string,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      resolve({ exitCode: 1, stdout, stderr: stderr + "\n[timed out]" });
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: "", stderr: err.message });
    });
  });
}

// ─── Port cleanup ─────────────────────────────────────────────────────────────

const CANDIDATE_PORTS = [3000, 8080, 3001, 8000, 4000];

/**
 * Kill any process currently listening on the given port so that our server
 * can bind to it cleanly. Leftover processes from previous pipeline runs would
 * otherwise satisfy waitForPort() before our server is ready, causing the
 * recorder to screenshot a stale workspace.
 */
export async function freePort(port: number): Promise<void> {
  return new Promise((resolve) => {
    // Windows: netstat + taskkill; Unix: fuser/lsof
    const isWin = process.platform === "win32";
    const cmd = isWin
      ? `FOR /F "tokens=5" %p IN ('netstat -ano ^| findstr :${port} ^| findstr LISTENING') DO taskkill /F /PID %p`
      : `fuser -k ${port}/tcp 2>/dev/null || lsof -t -i:${port} | xargs kill -9 2>/dev/null`;
    const child = spawn(cmd, { shell: true });
    child.on("close", () => resolve());
    child.on("error", () => resolve()); // non-fatal
    setTimeout(resolve, 2000); // safety timeout
  });
}

// ─── Server spawn ─────────────────────────────────────────────────────────────

export function spawnServer(command: string, cwd: string): ServerHandle {
  let startupLog = "";
  let child: ChildProcess;

  child = spawn(command, { cwd, shell: true, detached: false });
  child.stdout?.on("data", (d: Buffer) => { startupLog += d.toString(); });
  child.stderr?.on("data", (d: Buffer) => { startupLog += d.toString(); });

  return {
    port: 0, // filled in by waitForPort
    url: "",
    get startupLog() { return startupLog; },
    kill() {
      try { child.kill(); } catch { /* already dead */ }
    },
  };
}

// ─── Port detection ───────────────────────────────────────────────────────────

/**
 * Poll candidate ports until one responds with any HTTP status.
 * Returns { port, url } on success, null on timeout.
 */
export async function waitForPort(
  timeoutMs: number,
  preferPort?: number
): Promise<{ port: number; url: string } | null> {
  const ports = preferPort
    ? [preferPort, ...CANDIDATE_PORTS.filter((p) => p !== preferPort)]
    : CANDIDATE_PORTS;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const port of ports) {
      if (await checkPort(port)) {
        return { port, url: `http://localhost:${port}/` };
      }
    }
    await sleep(500);
  }
  return null;
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/`, { timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Port extraction from spec text ──────────────────────────────────────────

export function extractPortFromText(text: string): number | undefined {
  const m = text.match(/(?:port\s+|:)(\d{4,5})/i);
  return m ? parseInt(m[1]!, 10) : undefined;
}
