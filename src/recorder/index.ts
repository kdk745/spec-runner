/**
 * Recorder interface.
 *
 * Runs a deterministic, script-driven demo flow inside the workspace and
 * captures a video. The demo script is derived from the spec — the recorder
 * never invents steps.
 *
 * V1 video capture: use `asciinema` or `terminalizer` for a low-dependency
 * terminal recording. Falls back gracefully if no recorder binary is found
 * (videoPath will be undefined; demoLog is always populated).
 */

import type { RunSpec, Workspace, RecordingResult, DemoStep, ExecFn, ServerSpawnFn } from "../types/index.js";

export type { ExecFn, ServerSpawnFn };

/**
 * Options that route stage work through an isolated environment.
 * All fields are optional — when absent the recorder falls back to host-local execution.
 */
export interface RecordOptions {
  /** Run prep commands (npm install, tsc) inside the environment. */
  execFn?: ExecFn;
  /** Spawn the app server inside the environment instead of locally. */
  spawnServerFn?: ServerSpawnFn;
  /**
   * Host-side port that the container exposes (for Docker environments).
   * When set, used as the preferred port when polling for server readiness.
   */
  overridePort?: number;
}

/**
 * A demo script is an ordered list of deterministic steps derived from the spec.
 * Scripts are pure data — they contain no callbacks, no branching.
 */
export interface DemoScript {
  /** Guessed base URL (http://localhost:PORT/) for browser steps */
  baseUrl: string;
  steps: DemoScriptStep[];
}

export type DemoStepKind =
  | "shell"              // run a shell command in workspace root
  | "browser-navigate"   // navigate to command (URL)
  | "browser-screenshot" // take a screenshot, command is the filename
  | "browser-api-call";  // fetch via page.evaluate() + inject overlay + screenshot

export interface DemoScriptStep {
  kind: DemoStepKind;
  description: string;
  /**
   * shell:              shell command string
   * browser-navigate:   full URL
   * browser-screenshot: output filename (relative to recording dir)
   * browser-api-call:   "METHOD /path" e.g. "POST /todos"
   */
  command: string;
  /** If true, failure aborts the rest of the recording */
  required: boolean;
  timeoutMs: number;
  /** browser-api-call only: JSON body string for POST/PUT/PATCH */
  body?: string;
  /** browser-api-call only: output screenshot filename */
  screenshotFile?: string;
}

export interface Recorder {
  /**
   * Derive a deterministic demo script from the locked spec.
   * Same spec must always produce the same script.
   */
  buildScript(spec: RunSpec): DemoScript;

  /**
   * Execute the script inside the workspace, record output, and capture video.
   * Must resolve (not reject) — encode failures inside RecordingResult.
   *
   * opts.execFn:         route prep commands through isolated environment
   * opts.spawnServerFn:  start the app server inside the environment
   * opts.overridePort:   host-side port to poll when waiting for server readiness
   */
  record(
    spec: RunSpec,
    workspace: Workspace,
    script: DemoScript,
    opts?: RecordOptions
  ): Promise<RecordingResult>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export { createRecorder } from "./default-recorder.js";
