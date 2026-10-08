"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  toolHref,
  type Tool,
} from "@/lib/tools-registry";

export type ToolCardProps = {
  tool: Tool;
  compact?: boolean;
  className?: string;
};

/*
 * Tarjeta del catalogo sobre superficie solida (sin blur: se repite hasta
 * 36 veces por pantalla). Jerarquia: tile de color de la categoria,
 * nombre, descripcion corta y, solo cuando toca, el estado honesto
 * "Proximamente" con el tile atenuado. Al pasar el puntero se aclara
 * (borde y fondo, sin animar) y se hunde a 0.99 al presionar (pointerdown).
 */
export function ToolCard({ tool, compact = false, className }: ToolCardProps) {
  const t = useT();
  const Icon = tool.icon;
  const copy = t.tools[tool.slug];
  const soon = tool.status === "soon";

  return (
    <Link
      href={toolHref(tool.slug)}
      className={cn(
        "surface-card group flex flex-col rounded-ios p-4",
        // Hover sin elevacion ni transicion: con 36 tarjetas solidas, animar
        // translate/sombra bajo el puntero mientras se hace scroll promovia y
        // repintaba capas en cada frame (medido a CPU x4: p95 16 ms -> 10 ms
        // al quitarlo). El hover cambia borde y fondo al instante; la
        // respuesta al presionar (scale 0.99 en pointerdown) se conserva.
        "transition-[scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
        "hover:border-hairline-strong hover:bg-elevated",
        "active:scale-[0.99] active:duration-[80ms]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span
          className={cn(
            "flex size-10 items-center justify-center rounded-ios-sm",
            ACCENT_BG_SOFT[tool.accent],
            soon && "opacity-60",
          )}
        >
          <Icon
            aria-hidden="true"
            className={cn("size-5", ACCENT_TEXT[tool.accent])}
          />
        </span>
        {soon ? <Badge variant="soon">{t.common.soon}</Badge> : null}
      </div>

      <h3
        className={cn(
          "mt-3 text-callout font-semibold text-foreground",
          compact && "mt-2.5",
        )}
      >
        {copy.name}
      </h3>
      {!compact ? (
        <p className="mt-1 text-footnote text-muted-foreground">
          {copy.description}
        </p>
      ) : null}
    </Link>
  );
}
