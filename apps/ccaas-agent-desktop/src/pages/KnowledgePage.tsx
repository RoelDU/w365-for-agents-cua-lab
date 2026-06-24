import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { KB_ARTICLES } from "@/mocks/kbArticles";

export function KnowledgePage() {
  const [q, setQ] = React.useState("");
  const filtered = React.useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return KB_ARTICLES;
    return KB_ARTICLES.filter(
      (a) =>
        a.title.toLowerCase().includes(needle) ||
        a.excerpt.toLowerCase().includes(needle) ||
        a.category.toLowerCase().includes(needle)
    );
  }, [q]);

  return (
    <div className="p-3">
      <Card>
        <CardHeader>
          <CardTitle>Knowledge base</CardTitle>
          <Input
            data-testid="kb-search"
            placeholder="Search knowledge…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="max-w-xs"
            aria-label="Search knowledge base"
          />
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {filtered.map((a) => (
              <li key={a.id} className="py-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold text-slate-100">{a.title}</div>
                  <span className="rounded border border-border bg-bg-800 px-1.5 py-0.5 text-xxs uppercase tracking-wider text-muted-400">
                    {a.category}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-400">{a.excerpt}</p>
              </li>
            ))}
            {filtered.length === 0 && (
              <li className="py-3 text-xs text-muted-500">No articles match your search.</li>
            )}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
