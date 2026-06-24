import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RECENT_INTERACTIONS } from "@/mocks/interactions";

export function InteractionsPage() {
  return (
    <div className="p-3">
      <Card>
        <CardHeader>
          <CardTitle>Recent interactions</CardTitle>
          <div className="text-xxs text-muted-400">Last 24 hours · simulated data</div>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xxs uppercase tracking-wider text-muted-400">
                <th className="px-2 py-1.5 text-left">When</th>
                <th className="px-2 py-1.5 text-left">Caller</th>
                <th className="px-2 py-1.5 text-left">Channel</th>
                <th className="px-2 py-1.5 text-left">Queue</th>
                <th className="px-2 py-1.5 text-left">Duration</th>
                <th className="px-2 py-1.5 text-left">Disposition</th>
              </tr>
            </thead>
            <tbody>
              {RECENT_INTERACTIONS.map((row) => (
                <tr key={row.id} className="border-b border-border/60">
                  <td className="px-2 py-1.5 text-slate-200">{row.when}</td>
                  <td className="px-2 py-1.5 text-slate-100">{row.caller}</td>
                  <td className="px-2 py-1.5 text-slate-200">{row.channel}</td>
                  <td className="px-2 py-1.5 text-slate-200">{row.queue}</td>
                  <td className="px-2 py-1.5 font-mono text-slate-200">{row.duration}</td>
                  <td className="px-2 py-1.5 text-slate-200">{row.disposition}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
