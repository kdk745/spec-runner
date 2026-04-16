/**
 * Minimal structured logger for pipeline progress.
 * Writes to stderr so stdout stays clean JSON for callers.
 *
 * Format: [HH:MM:SS] [stage] message
 */

export function log(stage: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  process.stderr.write(`[${ts}] [${stage}] ${msg}\n`);
}
