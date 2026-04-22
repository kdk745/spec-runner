/**
 * Runtime resolver — determines how to start a candidate workspace.
 *
 * Contract: every candidate runs in exactly one of two modes.
 *
 *   static — index.html at workspace root. Platform serves with
 *            `npx serve . -l tcp://0.0.0.0:3000` (global install in image).
 *            Listens on 0.0.0.0:3000. No npm install required.
 *
 *   node   — package.json with a non-empty `"scripts.start"`. Platform runs
 *            `npm start` after `npm install` and injects HOST=0.0.0.0 PORT=3000.
 *            Start script MUST honour those env vars and bind 0.0.0.0:$PORT.
 *
 * Resolution order (strict — no README scraping, no entry-file guessing):
 *   1. candidate-runtime.json (authoritative if well-formed)
 *   2. auto-node: package.json with scripts.start
 *   3. auto-static: index.html
 *   4. null — nothing runnable
 *
 * All servers bind 0.0.0.0:3000 inside the container. Docker maps 3000 to a
 * random host port; the recorder/self-verifier polls that host port.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecFn } from "../types/index.js";

export const CONTAINER_PORT = 3000;
export const BIND_HOST      = "0.0.0.0";

/**
 * `serve` binds to the TCP address given after `-l`; `tcp://0.0.0.0:3000`
 * forces IPv4 all-interfaces so Docker port-forwarding always reaches it.
 */
export const STATIC_START_CMD = "npx serve . -l tcp://0.0.0.0:3000";

export type RuntimeMode   = "static" | "node";
export type RuntimeSource = "manifest" | "auto-node" | "auto-static";

export interface ResolvedRuntime {
  mode:     RuntimeMode;
  startCmd: string;
  port:     number;
  host:     string;
  source:   RuntimeSource;
}

interface RuntimeManifest {
  mode?:  RuntimeMode;
  start?: string;
}

export async function resolveRuntime(workspaceRoot: string): Promise<ResolvedRuntime | null> {
  // 1. Explicit manifest wins when valid.
  const manifest = await readManifest(workspaceRoot);
  if (manifest) {
    if (manifest.mode === "static") {
      return {
        mode:     "static",
        startCmd: manifest.start?.trim() || STATIC_START_CMD,
        port:     CONTAINER_PORT,
        host:     BIND_HOST,
        source:   "manifest",
      };
    }
    if (manifest.mode === "node" && manifest.start?.trim()) {
      return {
        mode:     "node",
        startCmd: manifest.start.trim(),
        port:     CONTAINER_PORT,
        host:     BIND_HOST,
        source:   "manifest",
      };
    }
    // manifest present but malformed — fall through to auto-detect
  }

  // 2. package.json with a start script → node mode.
  const pkgPath = join(workspaceRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { scripts?: Record<string, string> };
      if (pkg.scripts?.start?.trim()) {
        return {
          mode:     "node",
          startCmd: "npm start",
          port:     CONTAINER_PORT,
          host:     BIND_HOST,
          source:   "auto-node",
        };
      }
    } catch {
      // malformed package.json — ignore, try static
    }
  }

  // 3. Bare index.html → static mode.
  if (existsSync(join(workspaceRoot, "index.html"))) {
    return {
      mode:     "static",
      startCmd: STATIC_START_CMD,
      port:     CONTAINER_PORT,
      host:     BIND_HOST,
      source:   "auto-static",
    };
  }

  return null;
}

export function summarizeRuntime(rt: ResolvedRuntime | null): string {
  if (!rt) return "no runnable entry (no candidate-runtime.json, no package.json start, no index.html)";
  return `mode=${rt.mode} source=${rt.source} → ${rt.startCmd} [bind ${rt.host}:${rt.port}]`;
}

async function readManifest(workspaceRoot: string): Promise<RuntimeManifest | null> {
  const p = join(workspaceRoot, "candidate-runtime.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(await readFile(p, "utf8")) as RuntimeManifest;
  } catch {
    return null;
  }
}

/**
 * Collect diagnostic context when a server fails to become reachable.
 * Runs inside the container via execFn. Returns a single pre-formatted block.
 *
 * All probes run in a single exec so a silent empty result points at execFn
 * itself (the shell prints the headers even when the tools are absent).
 */
export async function captureServerDiagnostics(execFn: ExecFn): Promise<string> {
  const probe = [
    `echo '>>> server.log'`,
    `(ls -la /tmp/server.log 2>&1 || true)`,
    `(cat /tmp/server.log 2>&1 || echo '(no /tmp/server.log)')`,
    `echo '>>> listening sockets'`,
    `(ss -tln 2>&1 || netstat -tln 2>&1 || echo '(no ss/netstat in image)')`,
    `echo '>>> processes'`,
    `(ps -ef 2>&1 | head -30 || echo '(no ps)')`,
    `echo '>>> in-container curl http://localhost:3000/'`,
    `(curl -sS -v --max-time 3 http://localhost:3000/ 2>&1 | head -30 || echo '(curl failed)')`,
  ].join(" ; ");

  const r = await execFn(probe, "/", 15_000);
  const header = `exit=${r.exitCode} timedOut=${r.timedOut} stdout_len=${r.stdout.length} stderr_len=${r.stderr.length}`;
  return [
    header,
    "── stdout ──",
    r.stdout.trim() || "(empty)",
    r.stderr.trim() ? "── stderr ──\n" + r.stderr.trim() : "",
  ].filter(Boolean).join("\n");
}
