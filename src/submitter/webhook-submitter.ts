/**
 * WebhookSubmitter — POSTs the SubmissionPayload to a configurable HTTP endpoint.
 *
 * Always persists the payload to disk first (same as StubSubmitter), then fires
 * the HTTP request. If the request fails or returns a non-2xx status, the
 * SubmissionResult reflects the failure but the local file is always written.
 *
 * Extensibility hook: pass a `formatter` function to transform the payload
 * before sending. The default sends the raw SubmissionPayload as JSON.
 * A Slack or Discord formatter can return a different shape without touching
 * this class (see createSlackFormatter / createDiscordFormatter stubs below).
 *
 * URL masking: query-string parameters are redacted from logs to avoid leaking
 * tokens that services like Slack embed in webhook URLs.
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { SubmissionPayload, SubmissionResult } from "../types/index.js";
import type { Submitter } from "./index.js";
import { log } from "../logger.js";

// ─── Options ──────────────────────────────────────────────────────────────────

/**
 * Transforms a SubmissionPayload into the body that will be POSTed.
 * Return value is JSON-serialised before sending.
 *
 * Default: identity (sends the payload as-is).
 * Override for Slack (`{ text, blocks }`) or Discord (`{ content, embeds }`).
 */
export type PayloadFormatter = (payload: SubmissionPayload) => unknown;

export interface WebhookSubmitterOptions {
  /** Full URL to POST to. Query-string tokens are masked in logs. */
  url: string;
  /** Request timeout in ms. Default: 10 000. */
  timeoutMs?: number;
  /** Extra request headers (e.g. `Authorization: Bearer …`). */
  headers?: Record<string, string>;
  /** Transform the payload before sending. Default: identity. */
  formatter?: PayloadFormatter;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class WebhookSubmitter implements Submitter {
  private readonly runsDir: string;
  private readonly opts: Required<Omit<WebhookSubmitterOptions, "headers">> & { headers: Record<string, string> };

  constructor(runsDir: string, options: WebhookSubmitterOptions) {
    this.runsDir = runsDir;
    this.opts = {
      url:       options.url,
      timeoutMs: options.timeoutMs ?? 10_000,
      headers:   options.headers   ?? {},
      formatter: options.formatter ?? ((p) => p),
    };
  }

  async submit(payload: SubmissionPayload): Promise<SubmissionResult> {
    const submissionId = randomUUID();
    const payloadPath  = join(this.runsDir, payload.runId, "submission.json");
    const maskedUrl    = maskQueryString(this.opts.url);

    // ── Always persist to disk first ──────────────────────────────────────────
    try {
      await mkdir(dirname(payloadPath), { recursive: true });
      await writeFile(payloadPath, JSON.stringify(payload, null, 2), "utf8");
      log("submit", `Payload written to ${payloadPath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("submit", `Failed to write payload — ${msg}`);
      return failure(submissionId, payloadPath, `disk write failed: ${msg}`);
    }

    // ── HTTP POST ─────────────────────────────────────────────────────────────
    const body   = JSON.stringify(this.opts.formatter(payload));
    const signal = AbortSignal.timeout(this.opts.timeoutMs);

    log("submit", `POST ${maskedUrl} (${body.length} bytes, timeout ${this.opts.timeoutMs}ms)`);

    let response: Response;
    try {
      response = await fetch(this.opts.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "spec-runner/1.0",
          ...this.opts.headers,
        },
        body,
        signal,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log("submit", `POST ${maskedUrl} — network error: ${msg}`);
      return failure(submissionId, payloadPath, `network error: ${msg}`);
    }

    // ── Log response ──────────────────────────────────────────────────────────
    let responseExcerpt = "";
    try {
      const text = await response.text();
      responseExcerpt = text.slice(0, 200).replace(/\n/g, " ");
    } catch {
      responseExcerpt = "(could not read response body)";
    }

    const ok = response.status >= 200 && response.status < 300;
    log("submit", `POST ${maskedUrl} → ${response.status} ${response.statusText}${responseExcerpt ? ` — ${responseExcerpt}` : ""}`);

    if (!ok) {
      return {
        submissionId,
        status: "failed",
        destination: this.opts.url,
        payloadPath,
        submittedAt: new Date().toISOString(),
      };
    }

    return {
      submissionId,
      status: "submitted",
      destination: this.opts.url,
      payloadPath,
      submittedAt: new Date().toISOString(),
    };
  }
}

// ─── Formatter stubs ──────────────────────────────────────────────────────────

/**
 * Stub for a future Slack Block Kit formatter.
 * Replace the body with real Block Kit JSON when wiring Slack.
 *
 * Usage: createWebhookSubmitter(runsDir, { url, formatter: createSlackFormatter() })
 */
export function createSlackFormatter(): PayloadFormatter {
  return (payload) => ({
    text: `*Spec evaluation complete* — winner: ${payload.winner.label}\n${payload.winner.summary}`,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Goal:* ${payload.specGoal}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Winner:* ${payload.winner.label} — ${payload.winner.summary}` },
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Rationale:* ${payload.debate.finalRationale}` },
      },
    ],
    // Full payload attached for programmatic consumers
    _payload: payload,
  });
}

/**
 * Stub for a future Discord Embed formatter.
 *
 * Usage: createWebhookSubmitter(runsDir, { url, formatter: createDiscordFormatter() })
 */
export function createDiscordFormatter(): PayloadFormatter {
  return (payload) => ({
    content: `**Spec evaluation complete** — winner: ${payload.winner.label}`,
    embeds: [
      {
        title: payload.specGoal.slice(0, 256),
        description: payload.debate.finalRationale.slice(0, 4096),
        fields: payload.ranking.map((c) => ({
          name: `${c.label} (rank ${c.position})`,
          value: c.summary.slice(0, 1024),
          inline: false,
        })),
      },
    ],
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function failure(submissionId: string, payloadPath: string, reason: string): SubmissionResult {
  log("submit", `Submission failed — ${reason}`);
  return {
    submissionId,
    status: "failed",
    destination: payloadPath,
    payloadPath,
    submittedAt: new Date().toISOString(),
  };
}

/** Redact query-string from a URL so webhook tokens don't appear in logs. */
function maskQueryString(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : `${url.slice(0, q)}?[redacted]`;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createWebhookSubmitter(
  runsDir: string,
  options: WebhookSubmitterOptions,
): Submitter {
  return new WebhookSubmitter(runsDir, options);
}
