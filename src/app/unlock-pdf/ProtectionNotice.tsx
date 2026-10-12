"use client";

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

/** Bloque explicativo con icono, del mismo formato para los cuatro casos. */
export function ProtectionNotice({
  icon: Icon,
  tone,
  title,
  body,
  children,
}: {
  icon: LucideIcon;
  tone: "security" | "warning" | "neutral";
  title: string;
  body: string;
  children?: ReactNode;
}) {
  const iconClass =
    tone === "warning"
      ? "text-destructive"
      : tone === "security"
        ? "text-accent-security"
        : "text-muted-foreground";

  return (
    <div className="flex items-start gap-3">
      <Icon
        aria-hidden="true"
        className={cn("mt-0.5 size-5 shrink-0", iconClass)}
      />
      <div className="min-w-0">
        <h3 className="text-headline text-foreground">{title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {body}
        </p>
        {children}
      </div>
    </div>
  );
}

