/**
 * Video ingestion — V1: screenshot frame index strategy.
 *
 * The recorder captures one screenshot per API step (with overlay). This module
 * indexes those screenshots into a VideoFrameIndex and provides loadFrames() to
 * read + base64-encode them for multimodal LLM input.
 *
 * Why not ffmpeg frame extraction?
 *   Requires an external binary dependency. The screenshots are already semantically
 *   labelled (we know exactly which endpoint produced each frame), so extracting
 *   raw video frames would give us less information, not more.
 *
 * Why not vision-model preprocessing at record time?
 *   Running a vision model for every frame on every candidate adds latency and cost
 *   before we know if the video is worth evaluating. Defer to the debate stage.
 *
 * Evaluator usage:
 *
 *   import { loadFrames } from "../recorder/video-ingest.js";
 *
 *   const index = JSON.parse(await readFile(recording.frameIndexPath, "utf8"));
 *   const frames = await loadFrames(index, { keyFramesOnly: true, maxFrames: 5 });
 *
 *   // Directly consumable as Claude image blocks:
 *   const imageBlocks = frames.map(f => ({
 *     type: "image" as const,
 *     source: { type: "base64" as const, media_type: f.mediaType, data: f.base64 },
 *   }));
 */

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import type {
  RunId,
  ApiTraceStep,
  VideoFrame,
  VideoFrameIndex,
  LoadedVideoFrame,
} from "../types/index.js";

// ─── Index building (called by recorder after each recording session) ─────────

/**
 * Build a VideoFrameIndex from the ApiTraceStep array produced by a recording.
 * Only steps that have a screenshot are included.
 *
 * For frontend apps (no API trace steps), pass fallbackScreenshotPaths to
 * index the browser-navigate / browser-type screenshots instead.
 */
export function buildFrameIndex(
  runId: RunId,
  traceSteps: ApiTraceStep[],
  videoPath: string | undefined,
  fallbackScreenshotPaths?: string[]
): VideoFrameIndex {
  const stepsWithScreenshots = traceSteps.filter(
    (s): s is ApiTraceStep & { screenshotPath: string } =>
      s.screenshotPath !== undefined && existsSync(s.screenshotPath)
  );

  let frames: VideoFrame[];

  if (stepsWithScreenshots.length > 0) {
    // API recording path: index from trace steps
    frames = stepsWithScreenshots.map((step) => ({
      stepIndex: step.index,
      description: step.description,
      endpoint: `${step.method} ${step.path}`,
      ...(step.httpStatus !== undefined ? { httpStatus: step.httpStatus } : {}),
      passed: step.passed,
      screenshotPath: step.screenshotPath,
      isKeyFrame: classifyKeyFrame(step, traceSteps),
    }));
  } else if (fallbackScreenshotPaths && fallbackScreenshotPaths.length > 0) {
    // Frontend recording path: index from browser screenshots directly
    const existing = fallbackScreenshotPaths.filter((p) => existsSync(p));
    frames = existing.map((p, i) => ({
      stepIndex: i + 1,
      description: p.split(/[\\/]/).pop()?.replace(/\.png$/, "").replace(/-/g, " ") ?? `frame ${i + 1}`,
      endpoint: "screenshot",
      passed: true,
      screenshotPath: p,
      isKeyFrame: true, // all frontend screenshots are key frames
    }));
  } else {
    frames = [];
  }

  const keyFrameCount = frames.filter((f) => f.isKeyFrame).length;

  return {
    runId,
    ...(videoPath ? { videoPath } : {}),
    frames,
    keyFrameCount,
    createdAt: new Date().toISOString(),
  };
}

/**
 * A frame is a key frame when it captures a state transition that is informative
 * for evaluation:
 *
 *   - First step: baseline state before any mutations
 *   - POST step: resource was just created — body shows the created ID
 *   - GET step immediately after PUT: verifies update persisted
 *   - GET step immediately after DELETE: verifies deletion
 *   - Any failed step: shows what went wrong
 *   - Last step: final state of the resource list
 */
function classifyKeyFrame(step: ApiTraceStep, all: ApiTraceStep[]): boolean {
  if (!step.passed)                  return true;   // failure always key
  if (step.index === 1)              return true;   // baseline
  if (step.index === all.length)     return true;   // final state
  if (step.method === "POST")        return true;   // create

  const prev = all.find((s) => s.index === step.index - 1);
  if (prev && step.method === "GET") {
    if (prev.method === "PUT"    || prev.method === "PATCH")  return true; // verify update
    if (prev.method === "DELETE")                              return true; // verify deletion
  }

  return false;
}

// ─── Frame loading (called by evaluators at debate time) ─────────────────────

export interface LoadFramesOptions {
  /** When true, only frames with isKeyFrame === true are returned. Default: true */
  keyFramesOnly?: boolean;
  /** Cap the number of frames returned (applied after key-frame filtering). Default: 8 */
  maxFrames?: number;
}

/**
 * Read and base64-encode the frames described by a VideoFrameIndex.
 * Missing screenshot files are silently skipped — a partial result is still useful.
 *
 * Returns frames sorted by stepIndex ascending.
 */
export async function loadFrames(
  index: VideoFrameIndex,
  options?: LoadFramesOptions
): Promise<LoadedVideoFrame[]> {
  const keyFramesOnly = options?.keyFramesOnly ?? true;
  const maxFrames     = options?.maxFrames     ?? 8;

  const candidates = keyFramesOnly
    ? index.frames.filter((f) => f.isKeyFrame)
    : [...index.frames];

  // Sort ascending so frames tell the story in order
  candidates.sort((a, b) => a.stepIndex - b.stepIndex);

  const capped = candidates.slice(0, maxFrames);

  const loaded: LoadedVideoFrame[] = [];
  for (const frame of capped) {
    if (!existsSync(frame.screenshotPath)) continue;
    try {
      const buf = await readFile(frame.screenshotPath);
      loaded.push({
        ...frame,
        base64: buf.toString("base64"),
        mediaType: "image/png",
        sizeBytes: buf.byteLength,
      });
    } catch {
      // Non-fatal — skip unreadable frames
    }
  }

  return loaded;
}

/**
 * Convenience: load all key frames from a frame-index.json path on disk.
 */
export async function loadFramesFromPath(
  frameIndexPath: string,
  options?: LoadFramesOptions
): Promise<LoadedVideoFrame[]> {
  const raw = await readFile(frameIndexPath, "utf8");
  const index = JSON.parse(raw) as VideoFrameIndex;
  return loadFrames(index, options);
}
