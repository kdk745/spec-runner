/**
 * Submitter interface — sends the completed SubmissionPayload for human review.
 *
 * The submitter is the last stage of the pipeline. It receives a fully
 * assembled payload (winner, ranking, debate transcript, artifact links) and
 * delivers it to a review destination.
 *
 * V1 implementation: StubSubmitter — persists the payload to disk and returns
 * status "dry_run". No external network call is made.
 *
 * Future implementations: email, Slack, Linear, custom webhook — all satisfy
 * the same interface; the pipeline calls submit() and does not care where it goes.
 */

import type { SubmissionPayload, SubmissionResult } from "../types/index.js";

export interface Submitter {
  /**
   * Send the payload for human review.
   * Must resolve (not reject) — encode failures in SubmissionResult.status = "failed".
   */
  submit(payload: SubmissionPayload): Promise<SubmissionResult>;
}

export { buildSubmissionPayload } from "./payload-builder.js";
export { createStubSubmitter } from "./stub-submitter.js";
export { createWebhookSubmitter } from "./webhook-submitter.js";
export type { WebhookSubmitterOptions, PayloadFormatter } from "./webhook-submitter.js";
