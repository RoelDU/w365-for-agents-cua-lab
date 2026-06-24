import { NavLink } from "react-router-dom";
import { Phone, History, BookOpen, BarChart3, Settings } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/stores/useLangStore";

const NAV_ITEMS = [
  { to: "/workspace", icon: Phone, labelKey: "nav.calls", testid: "nav-calls" },
  { to: "/workspace/interactions", icon: History, labelKey: "nav.interactions", testid: "nav-interactions" },
  { to: "/workspace/knowledge", icon: BookOpen, labelKey: "nav.knowledge", testid: "nav-knowledge" },
  { to: "/workspace/stats", icon: BarChart3, labelKey: "nav.stats", testid: "nav-stats" },
  { to: "/settings", icon: Settings, labelKey: "nav.settings", testid: "nav-settings" }
];

export function LeftNav() {
  const t = useT();
  return (
    <nav
      data-testid="leftnav"
      className="flex w-44 shrink-0 flex-col border-r border-border bg-bg-800/80"
      aria-label="Primary"
    >
      <ul className="flex flex-col gap-0.5 p-2">
        {NAV_ITEMS.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.to === "/workspace"}
              data-testid={item.testid}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-md px-2 py-2 text-sm",
                  isActive
                    ? "bg-accent-500/10 text-accent-400"
                    : "text-slate-200 hover:bg-bg-700"
                )
              }
            >
              <item.icon className="h-4 w-4" aria-hidden="true" />
              <span>{t(item.labelKey)}</span>
            </NavLink>
          </li>
        ))}
      </ul>
      <div className="mt-auto p-2 text-xxs uppercase tracking-wider text-muted-500">
        {t("nav.demoBuild")}
      </div>
    </nav>
  );
}
