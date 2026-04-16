import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CandidateManager } from "./index.js";
import type { Candidate, RunId } from "../types/index.js";

export class FsCandidateManager implements CandidateManager {
  constructor(private readonly runsDir: string) {}

  async create(runId: RunId, adapterName: string): Promise<Candidate> {
    const candidateId = randomUUID();
    const candidateDir = this._candidateDir(runId, candidateId);
    const workspacePath = join(candidateDir, "workspace");

    if (existsSync(candidateDir)) {
      throw new Error(`Candidate directory already exists: ${candidateDir}`);
    }

    await mkdir(workspacePath, { recursive: true }); // creates both parent dirs

    const now = new Date().toISOString();
    const candidate: Candidate = {
      id: candidateId,
      runId,
      workspacePath,
      adapterName,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    await this._write(runId, candidateId, candidate);
    return candidate;
  }

  async get(runId: RunId, candidateId: string): Promise<Candidate> {
    const path = join(this._candidateDir(runId, candidateId), "candidate.json");
    if (!existsSync(path)) {
      throw new Error(`Candidate not found: ${runId}/${candidateId}`);
    }
    return JSON.parse(await readFile(path, "utf8")) as Candidate;
  }

  async save(candidate: Candidate): Promise<void> {
    const updated: Candidate = {
      ...candidate,
      updatedAt: new Date().toISOString(),
    };
    await this._write(candidate.runId, candidate.id, updated);
  }

  async listForRun(runId: RunId): Promise<Candidate[]> {
    const candidatesDir = join(this.runsDir, runId, "candidates");
    if (!existsSync(candidatesDir)) return [];

    const entries = await readdir(candidatesDir, { withFileTypes: true });
    const candidates: Candidate[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const c = await this.get(runId, entry.name);
        candidates.push(c);
      } catch {
        // skip corrupted entries
      }
    }

    return candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  private _candidateDir(runId: RunId, candidateId: string): string {
    return join(this.runsDir, runId, "candidates", candidateId);
  }

  private async _write(
    runId: RunId,
    candidateId: string,
    candidate: Candidate
  ): Promise<void> {
    const path = join(
      this._candidateDir(runId, candidateId),
      "candidate.json"
    );
    await writeFile(path, JSON.stringify(candidate, null, 2), "utf8");
  }
}

export function createFsCandidateManager(runsDir: string): CandidateManager {
  return new FsCandidateManager(runsDir);
}
