"use client";

import { Check, TriangleAlert, X } from "lucide-react";
import { badgeKind, type TemplateBadgeKind } from "@/app/documents/documentsModel";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import type { TemplateStatus } from "@/lib/docLibrary/templatesStore";

/**
 * ✓ «Plantilla lista (1 y 2 firmantes)» / ✓ «Plantilla de 1 firmante» (parcial) / ✗ «Sin plantilla». El estado nunca va
 * solo en el color: lleva icono distinto Y texto. Parte en lineas (fuentes anchas, 320 px) en vez de desbordar.
 */
export function TemplateBadge({ status, stale = false, className }: { status: Pick<TemplateStatus, "state"> | undefined; stale?: boolean; className?: string }) {
  const t = useT();
  const kind: TemplateBadgeKind = badgeKind(status, stale);
  const text =
    kind === "ready" ? t.documents.statusReady : kind === "single" ? t.documents.statusSingle : kind === "stale" ? t.documents.statusStale : t.documents.statusNone;
  return (
    <span
      data-template-state={kind}
      className={cn(
        "inline-flex max-w-full items-start gap-1.5 text-footnote font-medium",
        kind === "ready" ? "text-success-text" : kind === "single" || kind === "stale" ? "text-foreground" : "text-muted-foreground",
        className,
      )}
    >
      {kind === "none" ? (
        <X aria-hidden="true" strokeWidth={2.5} className="mt-[3px] size-3.5 shrink-0" />
      ) : kind === "stale" ? (
        <TriangleAlert aria-hidden="true" strokeWidth={2.5} className="mt-[3px] size-3.5 shrink-0 text-accent-edit" />
      ) : (
        <Check
          aria-hidden="true"
          strokeWidth={2.5}
          className={cn("mt-[3px] size-3.5 shrink-0", kind === "single" && "text-accent-edit")}
        />
      )}
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </span>
  );
}
