/**
 * DefaultRecorder — deterministic Playwright-based demo recorder.
 *
 * buildScript(spec):
 *   Pure function. Derives a fixed step sequence from the locked spec.
 *   For REST APIs: generates browser-api-call steps (fetch + overlay + screenshot)
 *   for each HTTP operation found in the criteria, in CRUD order.
 *   For web frontends: falls back to navigate + screenshot.
 *
 * record(spec, workspace, script):
 *   1. mkdir candidates/<id>/recording/
 *   2. Prepare workspace (npm install + build)
 *   3. Resolve start command, spawn server, poll for port (15s)
 *   4. Detect API vs frontend (HEAD / content-type check)
 *   5. Launch Playwright, execute steps with video + screenshots
 *   6. Kill server, write demo-log.json, return RecordingResult
 */

import { mkdir, writeFile, rename } from "node:fs/promises";
import { buildFrameIndex } from "./video-ingest.js";
import { join, dirname } from "node:path";
import type { Recorder, DemoScript, DemoScriptStep, RecordOptions } from "./index.js";
import {
  prepareWorkspace,
  resolveStartCommand,
  spawnServer,
  waitForPort,
  extractPortFromText,
} from "./server.js";
import { log } from "../logger.js";
import type {
  RunSpec,
  Workspace,
  RecordingResult,
  DemoStep,
  SuccessCriterion,
  ApiTraceStep,
  ApiTrace,
  VideoFrameIndex,
} from "../types/index.js";

const SERVER_WAIT_MS = 15_000;
const VIDEO_SIZE = { width: 1280, height: 720 };

// ─── API operation extracted from a criterion description ─────────────────────

interface ApiOperation {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;          // e.g. /todos or /todos/:id
  body?: string;         // JSON string, for POST/PUT/PATCH
  description?: string;  // human-readable step label for overlays and manifest
}

export class DefaultRecorder implements Recorder {
  // ─── Script building (pure, spec-driven) ─────────────────────────────────

  buildScript(spec: RunSpec): DemoScript {
    const baseUrl = guessBaseUrl(spec.successCriteria);
    const steps: DemoScriptStep[] = [];

    // Shell: start the server (command refined at record() time)
    steps.push({
      kind: "shell",
      description: "Start app server",
      command: guessStartCommand(spec.constraints),
      required: false,
      timeoutMs: SERVER_WAIT_MS,
    });

    // Build API interaction steps — extract from criteria then fill in the full CRUD set
    const rawOps = extractApiOperations(spec.successCriteria);
    const ops = inferCrudOps(spec, rawOps);
    let stepIdx = 1;

    if (ops.length > 0) {
      // For each extracted API operation, add an api-call + screenshot pair
      for (const op of ops) {
        const file = `step-api-${stepIdx}.png`;
        steps.push({
          kind: "browser-api-call",
          description: op.description ?? `${op.method} ${op.path}`,
          command: `${op.method} ${op.path}`,
          required: false,
          timeoutMs: 10_000,
          ...(op.body ? { body: op.body } : {}),
          screenshotFile: file,
        });
        stepIdx++;
      }
    } else {
      // Frontend app — navigate + interactive UI recording
      steps.push({
        kind: "browser-navigate",
        description: `Navigate to ${baseUrl}`,
        command: baseUrl,
        required: false,
        timeoutMs: 10_000,
      });
      steps.push({
        kind: "browser-screenshot",
        description: "Initial page state",
        command: "step-01-initial.png",
        required: false,
        timeoutMs: 5_000,
      });

      // Generic interaction sequence: type progressively stronger inputs into
      // the first visible text/password input, screenshot after each.
      // Useful for password meters, search boxes, form validation, etc.
      const inputSamples: Array<{ text: string; label: string }> = [
        { text: "abc",         label: "short input" },
        { text: "Password1",   label: "medium input" },
        { text: "P@ssw0rd1!",  label: "strong input" },
      ];

      for (let s = 0; s < inputSamples.length; s++) {
        const sample = inputSamples[s]!;
        steps.push({
          kind: "browser-type",
          description: `Type ${sample.label} (${sample.text})`,
          command: sample.text,
          required: false,
          timeoutMs: 5_000,
          screenshotFile: `step-0${s + 2}-type-${s + 1}.png`,
        });
      }
    }

    return { baseUrl, steps };
  }

