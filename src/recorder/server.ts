/**
 * Server lifecycle helpers for the recorder.
 *
 * resolveStartCommand — inspects the workspace to find the best start command:
 *   1. Parse README.md for a ```bash block containing node/npm start
 *   2. Check common entry-point files in order
 *   3. Return null if nothing runnable is found
 *
 * spawnServer — spawns the command, collects startup output, returns a handle
 *   with a kill() method. Caller is responsible for calling kill() when done.
 *
 * waitForPort — polls http://localhost:PORT/ with 500ms intervals until the
 *   server responds or the timeout elapses.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

// ─── Command resolution ───────────────────────────────────────────────────────

const CANDIDATE_PORTS = [3000, 8080, 3001, 8000, 4000];

const ENTRY_POINT_COMMANDS: Array<{ file: string; cmd: string }> = [
  { file: "server.js",       cmd: "node server.js" },
  { file: "app.js",          cmd: "node app.js" },
  { file: "index.js",        cmd: "node index.js" },
  { file: "src/server.js",   cmd: "node src/server.js" },
  { file: "src/index.js",    cmd: "node src/index.js" },
  { file: "dist/server.js",  cmd: "node dist/server.js" },
  { file: "dist/index.js",   cmd: "node dist/index.js" },
  { file: "dist/app.js",     cmd: "node dist/app.js" },
];

export async function resolveStartCommand(workspaceRoot: string): Promise<string | null> {
  // 1. Try README.md code blocks
  const readme = await extractReadmeCommand(workspaceRoot);
  if (readme) return readme;

  // 2. Try common entry points by file existence
  for (const { file, cmd } of ENTRY_POINT_COMMANDS) {
    if (existsSync(join(workspaceRoot, file))) return cmd;
  }

  // 3. package.json with a start script
  const pkgPath = join(workspaceRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      if (pkg.scripts?.start) return "npm start";
    } catch {
      // ignore malformed package.json
    }
  }

  // 4. Bare index.html with no package.json — serve as a static site
  if (existsSync(join(workspaceRoot, "index.html"))) {
    return "npx --yes serve -l 3000 .";
  }

  return null;
}

async function extractReadmeCommand(workspaceRoot: string): Promise<string | null> {
  const readmePath = join(workspaceRoot, "README.md");
  if (!existsSync(readmePath)) return null;

  try {
    const content = await readFile(readmePath, "utf8");
    const blockRe = /```(?:bash|sh)?\n([\s\S]*?)```/g;
    let m: RegExpExecArray | null;
    while ((m = blockRe.exec(content)) !== null) {
      const lines = m[1]!.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (/^(node|npm\s+start|node\s+dist|node\s+src)\s/.test(line)) {
          return line;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
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
