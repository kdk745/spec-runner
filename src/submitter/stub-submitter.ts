/**
 * StubSubmitter — dry-run submitter for local development and testing.
 *
 * Persists the payload to runs/<runId>/submission.json and returns
 * status "dry_run". No external network call is made.
 *
 * Replace with a real submitter (email, Slack, webhook) by implementing
 * the Submitter interface and registering it in cli.ts.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { SubmissionPayload, SubmissionResult } from "../types/index.js";
import type { Submitter } from "./index.js";
import { log } from "../logger.js";

export class StubSubmitter implements Submitter {
  private readonly runsDir: string;

  constructor(runsDir: string) {
    this.runsDir = runsDir;
  }

  async submit(payload: SubmissionPayload): Promise<SubmissionResult> {
    const submissionId = randomUUID();
    const payloadPath  = join(this.runsDir, payload.runId, "submission.json");

    log("submit", `Persisting payload to ${payloadPath}`);

    try {
      await mkdir(dirname(payloadPath), { recursive: true });
      await writeFile(payloadPath, JSON.stringify(payload, null, 2), "utf8");
      log("submit", `Payload written — ${payload.ranking.length} candidate(s), winner: ${payload.winner.label}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("submit", `Failed to write payload — ${msg}`);
      return {
        submissionId,
        status: "failed",
        destination: payloadPath,
        payloadPath,
        submittedAt: new Date().toISOString(),
      };
    }

    return {
      submissionId,
      status: "dry_run",
      destination: payloadPath,
      payloadPath,
      submittedAt: new Date().toISOString(),
    };
  }
}

export function createStubSubmitter(runsDir: string): Submitter {
  return new StubSubmitter(runsDir);
}