  // ─── Recording ────────────────────────────────────────────────────────────

  async record(
    spec: RunSpec,
    workspace: Workspace,
    script: DemoScript,
    opts?: RecordOptions
  ): Promise<RecordingResult> {
    const candidateDir = dirname(workspace.rootPath);
    const recordingDir = join(candidateDir, "recording");
    const screenshotDir = join(recordingDir, "screenshots");

    await mkdir(screenshotDir, { recursive: true });

    const demoLog: DemoStep[] = [];
    const screenshotPaths: string[] = [];
    let videoPath: string | undefined;
    let stepIndex = 0;
    let traceSteps: ApiTraceStep[] = [];
    let resolvedBaseUrl = "";

    // ── Prepare workspace (npm install + build) ──────────────────────────────
    log("record", `Preparing workspace${opts?.execFn ? " (docker exec)" : ""}...`);
    let prepLog: string;
    if (opts?.execFn) {
      prepLog = await prepareWorkspaceViaExec(opts.execFn);
    } else {
      prepLog = await prepareWorkspace(workspace.rootPath);
    }
    if (prepLog) {
      const prepStep = logStep(stepIndex++, "Prepare workspace", "npm install && npx tsc");
      prepStep.exitCode = 0;
      prepStep.stdout = prepLog;
      prepStep.durationMs = 0;
      demoLog.push(prepStep);
      log("record", prepLog.split("\n").map(l => `  ${l}`).join("\n"));
    }

    // ── Find + start server ──────────────────────────────────────────────────
    const startCmd = await resolveStartCommand(workspace.rootPath);
    const shellStep = logStep(stepIndex++, "Start app server", startCmd ?? "(no runnable entry point)");

    if (!startCmd) {
      log("record", "No runnable entry point found — skipping server start");
      shellStep.exitCode = 1;
      shellStep.stderr = "No runnable entry point found in workspace.";
      shellStep.durationMs = 0;
      demoLog.push(shellStep);
      return this._finish(spec, recordingDir, demoLog, screenshotPaths, videoPath, traceSteps, resolvedBaseUrl);
    }

    log("record", `Starting server${opts?.spawnServerFn ? " (docker exec)" : ""}: ${startCmd}`);
    const preferPort = opts?.overridePort
      ?? extractPortFromText(spec.successCriteria.map((c) => c.description).join(" "));
    const spawnFn = opts?.spawnServerFn ?? spawnServer;
    const serverHandle = spawnFn(startCmd, workspace.rootPath);
    const started = Date.now();
    const portResult = await waitForPort(SERVER_WAIT_MS, preferPort);
    shellStep.durationMs = Date.now() - started;

    if (!portResult) {
      log("record", `Server did not respond within ${SERVER_WAIT_MS / 1000}s`);
      shellStep.exitCode = 1;
      shellStep.stderr = `Server did not respond on any port within ${SERVER_WAIT_MS}ms.`;
      shellStep.stdout = serverHandle.startupLog.slice(0, 500);
      demoLog.push(shellStep);
      serverHandle.kill();
      return this._finish(spec, recordingDir, demoLog, screenshotPaths, videoPath, traceSteps, resolvedBaseUrl);
    }

    shellStep.exitCode = 0;
    shellStep.stdout = `Server ready at ${portResult.url}`;
    demoLog.push(shellStep);
    log("record", `Server ready at ${portResult.url} — launching browser`);

    const resolvedBase = portResult.url;
    resolvedBaseUrl = resolvedBase;

    // ── Browser steps ────────────────────────────────────────────────────────
    try {
      const pw = await importPlaywright();
      if (!pw) {
        const step = logStep(stepIndex++, "Launch browser", "playwright chromium");
        step.exitCode = 1;
        step.stderr = "Playwright not installed. Run: npx playwright install chromium";
        demoLog.push(step);
      } else {
        const totalApiSteps = script.steps.filter(
          (s) => s.kind === "browser-api-call"
        ).length;

        const result = await this._runBrowserSteps(
          pw, script, resolvedBase,
          recordingDir, screenshotDir,
          demoLog, screenshotPaths,
          stepIndex,
          totalApiSteps
        );
        videoPath = result.videoPath;
        stepIndex = result.nextStepIndex;
        traceSteps = result.traceSteps;
      }
    } catch (err) {
      const step = logStep(stepIndex++, "Browser recording", "playwright");
      step.exitCode = 1;
      step.stderr = err instanceof Error ? err.message : String(err);
      demoLog.push(step);
    } finally {
      serverHandle.kill();
    }

    return this._finish(spec, recordingDir, demoLog, screenshotPaths, videoPath, traceSteps, resolvedBaseUrl);
  }

