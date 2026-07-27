import { LoaderCircle } from "lucide-react";
import { cn } from "@/lib/cn";

export type SpinnerProps = {
  className?: string;
  label?: string;
};

export function Spinner({ className, label }: SpinnerProps) {
  return (
    <LoaderCircle
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      role={label ? "status" : undefined}
      className={cn("size-5 animate-spin text-signal", className)}
    />
  );
}
