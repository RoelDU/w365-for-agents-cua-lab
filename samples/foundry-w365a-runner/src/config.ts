import path from "node:path";
import type { RunnerMode } from "./types";

export interface RunnerConfig {
  /** "simulation" runs fully offline (no Azure calls); "live" calls Foundry + W365A. */
  mode: RunnerMode;

  /** This runner's backend identity. A prefill whose `target_backend` is set and does not
   * match this value is ignored, so the MCS and Foundry agents never both drive the Cloud
   * PC for one handoff. Set via RUNNER_BACKEND_ID; defaults to "foundry". */
  backendId: "mcs" | "foundry";

  // --- Handoff folder (shared with the legacy app + local orchestrator) ----
  handoffDir: string;
  inDir: string;
  outDir: string;
  prefillPath: string;
  readyPath: string;
  resultPath: string;
  errorPath: string;
  /** Poll interval used as a fallback alongside the file watcher (ms). */
  pollMs: number;

  // --- Azure AI Foundry (Computer Use via the responses API) ---------------
  foundry: {
    /** Resource base, e.g. https://<resource>.openai.azure.com (no trailing slash). */
    endpoint: string;
    /** Model deployment name driving Computer Use (e.g. computer-use-preview). */
    model: string;
    /** Responses API version, if your endpoint requires one as a query string. */
    apiVersion: string;
    /** Tool type for the Computer Use tool (computer_use_preview | computer). */
    toolType: string;
    /** Entra scope for the data-plane token. */
    scope: string;
    /** Virtual display the model reasons about (must match the Cloud PC). */
    displayWidth: number;
    displayHeight: number;
    /** Hard cap on the screenshot -> action loop so a run can never hang forever. */
    maxIterations: number;
  };

  // --- Windows 365 for Agents (Cloud PC session lifecycle) -----------------
  w365a: {
    /** Session-lifecycle API base, e.g. https://<pool-endpoint> (no trailing slash). */
    baseUrl: string;
    /** Pool to check a Cloud PC out of. */
    poolId: string;
    /** api-version for /api/pools/{pool}/sessions and /api/sessions/{id}. */
    sessionApiVersion: string;
    /** api-version for /computers/{id}/mcp. */
    mcpApiVersion: string;
    /** Entra scope for the session-lifecycle token. */
    scope: string;
    /** Command used to launch the legacy app on the Cloud PC before the CU loop. */
    launchCommand: string;
  };

  // --- Entra auth (live mode). Falls back to DefaultAzureCredential. --------
  auth: {
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
  };
}

const DEFAULT_PORT_HANDOFF =
  process.platform === "win32"
    ? path.join(process.env.ProgramData || "C:\\ProgramData", "ZavaClaims", "handoff")
    : path.join(process.cwd(), ".handoff");

function num(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  const mode: RunnerMode = (env.RUNNER_MODE ?? "simulation").toLowerCase() === "live" ? "live" : "simulation";
  const backendId: "mcs" | "foundry" =
    (env.RUNNER_BACKEND_ID ?? "foundry").toLowerCase() === "mcs" ? "mcs" : "foundry";

  const handoffDir =
    env.HANDOFF_DIR && env.HANDOFF_DIR.trim().length > 0
      ? path.resolve(env.HANDOFF_DIR.trim())
      : DEFAULT_PORT_HANDOFF;
  const inDir = path.join(handoffDir, "in");
  const outDir = path.join(handoffDir, "out");

  return {
    mode,
    backendId,
    handoffDir,
    inDir,
    outDir,
    prefillPath: path.join(inDir, "prefill.json"),
    readyPath: path.join(outDir, "ready.json"),
    resultPath: path.join(outDir, "result.json"),
    errorPath: path.join(outDir, "error.json"),
    pollMs: num(env.POLL_MS, 1500),

    foundry: {
      endpoint: trimTrailingSlash(env.FOUNDRY_ENDPOINT ?? ""),
      model: env.FOUNDRY_MODEL ?? "computer-use-preview",
      apiVersion: env.FOUNDRY_API_VERSION ?? "preview",
      toolType: env.FOUNDRY_TOOL_TYPE ?? "computer_use_preview",
      scope: env.FOUNDRY_SCOPE ?? "https://ai.azure.com/.default",
      displayWidth: num(env.DISPLAY_WIDTH, 1280),
      displayHeight: num(env.DISPLAY_HEIGHT, 800),
      maxIterations: num(env.MAX_ITERATIONS, 40)
    },

    w365a: {
      baseUrl: trimTrailingSlash(env.W365A_BASE_URL ?? ""),
      poolId: env.W365A_POOL_ID ?? "",
      sessionApiVersion: env.W365A_SESSION_API_VERSION ?? "2.0",
      mcpApiVersion: env.W365A_MCP_API_VERSION ?? "1.0",
      scope: env.W365A_SCOPE ?? "https://cloudpc.microsoft.com/.default",
      launchCommand:
        env.W365A_LAUNCH_COMMAND ??
        "\"%ProgramFiles%\\Business Applications\\Zava Claims Workstation\\claims.exe\" --no-splash --fast-auth --stable-host --idle-timeout=0 --demo-pin=1234"
    },

    auth: {
      tenantId: env.AZURE_TENANT_ID || undefined,
      clientId: env.AZURE_CLIENT_ID || undefined,
      clientSecret: env.AZURE_CLIENT_SECRET || undefined
    }
  };
}

/** Validate that live mode has the endpoints it needs; returns a list of problems. */
export function validateForLive(config: RunnerConfig): string[] {
  const problems: string[] = [];
  if (!config.foundry.endpoint) problems.push("FOUNDRY_ENDPOINT is required in live mode.");
  if (!config.foundry.model) problems.push("FOUNDRY_MODEL is required in live mode.");
  if (!config.w365a.baseUrl) problems.push("W365A_BASE_URL is required in live mode.");
  if (!config.w365a.poolId) problems.push("W365A_POOL_ID is required in live mode.");
  return problems;
}