  // ─── Browser recording via Playwright ────────────────────────────────────

  private async _runBrowserSteps(
    pw: PlaywrightModule,
    script: DemoScript,
    resolvedBase: string,
    recordingDir: string,
    screenshotDir: string,
    demoLog: DemoStep[],
    screenshotPaths: string[],
    startIndex: number,
    totalApiSteps: number
  ): Promise<{ videoPath?: string; nextStepIndex: number; traceSteps: ApiTraceStep[] }> {
    let stepIndex = startIndex;
    let videoPath: string | undefined;
    let apiStepNum = 0;  // 1-indexed counter for api-call steps only
    const traceSteps: ApiTraceStep[] = [];

    // Track last created resource ID so DELETE/PUT/:id steps can use it
    let lastCreatedId: string | number | null = null;

    const browser = await pw.chromium.launch({ headless: true });
    const context = await browser.newContext({
      recordVideo: { dir: recordingDir, size: VIDEO_SIZE },
    });
    const page = await context.newPage();

    // Set up a minimal demo backdrop so the page has a document.body for overlay injection
    await page.setContent(`<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  body { margin:0; background:#11111b; display:flex; align-items:center; justify-content:center;
         height:100vh; font-family:monospace; color:#cdd6f4; }
  .badge { font-size:18px; opacity:0.18; user-select:none; }
</style></head>
<body><div class="badge">API Demo — ${resolvedBase}</div></body></html>`);

    try {
      for (const step of script.steps) {
        if (step.kind === "shell") continue;

        // ── navigate ──────────────────────────────────────────────────────
        if (step.kind === "browser-navigate") {
          const url = step.command.startsWith("http")
            ? step.command.replace(/localhost:\d+/, resolvedBase.replace("http://", "").replace(/\/$/, ""))
            : resolvedBase;
          const navStep = logStep(stepIndex++, step.description, url);
          const t = Date.now();
          try {
            await page.goto(url, { timeout: step.timeoutMs, waitUntil: "domcontentloaded" });
            navStep.exitCode = 0;
            navStep.stdout = `Loaded: ${url}`;
          } catch (err) {
            navStep.exitCode = 1;
            navStep.stderr = err instanceof Error ? err.message : String(err);
          }
          navStep.durationMs = Date.now() - t;
          demoLog.push(navStep);
        }

        // ── screenshot ────────────────────────────────────────────────────
        if (step.kind === "browser-screenshot") {
          const absPath = join(screenshotDir, step.command);
          const ssStep = logStep(stepIndex++, step.description, step.command);
          const t = Date.now();
          try {
            await page.screenshot({ path: absPath, fullPage: true });
            screenshotPaths.push(absPath);
            ssStep.exitCode = 0;
          } catch (err) {
            ssStep.exitCode = 1;
            ssStep.stderr = err instanceof Error ? err.message : String(err);
          }
          ssStep.durationMs = Date.now() - t;
          demoLog.push(ssStep);
        }

        // ── browser-type ─────────────────────────────────────────────────
        if (step.kind === "browser-type") {
          const typeStep = logStep(stepIndex++, step.description, step.command);
          const t = Date.now();
          try {
            // Clear the first visible input and type the new value
            await page.evaluate((rawArg: unknown) => {
              const text = rawArg as string;
              const input = document.querySelector<HTMLInputElement>(
                'input[type="password"], input[type="text"], input[type="search"], input:not([type="hidden"])'
              );
              if (input) {
                input.focus();
                input.value = "";
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.value = text;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
              }
            }, step.command);
            // Give the UI time to react (real-time listeners)
            await new Promise(r => setTimeout(r, 600));
            // Screenshot
            const filename = step.screenshotFile ?? `step-type-${stepIndex}.png`;
            const absPath = join(screenshotDir, filename);
            await page.screenshot({ path: absPath, fullPage: true });
            screenshotPaths.push(absPath);
            typeStep.exitCode = 0;
            typeStep.stdout = `Typed "${step.command}", screenshot: ${filename}`;
          } catch (err) {
            typeStep.exitCode = 1;
            typeStep.stderr = err instanceof Error ? err.message : String(err);
          }
          typeStep.durationMs = Date.now() - t;
          demoLog.push(typeStep);
        }

        // ── api-call ──────────────────────────────────────────────────────
        if (step.kind === "browser-api-call") {
          apiStepNum++;
          const [method, rawPath] = step.command.split(" ") as [string, string];

          // Substitute :id with the last created resource ID
          const resolvedPath = lastCreatedId !== null
            ? rawPath.replace(/:id\b|\{id\}/g, String(lastCreatedId))
            : rawPath.replace(/\/:[^/]+/g, "/1"); // fallback to /1 if no ID yet

          const url = resolvedBase.replace(/\/$/, "") + resolvedPath;
          const body = step.body ?? null;

          const apiStep = logStep(stepIndex++, step.description, url);
          const t = Date.now();

          log("record", `  api-call: ${method} ${resolvedPath}${body ? ` body: ${body.slice(0, 60)}` : ""}`);

          // Trace data collected during this step
          let traceHttpStatus: number | undefined;
          let traceResponseBody: string | undefined;
          let traceScreenshotPath: string | undefined;

          try {
            // Make the HTTP call from Node.js (no CORS / same-origin restrictions)
            const nodeOpts: RequestInit = { method };
            if (body) {
              nodeOpts.headers = { "Content-Type": "application/json" };
              nodeOpts.body = body;
            }
            const res = await globalThis.fetch(url, nodeOpts);
            const responseText = await res.text();
            const result = { status: res.status, body: responseText };

            traceHttpStatus = result.status;
            traceResponseBody = result.body.slice(0, 4096); // full body for trace

            // Track created ID from POST responses
            if (method === "POST" && result.status >= 200 && result.status < 300) {
              try {
                const parsed = JSON.parse(result.body) as Record<string, unknown>;
                const id = parsed["id"] ?? parsed["_id"] ?? parsed["uuid"];
                if (id !== undefined) lastCreatedId = id as string | number;
              } catch { /* not JSON or no id field */ }
            }

            // Inject a styled overlay showing the API call result
            await page.evaluate(
              (rawArg: unknown) => {
                const { overlayMethod, overlayPath, status, responseBody, stepLabel, stepDescription } =
                  rawArg as {
                    overlayMethod: string; overlayPath: string;
                    status: number; responseBody: string;
                    stepLabel: string; stepDescription: string;
                  };
                document.querySelectorAll("[data-api-overlay]").forEach(el => el.remove());
                const el = document.createElement("div");
                el.setAttribute("data-api-overlay", "1");
                const statusColor = status >= 200 && status < 300 ? "#a6e3a1" : "#f38ba8";
                const methodColor: Record<string, string> = {
                  GET: "#89b4fa", POST: "#a6e3a1", PUT: "#fab387",
                  PATCH: "#fab387", DELETE: "#f38ba8",
                };
                el.style.cssText = [
                  "position:fixed", "top:20px", "right:20px", "z-index:9999",
                  "background:#1e1e2e", "color:#cdd6f4", "padding:16px 20px",
                  "border-radius:10px", "font-family:monospace", "font-size:13px",
                  "max-width:480px", "min-width:280px",
                  "border:1px solid #45475a",
                  "box-shadow:0 8px 32px rgba(0,0,0,0.6)",
                ].join(";");
                let prettyBody = responseBody;
                try { prettyBody = JSON.stringify(JSON.parse(responseBody), null, 2); } catch { /* ok */ }
                el.innerHTML = `
                  <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px">
                    <span style="color:#6c7086;font-size:11px">${stepLabel}</span>
                    <span style="color:#cdd6f4;font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${stepDescription}</span>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
                    <span style="background:${methodColor[overlayMethod] ?? "#cba6f7"};color:#1e1e2e;padding:2px 8px;border-radius:4px;font-weight:bold;font-size:12px">${overlayMethod}</span>
                    <span style="color:#cdd6f4">${overlayPath}</span>
                    <span style="margin-left:auto;color:${statusColor};font-weight:bold">${status}</span>
                  </div>
                  <pre style="margin:0;color:#a6e3a1;white-space:pre-wrap;max-height:180px;overflow:auto;font-size:12px">${prettyBody.slice(0, 600)}</pre>
                `;
                document.body.appendChild(el);
              },
              {
                overlayMethod: method, overlayPath: resolvedPath,
                status: result.status, responseBody: result.body,
                stepLabel: `${apiStepNum}/${totalApiSteps}`,
                stepDescription: step.description,
              }
            );

            // Wait a moment so the overlay is visible in the video
            await new Promise(r => setTimeout(r, 800));

            // Screenshot with overlay visible — captured for the trace
            const filename = step.screenshotFile ?? `step-api-${stepIndex}.png`;
            const absPath = join(screenshotDir, filename);
            await page.screenshot({ path: absPath, fullPage: false });
            screenshotPaths.push(absPath);
            traceScreenshotPath = absPath;

            apiStep.exitCode = result.status >= 200 && result.status < 300 ? 0 : 1;
            apiStep.stdout = `${result.status} — ${result.body.slice(0, 200)}`;
            log("record", `    → ${result.status}: ${result.body.slice(0, 80)}`);

            // Clear overlay
            await page.evaluate(() => {
              document.querySelectorAll("[data-api-overlay]").forEach(el => el.remove());
            });
            await new Promise(r => setTimeout(r, 300));

          } catch (err) {
            apiStep.exitCode = 1;
            apiStep.stderr = err instanceof Error ? err.message : String(err);
            log("record", `    error: ${apiStep.stderr.slice(0, 120)}`);
          }

          apiStep.durationMs = Date.now() - t;
          demoLog.push(apiStep);

          // Accumulate trace step (full fidelity — not truncated like demoLog.stdout)
          traceSteps.push({
            index: apiStepNum,
            description: step.description,
            method,
            path: resolvedPath,
            ...(body ? { requestBody: body } : {}),
            ...(traceHttpStatus !== undefined ? { httpStatus: traceHttpStatus } : {}),
            ...(traceResponseBody !== undefined ? { responseBody: traceResponseBody } : {}),
            passed: apiStep.exitCode === 0,
            ...(traceScreenshotPath ? { screenshotPath: traceScreenshotPath } : {}),
            durationMs: apiStep.durationMs,
          });
        }
      }
    } finally {
      await context.close(); // finalizes video
    }

    // Retrieve video and rename to demo.webm
    try {
      const rawVideoPath = await page.video()?.path();
      if (rawVideoPath) {
        const dest = join(recordingDir, "demo.webm");
        await rename(rawVideoPath, dest);
        videoPath = dest;
      }
    } catch { /* video save non-fatal */ }

    await browser.close();
    return { ...(videoPath ? { videoPath } : {}), nextStepIndex: stepIndex, traceSteps };
  }

