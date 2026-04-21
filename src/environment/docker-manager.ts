/**
 * DockerEnvironmentManager — provisions one Docker container per candidate.
 *
 * Each container:
 *   - Uses spec-runner-env:latest (Node 20 + Playwright + TypeScript tooling)
 *   - Bind-mounts the candidate workspace at /workspace (read-write)
 *   - Maps a randomly-allocated host port → container port 3000
 *   - Runs `sleep infinity` and accepts work via `docker exec`
 *   - Is labelled with runId / candidateId / envId for traceability
 *   - Is stopped and removed on release()
 *
 * State is persisted to:
 *   runs/<runId>/candidates/<candidateId>/environment.json
 *   runs/.env-index/<envId>.json  (lookup index for get())
 *
 * Build the image first: bash docker/build.sh
 */

import { spawn } from "node:child_process";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import type { EnvironmentManager, ExecFn, ServerSpawnFn } from "./index.js";
import type { RunId, Environment, EnvironmentConfig } from "../types/index.js";
import { log } from "../logger.js";

const CONTAINER_IMAGE    = "spec-runner-env:latest";
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_PORT     = 3000;

export class DockerEnvironmentManager implements EnvironmentManager {
  constructor(private readonly runsDir: string) {}

  // ─── provision ─────────────────────────────────────────────────────────────

