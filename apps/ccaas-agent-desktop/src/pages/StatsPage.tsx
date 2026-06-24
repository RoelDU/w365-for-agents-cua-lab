import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { TODAY_KPIS } from "@/mocks/queueStats";
import { formatMmSs } from "@/lib/format";

interface Kpi {
  label: string;
  value: string;
  hint: string;
}

function buildKpis() {
  const k = TODAY_KPIS;
  const kpis: Kpi[] = [
    {
      label: "AHT",
      value: formatMmSs(k.aht_seconds),
      hint: "Average Handle Time = talk + hold + wrap-up, last 24h"
    },
    {
      label: "ASA",
      value: `0:${String(k.asa_seconds).padStart(2, "0")}`,
      hint: "Average Speed of Answer, last 30 min"
    },
    {
      label: "Service level",
      value: `${k.service_level_pct}%`,
      hint: "% of calls answered within 20s, last 30 min"
    },
    {
      label: "Adherence",
      value: `${k.adherence_pct}%`,
      hint: "% of scheduled time in productive aux states, today"
    },
    {
      label: "Calls today",
      value: String(k.calls_today),
      hint: "Total inbound interactions handled today"
    },
    {
      label: "ACW",
      value: formatMmSs(k.acw_seconds),
      hint: "Average after-call work time today"
    }
  ];
  return kpis;
}

export function StatsPage() {
  const kpis = buildKpis();
  return (
    <div className="p-3">
      <Card>
        <CardHeader>
          <CardTitle>Operational statistics</CardTitle>
          <div className="text-xxs text-muted-400">Simulated metrics</div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {kpis.map((k) => (
              <div
                key={k.label}
                data-testid={`kpi-${k.label.replace(/\s/g, "-").toLowerCase()}`}
                className="rounded-md border border-border bg-bg-800 p-3"
                title={k.hint}
              >
                <div className="text-xxs uppercase tracking-wider text-muted-400">
                  {k.label}
                </div>
                <div className="mt-1 font-mono text-2xl tabular-nums text-slate-100">
                  {k.value}
                </div>
                <div className="mt-1 text-xxs text-muted-500">{k.hint}</div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
