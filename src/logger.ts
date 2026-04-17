/**
 * Minimal structured logger for pipeline progress.
 * Writes to stderr so stdout stays clean JSON for callers.
 *
 * log()      — [HH:MM:SS] [stage] message          (progress detail)
 * logStage() — ── STAGE ───────────────── detail   (phase boundary)
 * logBanner()— block header / footer               (run start/end)
 */

const BANNER_WIDTH = 62;

export function log(stage: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19); // HH:MM:SS
  process.stderr.write(`[${ts}] [${stage}] ${msg}\n`);
}

/** Prints a visible stage-boundary separator to stderr. */
export function logStage(stage: string, detail?: string): void {
  const label = ` ${stage.toUpperCase()} `;
  const right = detail ? ` ${detail}` : "";
  const dashes = "─".repeat(Math.max(4, BANNER_WIDTH - label.length - right.length));
  process.stderr.write(`\n── ${label}${"─".repeat(dashes.length)}${right}\n`);
}

/** Prints a full-width banner block to stderr. */
export function logBanner(lines: string[]): void {
  const bar = "═".repeat(BANNER_WIDTH);
  process.stderr.write(`\n${bar}\n`);
  for (const line of lines) {
    process.stderr.write(`  ${line}\n`);
  }
  process.stderr.write(`${bar}\n`);
}
