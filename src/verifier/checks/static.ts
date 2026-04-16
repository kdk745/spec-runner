/**
 * Static checks — file/directory existence and light syntax probing.
 *
 * Strategy:
 * 1. Extract all path-like tokens from the criterion description.
 * 2. For each path found, assert it exists inside workspace.rootPath.
 * 3. Cross-reference build-manifest.json (if present) to confirm the worker
 *    declared the file — a mismatch is surfaced as a warning in the reason.
 * 4. If no path tokens are found, assert the workspace is non-empty.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CheckResult, SuccessCriterion, Workspace } from "../../types/index.js";

// Matches relative file paths like src/index.ts, package.json, dist/app.js
const PATH_RE = /\b([\w][\w\-.]*(?:\/[\w\-.]+)*\.[\w]{1,8})\b/g;

// Only accept matches whose extension looks like a real file type
const FILE_EXTENSIONS = new Set([
  "ts","tsx","js","jsx","mjs","cjs","json","yaml","yml","toml","env",
  "md","html","css","scss","txt","sh","lock","config","d","map",
]);

interface BuildManifest {
  filesWritten?: string[];
}

export async function runStaticCheck(
  criterion: SuccessCriterion,
  workspace: Workspace
): Promise<CheckResult> {
  const started = Date.now();

  const paths = extractPaths(criterion.description);
  const manifest = await loadManifest(workspace.rootPath);

  if (paths.length === 0) {
    // No specific paths mentioned — verify workspace is non-empty
    const hasFiles = existsSync(workspace.rootPath) &&
      (await countFiles(workspace.rootPath)) > 0;

    return result(criterion, hasFiles, hasFiles
      ? "Workspace contains files (no specific path specified in criterion)."
      : "Workspace is empty — worker produced no files.",
      started);
  }

  const missing: string[] = [];
  const found: string[] = [];

  for (const p of paths) {
    const abs = join(workspace.rootPath, p);
    if (existsSync(abs)) {
      found.push(p);
    } else {
      missing.push(p);
    }
  }

  const passed = missing.length === 0;

  let reason: string;
  if (passed) {
    reason = `Found: ${found.join(", ")}.`;
    // Cross-check manifest — warn if worker didn't declare the file
    if (manifest?.filesWritten) {
      const undeclared = found.filter(
        (f) => !manifest.filesWritten!.some((w) => w === f || w.endsWith("/" + f))
      );
      if (undeclared.length > 0) {
        reason += ` Note: ${undeclared.join(", ")} not listed in build-manifest.json.`;
      }
    }
  } else {
    reason = missing.length > 0
      ? `Missing file(s): ${missing.join(", ")}.`
      : "No files found.";
    if (found.length > 0) reason += ` Present: ${found.join(", ")}.`;
  }

  return result(criterion, passed, reason, started);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractPaths(description: string): string[] {
  const seen = new Set<string>();
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  PATH_RE.lastIndex = 0;
  while ((m = PATH_RE.exec(description)) !== null) {
    const p = m[1]!;
    const ext = p.split(".").pop()?.toLowerCase() ?? "";
    if (!FILE_EXTENSIONS.has(ext)) continue; // skip dotted identifiers like router.get
    if (!seen.has(p)) { seen.add(p); matches.push(p); }
  }
  return matches;
}

async function loadManifest(workspaceRoot: string): Promise<BuildManifest | null> {
  try {
    const raw = await readFile(join(workspaceRoot, "build-manifest.json"), "utf8");
    return JSON.parse(raw) as BuildManifest;
  } catch {
    return null;
  }
}

async function countFiles(dir: string): Promise<number> {
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(dir, { recursive: true });
    return entries.length;
  } catch {
    return 0;
  }
}

function result(
  criterion: SuccessCriterion,
  passed: boolean,
  reason: string,
  startedMs: number
): CheckResult {
  return {
    criterionId: criterion.id,
    name: criterion.description,
    passed,
    skipped: false,
    reason,
    durationMs: Date.now() - startedMs,
  };
}
