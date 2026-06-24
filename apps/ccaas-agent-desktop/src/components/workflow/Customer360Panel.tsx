import { useCallStore } from "@/stores/useCallStore";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger
} from "@/components/ui/tabs";
import { useT, useLang } from "@/stores/useLangStore";
import {
  sentimentLabel,
  channelLabel,
  policyTypeLabel,
  policyStatusLabel
} from "@/lib/format";

const TAB_VALUES = ["overview", "policies", "claims", "notes", "interactions"] as const;

export function Customer360Panel() {
  const t = useT();
  const lang = useLang();
  const scenario = useCallStore((s) => s.scenario);
  const phase = useCallStore((s) => s.phase);
  const notes = useCallStore((s) => s.notes);
  const setNotes = useCallStore((s) => s.setNotes);

  if (phase === "idle" || !scenario) {
    return (
      <Card data-testid="customer-360-panel" className="flex h-full flex-col">
        <CardHeader>
          <CardTitle>{t("c360.title")}</CardTitle>
          <Badge variant="muted">{t("c360.noScreenPop")}</Badge>
        </CardHeader>
        <CardContent className="flex flex-1 items-center justify-center text-center">
          <div>
            <div className="text-sm text-muted-400">
              {t("c360.emptyState")}
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  const customer = scenario.customer;

  return (
    <Card data-testid="customer-360-panel" className="flex h-full flex-col">
      <CardHeader>
        <div className="flex items-center gap-3">
          <span
            className="flex h-9 w-9 items-center justify-center rounded-full bg-bg-600 text-sm font-semibold text-slate-100"
            aria-hidden
          >
            {customer.display_name
              .split(/\s+/)
              .map((p) => p[0])
              .slice(0, 2)
              .join("")}
          </span>
          <div className="leading-tight">
            <div
              data-testid="customer360-name"
              className="text-sm font-semibold text-slate-100"
            >
              {customer.display_name}
            </div>
            <div className="text-xxs text-muted-400">
              {t("c360.customerSince", { date: customer.customer_since })}
            </div>
          </div>
        </div>
        <Badge variant="accent">{t("c360.verifiedCaller")}</Badge>
      </CardHeader>
      <Tabs defaultValue="overview" className="flex flex-1 flex-col">
        <TabsList>
          {TAB_VALUES.map((v) => (
            <TabsTrigger key={v} value={v} data-testid={`c360-tab-${v}`}>
              {t(`tab.${v}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="flex-1 overflow-auto">
          <TabsContent value="overview">
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label={t("field.phone")} value={customer.phone} mono />
              <Field label={t("field.email")} value={customer.email} />
              <Field label={t("field.address")} value={customer.address} className="sm:col-span-2" />
              <Field label={t("field.preferredChannel")} value={channelLabel(customer.preferred_channel, lang)} />
              <Field label={t("field.clv")} value={customer.clv} />
              <Field label={t("field.sentiment")} value={sentimentLabel(customer.sentiment, lang)} />
            </dl>
          </TabsContent>
          <TabsContent value="policies">
            <Table
              testId="c360-policies-table"
              headers={[t("th.policyNumber"), t("th.type"), t("th.status"), t("th.premium")]}
              rows={customer.policies.map((p) => [
                p.number,
                policyTypeLabel(p.type, lang),
                policyStatusLabel(p.status, lang),
                p.premium
              ])}
            />
          </TabsContent>
          <TabsContent value="claims">
            {customer.claims.length === 0 ? (
              <p className="text-sm text-muted-400">{t("c360.noClaims")}</p>
            ) : (
              <Table
                testId="c360-claims-table"
                headers={[t("th.claimId"), t("th.type"), t("th.status"), t("th.date"), t("th.amount")]}
                rows={customer.claims.map((c) => [
                  c.claim_id,
                  c.type,
                  policyStatusLabel(c.status, lang),
                  c.date,
                  c.amount
                ])}
              />
            )}
          </TabsContent>
          <TabsContent value="notes">
            <textarea
              data-testid="c360-notes-textarea"
              className="min-h-[160px] w-full rounded-md border border-border bg-bg-800 px-3 py-2 text-sm text-slate-100"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              aria-label={t("c360.notesAria")}
            />
            <p className="mt-1 text-xxs text-muted-500">
              {t("c360.notesInMemory")}
            </p>
          </TabsContent>
          <TabsContent value="interactions">
            <Table
              testId="c360-interactions-table"
              headers={[t("th.when"), t("th.channel"), t("th.summary")]}
              rows={customer.interactions.map((i) => [i.when, channelLabel(i.channel, lang), i.summary])}
            />
          </TabsContent>
        </div>
      </Tabs>
    </Card>
  );
}

function Field({
  label,
  value,
  className,
  mono
}: {
  label: string;
  value: string;
  className?: string;
  mono?: boolean;
}) {
  return (
    <div className={className}>
      <dt className="text-xxs uppercase tracking-wider text-muted-400">{label}</dt>
      <dd className={mono ? "font-mono text-sm text-slate-100" : "text-sm text-slate-100"}>
        {value}
      </dd>
    </div>
  );
}

function Table({
  headers,
  rows,
  testId
}: {
  headers: string[];
  rows: Array<Array<string | number>>;
  testId: string;
}) {
  return (
    <table data-testid={testId} className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-xxs uppercase tracking-wider text-muted-400">
          {headers.map((h) => (
            <th key={h} className="px-2 py-1.5 text-left font-medium">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-b border-border/60 last:border-0">
            {row.map((cell, j) => (
              <td key={j} className="px-2 py-1.5 text-slate-200">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
