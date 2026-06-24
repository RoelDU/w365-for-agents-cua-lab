import { promises as fs } from "node:fs";
import path from "node:path";
import type { RunnerConfig } from "./config";
import type { CloudPcComputer } from "./w365aSession";
import type { ComputerAction } from "./types";
import { getToken } from "./auth";

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Load the agent's behaviour + UI-navigation guidance from the in-repo Foundry
 * agent assets so the live Computer Use run is driven by the same instructions
 * Deploy-Agent.ps1 bakes into the published agent. Best-effort: missing files
 * just yield a minimal default instruction.
 */
export async function loadInstructions(assetRoot?: string): Promise<string> {
  const root =
    assetRoot ??
    path.resolve(__dirname, "..", "..", "..", "apps", "legacy-claims-workstation", "samples", "foundry-agent");
  const parts: string[] = [];
  for (const file of ["AGENT-INSTRUCTIONS.md", "CUA-TOOL-INSTRUCTIONS.md"]) {
    try {
      parts.push(await fs.readFile(path.join(root, file), "utf8"));
    } catch {
      /* asset not present in this layout - skip */
    }
  }
  if (parts.length === 0) {
    return "You operate the Zava Mutual Claims Workstation entirely on screen to file a First Notice of Loss for the caller, then report the resulting claim ID.";
  }
  return parts.join("\n\n---\n\n");
}

function dataUrl(base64: string): string {
  return `data:image/png;base64,${base64}`;
}

interface ResponsesCallArgs {
  input: any[];
  previousResponseId?: string;
}

/**
 * The Computer Use screenshot -> action loop against the Foundry responses API.
 * Returns the model's final assistant text (which contains the claim ID).
 */
export async function runComputerUse(
  config: RunnerConfig,
  computer: CloudPcComputer,
  opts: { instructions: string; task: string }
): Promise<string> {
  const endpoint = `${config.foundry.endpoint}/openai/v1/responses`;
  const url = config.foundry.apiVersion ? `${endpoint}?api-version=${config.foundry.apiVersion}` : endpoint;

  const callResponses = async (args: ResponsesCallArgs): Promise<any> => {
    const token = await getToken(config.foundry.scope, config.auth);
    const body: Record<string, unknown> = {
      model: config.foundry.model,
      instructions: opts.instructions,
      tools: [
        {
          type: config.foundry.toolType,
          display_width: config.foundry.displayWidth,
          display_height: config.foundry.displayHeight,
          environment: "windows"
        }
      ],
      input: args.input,
      truncation: "auto"
    };
    if (args.previousResponseId) body.previous_response_id = args.previousResponseId;

    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      throw new Error(`Foundry responses call failed: HTTP ${res.status} ${await res.text()}`);
    }
    return res.json();
  };

  const collectText = (output: any[]): string =>
    output
      .filter((o) => o.type === "message")
      .flatMap((o) => (Array.isArray(o.content) ? o.content : []))
      .filter((c: any) => c.type === "output_text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();

  // First turn: the captured CCaaS outcome + an initial screenshot of the Cloud PC.
  const firstShot = await computer.screenshot();
  let response = await callResponses({
    input: [
      {
        role: "user",
        content: [
          { type: "input_text", text: opts.task },
          { type: "input_image", image_url: dataUrl(firstShot) }
        ]
      }
    ]
  });

  for (let i = 0; i < config.foundry.maxIterations; i += 1) {
    const output: any[] = Array.isArray(response.output) ? response.output : [];
    const computerCalls = output.filter((o) => o.type === "computer_call");

    if (computerCalls.length === 0) {
      return collectText(output);
    }

    const call = computerCalls[0];
    const actions: ComputerAction[] = Array.isArray(call.actions)
      ? call.actions
      : call.action
        ? [call.action]
        : [];

    for (const action of actions) {
      if (action.type === "screenshot") continue; // handled by the screenshot below
      if (action.type === "wait") {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      await computer.act(action);
    }

    const shot = await computer.screenshot();
    const callOutput: Record<string, unknown> = {
      type: "computer_call_output",
      call_id: call.call_id,
      output: { type: "computer_screenshot", image_url: dataUrl(shot), detail: "original" }
    };
    // Acknowledge any safety checks so the loop can proceed (demo target only).
    if (Array.isArray(call.pending_safety_checks) && call.pending_safety_checks.length > 0) {
      callOutput.acknowledged_safety_checks = call.pending_safety_checks;
    }

    response = await callResponses({ input: [callOutput], previousResponseId: response.id });
  }

  throw new Error(`Computer Use loop did not finish within ${config.foundry.maxIterations} iterations.`);
}
