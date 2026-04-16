import {
  mkdir,
  writeFile,
  readFile,
  readdir,
  stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { WorkspaceManager } from "./index.js";
import type { Artifact, RunId, Workspace } from "../types/index.js";

export class FsWorkspaceManager implements WorkspaceManager {
  constructor(private readonly runsDir: string) {}

  async create(runId: RunId): Promise<Workspace> {
    const rootPath = join(this.runsDir, runId, "workspace");
    if (existsSync(rootPath)) {
      throw new Error(`Workspace already exists for run ${runId}: ${rootPath}`);
    }
    await mkdir(rootPath, { recursive: true });
    const workspace: Workspace = {
      runId,
      rootPath,
      createdAt: new Date().toISOString(),
    };
    return workspace;
  }

  async get(runId: RunId): Promise<Workspace> {
    const rootPath = join(this.runsDir, runId, "workspace");
    if (!existsSync(rootPath)) {
      throw new Error(`Workspace not found for run ${runId}: ${rootPath}`);
    }
    return {
      runId,
      rootPath,
      createdAt: new Date().toISOString(), // mtime would be more accurate; fine for V1
    };
  }

  async listArtifacts(workspace: Workspace): Promise<Artifact[]> {
    return walk(workspace.rootPath, workspace.rootPath);
  }

  async writeFile(
    workspace: Workspace,
    relativePath: string,
    content: string
  ): Promise<Artifact> {
    const absPath = join(workspace.rootPath, relativePath);
    await mkdir(join(absPath, ".."), { recursive: true });
    await writeFile(absPath, content, "utf8");
    const bytes = Buffer.byteLength(content, "utf8");
    const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
    return {
      path: relativePath,
      kind: "file",
      sizeBytes: bytes,
      sha256,
    };
  }
}

async function walk(base: string, dir: string): Promise<Artifact[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: Artifact[] = [];

  for (const entry of entries) {
    const absPath = join(dir, entry.name);
    const relPath = relative(base, absPath);

    if (entry.isDirectory()) {
      results.push({ path: relPath, kind: "directory" });
      results.push(...(await walk(base, absPath)));
    } else if (entry.isFile()) {
      const info = await stat(absPath);
      const content = await readFile(absPath);
      const sha256 = createHash("sha256").update(content).digest("hex");
      results.push({
        path: relPath,
        kind: "file",
        sizeBytes: info.size,
        sha256,
      });
    }
  }

  return results;
}

export function createFsWorkspaceManager(runsDir: string): WorkspaceManager {
  return new FsWorkspaceManager(runsDir);
}
