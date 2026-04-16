import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { EventLog } from "./index.js";
import type { RunEvent, RunId, EventKind } from "../types/index.js";

export class FileEventLog implements EventLog {
  constructor(private readonly runsDir: string) {}

  async append<P extends Record<string, unknown>>(
    event: Omit<RunEvent<P>, "id" | "timestamp">
  ): Promise<RunEvent<P>> {
    const full: RunEvent<P> = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      runId: event.runId,
      kind: event.kind,
      payload: event.payload,
    };
    const dir = join(this.runsDir, event.runId);
    await mkdir(dir, { recursive: true });
    await appendFile(
      join(dir, "events.jsonl"),
      JSON.stringify(full) + "\n",
      "utf8"
    );
    return full;
  }

  async readAll(runId: RunId): Promise<RunEvent[]> {
    const path = join(this.runsDir, runId, "events.jsonl");
    if (!existsSync(path)) return [];
    const content = await readFile(path, "utf8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RunEvent);
  }

  async readByKind(runId: RunId, kind: EventKind): Promise<RunEvent[]> {
    const all = await this.readAll(runId);
    return all.filter((e) => e.kind === kind);
  }
}

export function createFileEventLog(runsDir: string): EventLog {
  return new FileEventLog(runsDir);
}