  // ─── Finalise ─────────────────────────────────────────────────────────────

  private async _finish(
    spec: RunSpec,
    recordingDir: string,
    demoLog: DemoStep[],
    screenshotPaths: string[],
    videoPath: string | undefined,
    traceSteps: ApiTraceStep[],
    baseUrl: string
  ): Promise<RecordingResult> {
    const completedAt = new Date().toISOString();
    const serverStep = demoLog.find((s) => s.description === "Start app server");
    const serverStarted = serverStep?.exitCode === 0;

    // ── API trace (primary debate input) ─────────────────────────────────────
    // Deduplicate endpoint labels using the raw path template (":id" not "3")
    const endpointsSeen = new Set<string>();
    for (const s of traceSteps) {
      // Normalise back to template form: replace numeric segments after the resource path
      const template = s.path.replace(/\/\d+/g, "/:id");
      endpointsSeen.add(`${s.method} ${template}`);
    }

    const trace: ApiTrace = {
      runId: spec.id,
      scenarioTitle: spec.goal,
      serverStarted,
      baseUrl,
      steps: traceSteps,
      summary: {
        totalSteps: traceSteps.length,
        passed: traceSteps.filter((s) => s.passed).length,
        failed: traceSteps.filter((s) => !s.passed).length,
        endpointsCovered: [...endpointsSeen],
      },
      completedAt,
    };

    const tracePath = join(recordingDir, "api-trace.json");
    await writeFile(tracePath, JSON.stringify(trace, null, 2), "utf8");

    // ── Frame index (video ingestion for evaluators) ──────────────────────────
    // V1 strategy: index the per-step screenshots already captured by the recorder.
    // Evaluators call loadFrames(frameIndex) to base64-encode only the frames
    // they need (typically key frames). No ffmpeg, no eager base64 in JSON.
    const frameIndex: VideoFrameIndex = buildFrameIndex(spec.id, traceSteps, videoPath, screenshotPaths);
    const frameIndexPath = join(recordingDir, "frame-index.json");
    await writeFile(frameIndexPath, JSON.stringify(frameIndex, null, 2), "utf8");

    // ── Recording manifest (human-readable summary) ───────────────────────────
    const reviewSteps = demoLog.filter((s) => s.description !== "Prepare workspace");
    const totalDurationMs = demoLog.reduce((sum, s) => sum + s.durationMs, 0);

    const manifest: import("../types/index.js").RecordingManifest = {
      runId: spec.id,
      scenarioTitle: spec.goal,
      serverStarted,
      totalSteps: reviewSteps.length,
      stepsPassed: reviewSteps.filter((s) => s.exitCode === 0).length,
      stepsFailed: reviewSteps.filter((s) => s.exitCode !== 0).length,
      totalDurationMs,
      ...(videoPath ? { videoPath } : {}),
      screenshotCount: screenshotPaths.length,
      steps: reviewSteps.map((s) => ({
        index: s.stepIndex,
        description: s.description,
        passed: s.exitCode === 0,
        durationMs: s.durationMs,
      })),
      completedAt,
    };

    const manifestPath = join(recordingDir, "recording-manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    // ── Demo log (full detail for debugging) ─────────────────────────────────
    const result: RecordingResult = {
      runId: spec.id,
      ...(videoPath ? { videoPath } : {}),
      screenshotPaths,
      demoLog,
      manifestPath,
      tracePath,
      frameIndexPath,
      completedAt,
    };
    await writeFile(
      join(recordingDir, "demo-log.json"),
      JSON.stringify(result, null, 2),
      "utf8"
    );
    return result;
  }
}

// ─── API operation extraction ─────────────────────────────────────────────────

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = typeof HTTP_METHODS[number];

function extractApiOperations(criteria: SuccessCriterion[]): ApiOperation[] {
  const ops: ApiOperation[] = [];
  const seen = new Set<string>();

  for (const c of criteria) {
    if (c.checkKind !== "runtime") continue;
    const op = parseApiOperation(c.description);
    if (!op) continue;
    const key = `${op.method}:${op.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ops.push(op);
  }

  // Sort into logical CRUD order: GET(list) → POST → GET(item) → PUT → DELETE
  const order: Record<HttpMethod, number> = { GET: 0, POST: 1, PUT: 3, PATCH: 3, DELETE: 4 };
  ops.sort((a, b) => {
    const ao = order[a.method] ?? 5;
    const bo = order[b.method] ?? 5;
    if (ao !== bo) return ao - bo;
    // List routes (no :id) before item routes
    const aItem = a.path.includes(":") ? 1 : 0;
    const bItem = b.path.includes(":") ? 1 : 0;
    return aItem - bItem;
  });

  return ops;
}

/**
 * If the spec signals CRUD intent and we can identify the resource path,
 * expand the operation list to cover the full GET/POST/GET-item/PUT/DELETE
 * sequence. Existing ops (from criteria) take precedence for body content.
 */
function inferCrudOps(spec: RunSpec, existing: ApiOperation[]): ApiOperation[] {
  const goalText = [spec.goal, ...spec.constraints].join(" ");
  const isCrud = /\bcrud\b|create.*update.*delete|rest api|restful/i.test(goalText);
  if (!isCrud) return existing;

  const resourcePath = findResourcePath(existing, spec);
  if (!resourcePath) return existing;

  const resourceName = resourcePath.replace(/^\//, "");         // e.g. "todos"
  const singular     = resourceName.replace(/s$/, "");           // e.g. "todo"
  const itemPath     = `${resourcePath}/:id`;

  // Seven-step end-to-end scenario: create → read → update → verify → delete → verify
  const fullSet: ApiOperation[] = [
    {
      method: "GET", path: resourcePath,
      description: `List ${resourceName} (empty baseline)`,
    },
    {
      method: "POST", path: resourcePath,
      description: `Create ${singular}`,
      body: JSON.stringify({ title: `Test ${singular}`, completed: false }),
    },
    {
      method: "GET", path: itemPath,
      description: `Read created ${singular}`,
    },
    {
      method: "PUT", path: itemPath,
      description: `Update ${singular}`,
      body: JSON.stringify({ title: `Updated ${singular}`, completed: true }),
    },
    {
      method: "GET", path: itemPath,
      description: `Verify update persisted`,
    },
    {
      method: "DELETE", path: itemPath,
      description: `Delete ${singular}`,
    },
    {
      method: "GET", path: resourcePath,
      description: `Verify deletion — list ${resourceName}`,
    },
  ];

  // Existing ops (parsed from criteria) override defaults for the same method+path
  const existingMap = new Map(existing.map(o => [`${o.method}:${o.path}`, o]));
  return fullSet.map(op => existingMap.get(`${op.method}:${op.path}`) ?? op);
}

function findResourcePath(ops: ApiOperation[], spec: RunSpec): string | null {
  // 1. From already-extracted ops — prefer the list endpoint (no :id param)
  for (const op of ops) {
    if (!op.path.includes(":") && op.path !== "/") return op.path;
  }

  // 2. From constraints: "routes must be prefixed with /todos"
  for (const c of spec.constraints) {
    const m = c.match(/prefix(?:ed)?\s+(?:with\s+)?(\/[\w-]+)/i);
    if (m) return m[1]!;
  }

  // 3. From goal + criteria text: look for common REST resource patterns
  const allText = [spec.goal, ...spec.successCriteria.map(c => c.description)].join(" ");
  const m = allText.match(/\/(todos?|items?|posts?|users?|products?|tasks?|notes?)\b/i);
  if (m) return `/${m[1]!.toLowerCase()}`;

  return null;
}

function parseApiOperation(description: string): ApiOperation | null {
  // Match "METHOD /path" or "METHOD http://host/path" anywhere in the description
  const methodMatch = description.match(
    /\b(GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/[^/\s]+)?(\/[^\s`'")\]]*)/i
  );
  if (!methodMatch) return null;

  const method = methodMatch[1]!.toUpperCase() as HttpMethod;
  const path = methodMatch[2]!.replace(/[.,;]$/, ""); // strip trailing punctuation

  // Extract body from curl -d or -d '{...}' pattern
  let body: string | undefined;
  const bodyMatch = description.match(/-d\s+'([^']+)'/) ??
                    description.match(/-d\s+"([^"]+)"/) ??
                    description.match(/-d\s+`([^`]+)`/);
  if (bodyMatch) {
    body = bodyMatch[1]!.replace(/\\"/g, '"').replace(/\\'/g, "'");
  }

  // For POST/PUT without explicit body, use a sensible default
  if ((method === "POST" || method === "PUT") && !body) {
    const resource = path.split("/").filter(Boolean)[0] ?? "item";
    // Guess a minimal body from the resource name
    body = JSON.stringify({ title: `Test ${resource}` });
  }

  return { method, path, ...(body ? { body } : {}) };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function logStep(index: number, description: string, command: string): DemoStep {
  return { stepIndex: index, description, command, stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
}

function guessStartCommand(constraints: string[]): string {
  const lower = constraints.join(" ").toLowerCase();
  if (lower.includes("typescript") && !lower.includes("ts-node")) return "node dist/index.js";
  if (lower.includes("express") || lower.includes("fastify")) return "node server.js";
  return "node index.js";
}

function guessBaseUrl(criteria: SuccessCriterion[]): string {
  const text = criteria.map((c) => c.description).join(" ");
  const port = extractPortFromText(text);
  return `http://localhost:${port ?? 3000}/`;
}

