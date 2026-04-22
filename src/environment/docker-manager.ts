/**
 * DockerEnvironmentManager — V1 Docker-backed isolated compute environment.
 *
 * One container per candidate. Each container:
 *   - Image : spec-runner-env:latest (Node 22, Playwright, TypeScript, claude CLI)
 *   - Mount : candidate workspace → /workspace (read-write)
 *   - Mount : ~/.claude → /root/.claude (read-only, agent auth)
 *   - Port  : random host port → container:3000 (server traffic)
 *   - Labels: full traceability metadata (runId, candidateId, envId)
 *   - Mode  : sleeps until work arrives via `docker exec`
 *
 * Lifecycle (explicit, logged at every transition):
 *   provision()  → status: provisioning → ready
 *   activate()   → status: running
 *   release()    → status: teardown_requested → terminated
 *   inspect()    → live docker inspect (no state mutation)
 *   listForRun() → all environments persisted for a run
 *
 * Persistence:
 *   runs/<runId>/candidates/<candidateId>/environment.json
 *   runs/.env-index/<envId>.json  (lookup index for get())
 *
 * Build the image once: bash docker/build.sh
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile, readFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import type { EnvironmentManager, ExecFn, ServerSpawnFn } from "./index.js";
import type { RunId, Environment, EnvironmentConfig } from "../types/index.js";
import { log } from "../logger.js";

const CONTAINER_IMAGE     = "spec-runner-env:latest";
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_PORT      = 3000;

// ─── Structured lifecycle logging ─────────────────────────────────────────────

function envLog(envId: string, stage: string, msg: string): void {
  log("env", `[${envId.slice(0, 8)}] [${stage.toUpperCase().padEnd(10)}] ${msg}`);
}

// ─── Live container inspection result ────────────────────────────────────────

export interface EnvironmentInspectResult {
  environmentId: string;
  runId:         string;
  candidateId:   string;
  status:        string;
  containerName: string;
  containerId?:  string;
  running:       boolean;
  containerStatus: string;   // docker state: running / exited / created / etc.
  hostPort?:     number;
  workspacePath: string;
  labels:        Record<string, string>;
  uptimeSec?:    number;
  createdAt:     string;
  inspectedAt:   string;
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class DockerEnvironmentManager implements EnvironmentManager {
  constructor(private readonly runsDir: string) {}

  // ─── provision ─────────────────────────────────────────────────────────────
  // Creates a workspace directory, allocates a host port, and starts a container
  // that sleeps until work arrives via docker exec.

  async provision(runId: RunId, candidateId: string, config: EnvironmentConfig): Promise<Environment> {
    const envId = randomUUID();
    const now   = new Date().toISOString();

    envLog(envId, "provision", `run=${runId.slice(0, 8)} candidate=${candidateId.slice(0, 8)} image=${CONTAINER_IMAGE}`);

    const workspacePath = join(this.runsDir, runId, "candidates", candidateId, "workspace");
    await mkdir(workspacePath, { recursive: true });

    let env: Environment = {
      id:           envId,
      runId,
      candidateId,
      config:       { ...config, isolationType: "docker" },
      status:       "provisioning",
      workspacePath,
      createdAt:    now,
      updatedAt:    now,
    };
    await this._save(env);

    // ── Port allocation ────────────────────────────────────────────────────
    let hostPort: number;
    try {
      hostPort = await findFreePort();
    } catch (err) {
      envLog(envId, "provision", `FAILED port allocation: ${String(err)}`);
      env = { ...env, status: "terminated", updatedAt: new Date().toISOString() };
      await this._save(env);
      return env;
    }

    const containerName = `spec-runner-${envId.slice(0, 8)}`;
    envLog(envId, "provision", `container=${containerName} port=${hostPort} workspace=${workspacePath}`);

    // ── Container start ────────────────────────────────────────────────────
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
      await this._save(env);
      envLog(envId, "ready", `container=${containerId.slice(0, 12)} port=${hostPort}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      envLog(envId, "provision", `FAILED container start: ${msg}`);
      env = { ...env, status: "terminated", updatedAt: new Date().toISOString() };
      await this._save(env);
    }

    return env;
  }

  // ─── activate ──────────────────────────────────────────────────────────────
  // Called immediately before a stage begins executing inside the environment.

  async activate(env: Environment): Promise<Environment> {
    envLog(env.id, "activate", `candidate=${env.candidateId.slice(0, 8)} container=${env.containerId?.slice(0, 12) ?? "none"}`);
    const updated: Environment = { ...env, status: "running", updatedAt: new Date().toISOString() };
    await this._save(updated);
    return updated;
  }

  // ─── release ───────────────────────────────────────────────────────────────
  // Stops and removes the container. Always resolves — errors are non-fatal.

  async release(env: Environment): Promise<Environment> {
    const teardownStart = Date.now();

    if (!env.containerId) {
      envLog(env.id, "release", `no container to teardown (status was ${env.status})`);
      const terminated = { ...env, status: "terminated" as const, updatedAt: new Date().toISOString() };
      await this._save(terminated);
      return terminated;
    }

    envLog(env.id, "teardown", `candidate=${env.candidateId.slice(0, 8)} container=${env.containerId.slice(0, 12)}`);
    const teardown: Environment = { ...env, status: "teardown_requested", updatedAt: new Date().toISOString() };
    await this._save(teardown);

    try {
      // Single atomic force-remove: kill + remove in one call. Separate stop+rm
      // can race when --init isn't present and leave orphan shims. With --init,
      // rm -f cleanly tears down the whole process tree.
      await dockerRemove(env.containerId);
      envLog(env.id, "teardown", `container=${env.containerId.slice(0, 12)} → removed`);
    } catch (err) {
      envLog(env.id, "teardown", `warning (non-fatal): ${String(err)}`);
    }

    const terminatedAt = new Date().toISOString();
    const terminated: Environment = { ...teardown, status: "terminated", updatedAt: terminatedAt, terminatedAt };
    await this._save(terminated);
    envLog(env.id, "terminated", `elapsed=${Date.now() - teardownStart}ms candidate=${env.candidateId.slice(0, 8)}`);
    return terminated;
  }

  // ─── get ───────────────────────────────────────────────────────────────────

  async get(environmentId: string): Promise<Environment | null> {
    const indexPath = join(this.runsDir, ".env-index", `${environmentId}.json`);
    try {
      const ref = JSON.parse(await readFile(indexPath, "utf8")) as { runId: string; candidateId: string };
      return JSON.parse(await readFile(this._envPath(ref.runId, ref.candidateId), "utf8")) as Environment;
    } catch {
      return null;
    }
  }

  // ─── inspect ───────────────────────────────────────────────────────────────
  // Live docker inspect — does not mutate state. Used by the `env` CLI command.

  async inspect(env: Environment): Promise<EnvironmentInspectResult> {
    const containerName = `spec-runner-${env.id.slice(0, 8)}`;
    let running = false;
    let containerStatus = "unknown";
    let uptimeSec: number | undefined;

    if (env.containerId) {
      const info = await dockerInspectContainer(env.containerId);
      if (info) {
        running = info.running;
        containerStatus = info.state;
        if (info.running && info.startedAt) {
          uptimeSec = Math.max(0, Math.floor((Date.now() - new Date(info.startedAt).getTime()) / 1000));
        }
      } else {
        containerStatus = "not found";
      }
    } else {
      containerStatus = "not created";
    }

    return {
      environmentId:   env.id,
      runId:           env.runId,
      candidateId:     env.candidateId,
      status:          env.status,
      containerName,
      ...(env.containerId !== undefined ? { containerId: env.containerId } : {}),
      running,
      containerStatus,
      ...(env.hostPort !== undefined ? { hostPort: env.hostPort } : {}),
      workspacePath:   env.workspacePath,
      labels: {
        "spec-runner.run-id":       env.runId,
        "spec-runner.candidate-id": env.candidateId,
        "spec-runner.env-id":       env.id,
      },
      ...(uptimeSec !== undefined ? { uptimeSec } : {}),
      createdAt:    env.createdAt,
      inspectedAt:  new Date().toISOString(),
    };
  }

  // ─── listForRun ────────────────────────────────────────────────────────────
  // Returns all persisted environments for a given run (reads from disk).

  async listForRun(runId: string): Promise<Environment[]> {
    const candidatesDir = join(this.runsDir, runId, "candidates");
    let dirs: string[];
    try {
      dirs = await readdir(candidatesDir);
    } catch {
      return [];
    }

    const envs: Environment[] = [];
    for (const candidateId of dirs) {
      try {
        const raw = await readFile(this._envPath(runId, candidateId), "utf8");
        envs.push(JSON.parse(raw) as Environment);
      } catch {
        // no environment.json for this candidate (local-process mode, or not yet provisioned)
      }
    }
    return envs;
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

// Docker on Windows requires forward slashes in bind-mount paths.
function toDockerPath(p: string): string {
  return p.replace(/\\/g, "/");
}

interface DockerRunOpts {
  image:         string;
  name:          string;
  workspacePath: string;
  hostPort:      number;
  containerPort: number;
  labels:        Record<string, string>;
}

function dockerRun(opts: DockerRunOpts): Promise<string> {
  const labelArgs = Object.entries(opts.labels).flatMap(([k, v]) => ["--label", `${k}=${v}`]);
  const claudeHome = toDockerPath(join(homedir(), ".claude"));

  const claudeJson = join(homedir(), ".claude.json");

  return new Promise((resolve, reject) => {
    const child = spawn("docker", [
      "run", "-d",
      // --init runs tini as PID 1 so backgrounded servers (npx serve, node, etc.)
      // are reaped cleanly on docker stop. Without this, containerd-shim hangs
      // waiting for orphaned children and leaves zombie shims after removal.
      "--init",
      "--name",  opts.name,
      "-v",      `${toDockerPath(opts.workspacePath)}:${CONTAINER_WORKSPACE}`,
      "-v",      `${claudeHome}:/root/.claude:ro`,
      ...(existsSync(claudeJson) ? ["-v", `${toDockerPath(claudeJson)}:/root/.claude.json:ro`] : []),
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
    child.on("close", () => resolve());
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

function dockerInspectContainer(
  containerId: string
): Promise<{ running: boolean; state: string; startedAt?: string } | null> {
  return new Promise((resolve) => {
    const child = spawn("docker", [
      "inspect",
      "--format", "{{.State.Status}} {{.State.Running}} {{.State.StartedAt}}",
      containerId,
    ]);
    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.on("close", (code) => {
      if (code !== 0) { resolve(null); return; }
      const parts = stdout.trim().split(" ");
      const startedAt = parts[2] && parts[2] !== "0001-01-01T00:00:00Z" ? parts[2] : undefined;
      resolve({
        state:   parts[0] ?? "unknown",
        running: parts[1] === "true",
        ...(startedAt !== undefined ? { startedAt } : {}),
      });
    });
    child.on("error", () => resolve(null));
  });
}

// ─── ExecFn — routes commands into the container via docker exec ──────────────

export function createDockerExecFn(containerId: string): ExecFn {
  return (command: string, cwd, timeoutMs = 60_000, stdin?: string) =>
    new Promise((resolve) => {
      // Normalise cwd: treat undefined / empty string / relative as the container
      // workspace. `docker exec -w ""` errors with "Cwd must be an absolute path".
      const resolvedCwd = cwd && cwd.startsWith("/") ? cwd : CONTAINER_WORKSPACE;
      // -i keeps stdin open so we can pipe content directly into the container,
      // eliminating any need to write files to the bind-mounted workspace from the host.
      const args = ["exec", "-i", "-w", resolvedCwd, containerId, "sh", "-c", command];
      const child = spawn("docker", args);

      if (stdin !== undefined) {
        child.stdin?.write(stdin, "utf8");
        child.stdin?.end();
      }

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

// ─── ServerSpawnFn — starts a long-running server inside the container ────────

export function createDockerSpawnServerFn(containerId: string, hostPort: number): ServerSpawnFn {
  return (command: string, _cwd: string) => {
    let startupLog = "";
    let serverPid  = "";

    // Inject HOST=0.0.0.0 PORT=3000 so node apps that honour env vars bind
    // to all interfaces inside the container. Docker forwards hostPort → 3000.
    const bgCmd =
      `cd ${CONTAINER_WORKSPACE} && ` +
      `HOST=0.0.0.0 PORT=3000 ${command} > /tmp/server.log 2>&1 & ` +
      `echo $! > /tmp/server.pid && echo $!`;
    const starter = spawn("docker", ["exec", containerId, "sh", "-c", bgCmd]);
    starter.stdout?.on("data", (d: Buffer) => { serverPid += d.toString().trim(); });
    starter.stderr?.on("data", (d: Buffer) => { startupLog += d.toString(); });

    return {
      port: hostPort,
      url:  `http://localhost:${hostPort}/`,
      get startupLog(): string { return startupLog; },
      kill(): void {
        const killCmd = serverPid
          ? `kill ${serverPid} 2>/dev/null; pkill -f 'node' 2>/dev/null; true`
          : `pkill -f 'node' 2>/dev/null; true`;
        const k = spawn("docker", ["exec", containerId, "sh", "-c", killCmd]);
        k.on("error", () => {});
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

/**
 * Remove any spec-runner containers lingering from prior runs. Called at
 * pipeline start to guarantee we never inherit half-dead state. Matches on
 * the `spec-runner=1` label applied by dockerRun(). Non-fatal on error.
 */
export function sweepOrphanContainers(): Promise<number> {
  return new Promise((resolve) => {
    const list = spawn("docker", ["ps", "-a", "-q", "--filter", "label=spec-runner=1"]);
    let ids = "";
    list.stdout?.on("data", (d: Buffer) => { ids += d.toString(); });
    list.on("error", () => resolve(0));
    list.on("close", () => {
      const containerIds = ids.split(/\s+/).filter(Boolean);
      if (containerIds.length === 0) { resolve(0); return; }
      const rm = spawn("docker", ["rm", "-f", ...containerIds]);
      rm.on("error",  () => resolve(containerIds.length));
      rm.on("close",  () => resolve(containerIds.length));
    });
  });
}