  async provision(runId: RunId, candidateId: string, config: EnvironmentConfig): Promise<Environment> {
    const envId = randomUUID();
    const now   = new Date().toISOString();

    // Workspace is expected to exist (created by FsCandidateManager)
    const workspacePath = join(this.runsDir, runId, "candidates", candidateId, "workspace");
    await mkdir(workspacePath, { recursive: true });

    let env: Environment = {
      id:            envId,
      runId,
      candidateId,
      config:        { ...config, isolationType: "docker" },
      status:        "provisioning",
      workspacePath,
      createdAt:     now,
      updatedAt:     now,
    };
    await this._save(env);

    // Allocate a free host port before starting the container
    let hostPort: number;
    try {
      hostPort = await findFreePort();
    } catch (err) {
      log("arena", `[env:${envId.slice(0, 8)}] port allocation failed: ${String(err)}`);
      env = { ...env, status: "terminated", updatedAt: new Date().toISOString() };
      await this._save(env);
      return env;
    }

    const containerName = `spec-runner-${envId.slice(0, 8)}`;
    log("arena", `[env:${envId.slice(0, 8)}] provisioning container "${containerName}" (hostPort:${hostPort})`);

    try {
      const containerId = await dockerRun({
        image:         CONTAINER_IMAGE,
        name:          containerName,
        workspacePath,
        hostPort,
        containerPort: CONTAINER_PORT,
        labels: {
          "spec-runner":              "1",
          "spec-runner.run-id":       runId,
          "spec-runner.candidate-id": candidateId,
          "spec-runner.env-id":       envId,
        },
      });

      const readyAt = new Date().toISOString();
      env = { ...env, status: "ready", containerId, hostPort, updatedAt: readyAt, readyAt };
      log("arena", `[env:${envId.slice(0, 8)}] ready — container ${containerId.slice(0, 12)}, port ${hostPort}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("arena", `[env:${envId.slice(0, 8)}] provision failed: ${msg}`);
      env = { ...env, status: "terminated", updatedAt: new Date().toISOString() };
    }

    await this._save(env);
    return env;
  }

  // ─── activate ──────────────────────────────────────────────────────────────

  async activate(env: Environment): Promise<Environment> {
    const updated: Environment = { ...env, status: "running", updatedAt: new Date().toISOString() };
    await this._save(updated);
    return updated;
  }

  // ─── release ───────────────────────────────────────────────────────────────

  async release(env: Environment): Promise<Environment> {
    if (!env.containerId) {
      const terminated = { ...env, status: "terminated" as const, updatedAt: new Date().toISOString() };
      await this._save(terminated);
      return terminated;
    }

    log("arena", `[env:${env.id.slice(0, 8)}] tearing down ${env.containerId.slice(0, 12)}`);
    const teardown: Environment = { ...env, status: "teardown_requested", updatedAt: new Date().toISOString() };
    await this._save(teardown);

    try {
      await dockerStop(env.containerId);
      await dockerRemove(env.containerId);
    } catch (err) {
      // Non-fatal — container may have already exited
      log("arena", `[env:${env.id.slice(0, 8)}] teardown warning: ${String(err)}`);
    }

    const terminatedAt = new Date().toISOString();
    const terminated: Environment = { ...teardown, status: "terminated", updatedAt: terminatedAt, terminatedAt };
    await this._save(terminated);
    log("arena", `[env:${env.id.slice(0, 8)}] terminated`);
    return terminated;
  }

  // ─── get ───────────────────────────────────────────────────────────────────

  async get(environmentId: string): Promise<Environment | null> {
    const indexPath = join(this.runsDir, ".env-index", `${environmentId}.json`);
    try {
      const ref = JSON.parse(await readFile(indexPath, "utf8")) as { runId: string; candidateId: string };
      const envPath = this._envPath(ref.runId, ref.candidateId);
      return JSON.parse(await readFile(envPath, "utf8")) as Environment;
    } catch {
      return null;
    }
  }

  // ─── execution helpers ─────────────────────────────────────────────────────

  getExecFn(env: Environment): ExecFn | undefined {
    if (!env.containerId) return undefined;
    return createDockerExecFn(env.containerId);
  }

  getSpawnServerFn(env: Environment): ServerSpawnFn | undefined {
    if (!env.containerId || env.hostPort === undefined) return undefined;
    return createDockerSpawnServerFn(env.containerId, env.hostPort);
  }

  // ─── persistence ──────────────────────────────────────────────────────────

  private _envPath(runId: string, candidateId: string): string {
    return join(this.runsDir, runId, "candidates", candidateId, "environment.json");
  }

  private async _save(env: Environment): Promise<void> {
    await writeFile(this._envPath(env.runId, env.candidateId), JSON.stringify(env, null, 2), "utf8");

    // Side-index: envId → {runId, candidateId} for get() lookups
    const indexDir = join(this.runsDir, ".env-index");
    await mkdir(indexDir, { recursive: true });
    await writeFile(
      join(indexDir, `${env.id}.json`),
      JSON.stringify({ runId: env.runId, candidateId: env.candidateId }, null, 2),
      "utf8"
    );
  }
}

// ─── Docker CLI wrappers ──────────────────────────────────────────────────────

interface DockerRunOpts {
  image:         string;
  name:          string;
  workspacePath: string;
  hostPort:      number;
  containerPort: number;
  labels:        Record<string, string>;
}

// Docker on Windows requires forward slashes in bind-mount paths.
// Node's path.join() uses backslashes on Windows; convert before passing to CLI.
function toDockerPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function dockerRun(opts: DockerRunOpts): Promise<string> {
  const labelArgs = Object.entries(opts.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);

  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "run", "-d",
      "--name",  opts.name,
      "-v",      `${toDockerPath(opts.workspacePath)}:${CONTAINER_WORKSPACE}`,
      "-p",      `${opts.hostPort}:${opts.containerPort}`,
      ...labelArgs,
      opts.image,
    ]);

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`docker run failed (exit ${code}): ${stderr.trim()}`));
    });
    child.on("error", reject);
  });
}

function dockerStop(containerId: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["stop", "--time", "5", containerId]);
    child.on("close", () => resolve()); // non-fatal regardless of exit code
    child.on("error", () => resolve());
  });
}

function dockerRemove(containerId: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["rm", "-f", containerId]);
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

// ─── ExecFn ───────────────────────────────────────────────────────────────────

export function createDockerExecFn(containerId: string): ExecFn {
  return (command: string, cwd = CONTAINER_WORKSPACE, timeoutMs = 60_000) =>
    new Promise((resolve) => {
      const child = spawn("docker", [
        "exec", "-w", cwd, containerId, "sh", "-c", command,
      ]);

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, timeoutMs);

      child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim(), timedOut });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ exitCode: 1, stdout: "", stderr: err.message, timedOut: false });
      });
    });
}

// ─── ServerSpawnFn ────────────────────────────────────────────────────────────

export function createDockerSpawnServerFn(containerId: string, hostPort: number): ServerSpawnFn {
  return (command: string, _cwd: string) => {
    let startupLog = "";
    let serverPid = "";

    // Start the server as a background process inside the container.
    // The wrapper writes the PID to /tmp/server.pid so we can kill it cleanly.
    const bgCmd = `cd ${CONTAINER_WORKSPACE} && (${command}) > /tmp/server.log 2>&1 & echo $! > /tmp/server.pid && echo $!`;
    const starter = spawn("docker", ["exec", containerId, "sh", "-c", bgCmd]);
    starter.stdout?.on("data", (d: Buffer) => { serverPid += d.toString().trim(); });
    starter.stderr?.on("data", (d: Buffer) => { startupLog += d.toString(); });

    return {
      port: hostPort,
      url:  `http://localhost:${hostPort}/`,

      get startupLog(): string {
        return startupLog;
      },

      kill(): void {
        // Kill by saved PID first, then fall back to pkill node
        const killCmd = serverPid
          ? `kill ${serverPid} 2>/dev/null; pkill -f 'node' 2>/dev/null; true`
          : `pkill -f 'node' 2>/dev/null; true`;
        const k = spawn("docker", ["exec", containerId, "sh", "-c", killCmd]);
        k.on("error", () => {}); // best-effort
      },
    };
  };
}

// ─── Port allocation ──────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function createDockerEnvironmentManager(runsDir: string): DockerEnvironmentManager {
  return new DockerEnvironmentManager(runsDir);
}
