import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xxs font-medium uppercase tracking-wide",
  {
    variants: {
      variant: {
        default: "bg-bg-600 text-slate-200",
        accent: "bg-accent-500/15 text-accent-400 border border-accent-500/30",
        warn: "bg-warn-500/15 text-warn-400 border border-warn-500/30",
        danger: "bg-danger-500/15 text-danger-500 border border-danger-500/30",
        ok: "bg-ok-500/15 text-ok-500 border border-ok-500/30",
        muted: "bg-bg-700 text-muted-400 border border-border"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}
