import type { RunnerConfig } from "./config";
import type { ComputerAction, W365ASession } from "./types";
import { getToken } from "./auth";

/**
 * The on-screen surface the Computer Use loop drives. In live mode this is a
 * Windows 365 for Agents Cloud PC reached over the MCP tool endpoint; in
 * simulation it is an in-memory stub.
 */
export interface CloudPcComputer {
  /** Launch the legacy app on the Cloud PC (the one non-screen action). */
  launch(command: string): Promise<void>;
  /** Capture the current screen as a base64-encoded PNG (no data: prefix). */
  screenshot(): Promise<string>;
  /** Execute a single Computer Use action (click/type/keypress/scroll/...). */
  act(action: ComputerAction): Promise<void>;
}

export interface W365AProvider {
  /** Check a Cloud PC out of the pool and return a driver bound to it. */
  checkout(): Promise<{ session: W365ASession; computer: CloudPcComputer }>;
  /** Release the Cloud PC back to the pool. Safe to call more than once. */
  checkin(session: W365ASession): Promise<void>;
}

/**
 * Map a Computer Use action onto a Windows 365 for Agents MCP tool call.
 * The MCP tool surface is a preview API; this 1:1 naming (computer_<type>) is the
 * single place to adjust if your tenant exposes different tool names.
 */
export function mapActionToMcp(action: ComputerAction): { tool: string; arguments: Record<string, unknown> } {
  const { type, ...rest } = action;
  return { tool: `computer_${type}`, arguments: rest as Record<string, unknown> };
}

// --------------------------------------------------------------------------
// Live provider - talks to the documented session-lifecycle + MCP endpoints.
//   POST   {base}/api/pools/{pool}/sessions?api-version=2.0   (checkout)
//   POST   {base}/computers/{computerId}/mcp?api-version=1.0   (drive)
//   DELETE {base}/api/sessions/{sessionId}?api-version=2.0     (checkin)
// See docs/agent-cua-setup.md (Optional - enterprise hardening).
// --------------------------------------------------------------------------

class LiveCloudPcComputer implements CloudPcComputer {
  constructor(
    private readonly config: RunnerConfig,
    private readonly computerId: string
  ) {}

  private async mcp(tool: string, args: Record<string, unknown>): Promise<unknown> {
    const token = await getToken(this.config.w365a.scope, this.config.auth);
    const url = `${this.config.w365a.baseUrl}/computers/${encodeURIComponent(this.computerId)}/mcp?api-version=${this.config.w365a.mcpApiVersion}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tool, arguments: args })
    });
    if (!res.ok) {
      throw new Error(`W365A MCP ${tool} failed: HTTP ${res.status} ${await res.text()}`);
    }
    return res.json().catch(() => ({}));
  }

  async launch(command: string): Promise<void> {
    // Run the launch command via the MCP shell capability before driving on screen.
    await this.mcp("computer_shell", { command });
  }

  async screenshot(): Promise<string> {
    const body = (await this.mcp("computer_screenshot", {})) as Record<string, unknown>;
    // Preview responses vary; accept the common shapes for a base64 image.
    const img =
      (body.image_base64 as string) ??
      (body.image as string) ??
      ((body.result as Record<string, unknown>)?.image_base64 as string);
    if (typeof img !== "string" || img.length === 0) {
      throw new Error("W365A screenshot did not return a base64 image (verify the MCP tool shape).");
    }
    return img.replace(/^data:image\/png;base64,/, "");
  }

  async act(action: ComputerAction): Promise<void> {
    const { tool, arguments: args } = mapActionToMcp(action);
    await this.mcp(tool, args);
  }
}

export class LiveW365AProvider implements W365AProvider {
  constructor(private readonly config: RunnerConfig) {}

  async checkout(): Promise<{ session: W365ASession; computer: CloudPcComputer }> {
    const token = await getToken(this.config.w365a.scope, this.config.auth);
    const url = `${this.config.w365a.baseUrl}/api/pools/${encodeURIComponent(this.config.w365a.poolId)}/sessions?api-version=${this.config.w365a.sessionApiVersion}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
    if (!res.ok) {
      throw new Error(`W365A checkout failed: HTTP ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const sessionId = (body.sessionId as string) ?? (body.id as string);
    const computerId = (body.computerId as string) ?? (body.computerName as string);
    if (!sessionId || !computerId) {
      throw new Error("W365A checkout response missing sessionId/computerId (verify the session API shape).");
    }
    const session: W365ASession = { sessionId, computerId, connection: body };
    return { session, computer: new LiveCloudPcComputer(this.config, computerId) };
  }

  async checkin(session: W365ASession): Promise<void> {
    const token = await getToken(this.config.w365a.scope, this.config.auth);
    const url = `${this.config.w365a.baseUrl}/api/sessions/${encodeURIComponent(session.sessionId)}?api-version=${this.config.w365a.sessionApiVersion}`;
    const res = await fetch(url, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok && res.status !== 404) {
      throw new Error(`W365A checkin failed: HTTP ${res.status} ${await res.text()}`);
    }
  }
}

// --------------------------------------------------------------------------
// Simulation provider - no Azure calls. Records actions and returns a tiny PNG.
// --------------------------------------------------------------------------

/** 1x1 transparent PNG (base64), enough to satisfy the screenshot contract. */
const BLANK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export class SimulatedCloudPcComputer implements CloudPcComputer {
  readonly actions: ComputerAction[] = [];
  launched: string | null = null;

  async launch(command: string): Promise<void> {
    this.launched = command;
  }

  async screenshot(): Promise<string> {
    return BLANK_PNG_BASE64;
  }

  async act(action: ComputerAction): Promise<void> {
    this.actions.push(action);
  }
}

export class SimulationW365AProvider implements W365AProvider {
  readonly computers: SimulatedCloudPcComputer[] = [];
  checkedIn: string[] = [];

  // Accepts (and ignores) a config for symmetry with the live provider.
  constructor(_config?: RunnerConfig) {}

  async checkout(): Promise<{ session: W365ASession; computer: CloudPcComputer }> {
    const n = this.computers.length + 1;
    const computer = new SimulatedCloudPcComputer();
    this.computers.push(computer);
    return {
      session: { sessionId: `sim-session-${n}`, computerId: `sim-cpc-${n}` },
      computer
    };
  }

  async checkin(session: W365ASession): Promise<void> {
    this.checkedIn.push(session.sessionId);
  }
}

export function createW365AProvider(config: RunnerConfig): W365AProvider {
  return config.mode === "live" ? new LiveW365AProvider(config) : new SimulationW365AProvider(config);
}
