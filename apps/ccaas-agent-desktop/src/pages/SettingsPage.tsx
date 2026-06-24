import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useCallStore } from "@/stores/useCallStore";
import { useHandoffStore } from "@/stores/useHandoffStore";
import { useToastsStore } from "@/stores/useToastsStore";
import { buildVersion } from "@/lib/env";
import { resetRequestIdCounter } from "@/lib/payloadBuilder";

export function SettingsPage() {
  const orchestratorUrl = useSettingsStore((s) => s.orchestratorUrl);
  const setOrchestratorUrl = useSettingsStore((s) => s.setOrchestratorUrl);
  const cuaMode = useSettingsStore((s) => s.cuaMode);
  const setCuaMode = useSettingsStore((s) => s.setCuaMode);
  const cps = useSettingsStore((s) => s.typewriterCps);
  const setCps = useSettingsStore((s) => s.setTypewriterCps);
  const resetSettings = useSettingsStore((s) => s.resetToDefaults);
  const regions = useSettingsStore((s) => s.regions);
  const activeRegionId = useSettingsStore((s) => s.activeRegionId);
  const setActiveRegion = useSettingsStore((s) => s.setActiveRegion);

  const resetCall = useCallStore((s) => s.reset);
  const resetHandoff = useHandoffStore((s) => s.reset);
  const push = useToastsStore((s) => s.push);

  return (
    <div className="grid gap-3 p-3 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Authentication</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p className="text-xs text-muted-400">
            This app uses <span className="font-medium text-slate-100">Microsoft Entra ID</span> sign-in
            (MSAL). Configure the app registration via the{" "}
            <code className="rounded bg-bg-800 px-1">VITE_AZURE_*</code> variables or the served{" "}
            <code className="rounded bg-bg-800 px-1">/entra-config.json</code>.
          </p>
        </CardContent>
      </Card>

      {regions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>CUA region</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <div>
              <label className="mb-1 block text-xxs uppercase tracking-wider text-muted-400">
                Live agent desktop region
              </label>
              <Select
                data-testid="settings-region-select"
                value={activeRegionId}
                onChange={(e) => setActiveRegion(e.target.value)}
                className="w-full"
              >
                {regions.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-xs text-muted-400">
              The Windows 365 Cloud PC that the AI agent drives runs in this
              region. Set the default at deploy time in{" "}
              <code className="rounded bg-bg-800 px-1">/region-config.json</code>;
              switching here needs no rebuild.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Orchestrator</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <label className="mb-1 block text-xxs uppercase tracking-wider text-muted-400">
              URL
            </label>
            <Input
              data-testid="settings-orchestrator-url"
              value={orchestratorUrl}
              onChange={(e) => setOrchestratorUrl(e.target.value)}
              placeholder="/api"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Demo playback</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Row label="CUA-friendly mode">
            <label className="inline-flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                data-testid="settings-cua-toggle"
                checked={cuaMode}
                onChange={(e) => setCuaMode(e.target.checked)}
                className="h-4 w-4 accent-accent-500"
              />
              Instant transcript, fast polling, auto-confirm handoff
            </label>
          </Row>
          <Row label="Typewriter speed (cps)">
            <input
              type="range"
              data-testid="settings-typewriter-slider"
              min={8}
              max={120}
              value={cps}
              onChange={(e) => setCps(parseInt(e.target.value, 10))}
              className="w-40"
              aria-label="Typewriter speed in characters per second"
            />
            <span className="ml-2 font-mono text-xs text-slate-100">{cps}</span>
          </Row>
          <Button
            variant="secondary"
            data-testid="settings-reset"
            onClick={() => {
              resetSettings();
              resetCall();
              resetHandoff();
              resetRequestIdCounter();
              push({
                variant: "info",
                title: "Demo state reset",
                description: "Call, handoff, and settings restored to defaults.",
                toastId: "toast-reset-done"
              });
            }}
          >
            Reset demo state
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <Row label="Build">
            <span className="font-mono">{buildVersion()}</span>
          </Row>
          <Row label="Brand">Zava Contact Center — Agent Workspace</Row>
          <p className="text-xs text-muted-400">
            Demonstration build — fictional contact center. Not connected to a
            real telephony or CCaaS provider.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-1.5 last:border-b-0">
      <span className="text-xxs uppercase tracking-wider text-muted-400">{label}</span>
      <span className="text-sm text-slate-100">{children}</span>
    </div>
  );
}
