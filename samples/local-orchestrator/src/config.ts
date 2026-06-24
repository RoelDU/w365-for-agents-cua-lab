import path from "node:path";

export interface OrchestratorConfig {
  port: number;
  handoffDir: string;
  inDir: string;
  outDir: string;
  prefillPath: string;
  readyPath: string;
  resultPath: string;
  errorPath: string;
  /** "*" reflects any origin; otherwise an explicit allow-list. */
  allowedOrigins: string[] | "*";
}

const DEFAULT_PORT = 4000;
const DEFAULT_HANDOFF_DIR =
  process.platform === "win32"
    ? path.join(process.env.ProgramData || "C:\\ProgramData", "ZavaClaims", "handoff")
    : path.join(process.cwd(), ".handoff");

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrchestratorConfig {
  const port = Number.parseInt(env.PORT ?? "", 10) || DEFAULT_PORT;
  const handoffDir = env.HANDOFF_DIR && env.HANDOFF_DIR.trim().length > 0
    ? path.resolve(env.HANDOFF_DIR.trim())
    : DEFAULT_HANDOFF_DIR;

  const rawOrigins = (env.ALLOWED_ORIGINS ?? "*").trim();
  const allowedOrigins: string[] | "*" =
    rawOrigins === "*" || rawOrigins === ""
      ? "*"
      : rawOrigins
          .split(",")
          .map((o) => o.trim())
          .filter((o) => o.length > 0);

  const inDir = path.join(handoffDir, "in");
  const outDir = path.join(handoffDir, "out");

  return {
    port,
    handoffDir,
    inDir,
    outDir,
    prefillPath: path.join(inDir, "prefill.json"),
    readyPath: path.join(outDir, "ready.json"),
    resultPath: path.join(outDir, "result.json"),
    errorPath: path.join(outDir, "error.json"),
    allowedOrigins
  };
}
