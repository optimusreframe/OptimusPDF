"use client";

import Link from "next/link";
import { Clock } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  ACCENT_BG_SOFT,
  ACCENT_TEXT,
  toolHref,
  type Tool,
} from "@/lib/tools-registry";

export type ToolIconTileProps = {
  tool: Tool;
  className?: string;
};

/**
 * Icono estilo pantalla de inicio de iOS: cuadro de color + etiqueta corta
 * debajo, sin descripcion. Pensado para grids densos en movil, como
 * alternativa a `ToolCard` cuando no hay espacio para una tarjeta ancha.
 */
export function ToolIconTile({ tool, className }: ToolIconTileProps) {
  const t = useT();
  const Icon = tool.icon;
  const copy = t.tools[tool.slug];

  return (
    <Link
      href={toolHref(tool.slug)}
      className={cn(
        "group flex flex-col items-center gap-1.5 text-center",
        className,
      )}
    >
      <span
        className={cn(
          "relative flex aspect-square w-full items-center justify-center rounded-[22%] transition-transform duration-150 ease-spring",
          "group-active:scale-90",
          ACCENT_BG_SOFT[tool.accent],
          tool.status === "soon" && "opacity-55",
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn("size-[40%]", ACCENT_TEXT[tool.accent])}
        />
        {tool.status === "soon" ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full border-2 border-background bg-white/25 text-foreground"
          >
            <Clock aria-hidden="true" className="size-2.5" />
          </span>
        ) : null}
      </span>
      <span className="line-clamp-2 text-[11px] leading-tight font-medium text-foreground">
        {copy.name}
      </span>
      {tool.status === "soon" ? (
        <span className="sr-only">{t.common.soon}</span>
      ) : null}
    </Link>
  );
}
