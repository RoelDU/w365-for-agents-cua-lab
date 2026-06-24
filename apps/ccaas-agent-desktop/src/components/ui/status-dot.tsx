import { cn } from "@/lib/cn";

interface StatusDotProps {
  variant: "ok" | "warn" | "danger" | "muted" | "info";
  pulse?: boolean;
  className?: string;
  "aria-label"?: string;
}

export function StatusDot({ variant, pulse, className, ...rest }: StatusDotProps) {
  const color =
    variant === "ok"
      ? "bg-ok-500"
      : variant === "warn"
        ? "bg-warn-500"
        : variant === "danger"
          ? "bg-danger-500"
          : variant === "info"
            ? "bg-accent-500"
            : "bg-muted-500";
  return (
    <span
      {...rest}
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        color,
        pulse && "animate-pulse-dot",
        className
      )}
    />
  );
}