function extractUrlPath(description: string): string | null {
  const m = description.match(/(?:GET|POST|PUT|DELETE|navigate\s+to|visits?|endpoint)\s+(\/\S*)/i)
    ?? description.match(/\bpath\b[^/]*(\/\S+)/i);
  return m ? m[1]! : null;
}

// ─── Playwright dynamic import ────────────────────────────────────────────────

interface PlaywrightModule {
  chromium: {
    launch(opts: { headless: boolean }): Promise<{
      newContext(opts: object): Promise<{
        newPage(): Promise<PageHandle>;
        close(): Promise<void>;
      }>;
      close(): Promise<void>;
    }>;
  };
}

interface PageHandle {
  goto(url: string, opts?: object): Promise<unknown>;
  setContent(html: string, opts?: object): Promise<void>;
  title(): Promise<string>;
  screenshot(opts: { path: string; fullPage?: boolean }): Promise<unknown>;
  evaluate<T>(fn: (...args: unknown[]) => Promise<T> | T, arg?: unknown): Promise<T>;
  video(): { path(): Promise<string | null> } | null;
  close(): Promise<void>;
}

// ─── Docker-aware workspace prep ─────────────────────────────────────────────

async function prepareWorkspaceViaExec(
  execFn: (cmd: string, cwd?: string, timeoutMs?: number) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>
): Promise<string> {
  const lines: string[] = [];

  const hasPkg = (await execFn("test -f package.json", undefined, 5_000)).exitCode === 0;
  if (!hasPkg) return "";

  const install = await execFn("npm install 2>&1", undefined, 120_000);
  lines.push(`[prep] npm install → exit ${install.exitCode}`);
  if (install.stderr.trim()) lines.push(install.stderr.slice(0, 400));

  const hasTsc = (await execFn("test -f tsconfig.json", undefined, 5_000)).exitCode === 0;
  if (hasTsc) {
    const build = await execFn("npx tsc 2>&1", undefined, 60_000);
    lines.push(`[prep] npx tsc → exit ${build.exitCode}`);
    if (build.stderr.trim()) lines.push(build.stderr.slice(0, 400));
  }

  return lines.join("\n");
}

async function importPlaywright(): Promise<PlaywrightModule | null> {
  try {
    const pw = await import("playwright");
    return pw as unknown as PlaywrightModule;
  } catch {
    return null;
  }
}

export function createRecorder(): Recorder {
  return new DefaultRecorder();
}
