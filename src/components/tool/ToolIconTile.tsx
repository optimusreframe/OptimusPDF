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
 * El tile responde en pointerdown (escala 0.9) como un icono de app.
 */
export function ToolIconTile({ tool, className }: ToolIconTileProps) {
  const t = useT();
  const Icon = tool.icon;
  const copy = t.tools[tool.slug];
  const soon = tool.status === "soon";

  return (
    <Link
      href={toolHref(tool.slug)}
      className={cn(
        "group flex flex-col items-center gap-1.5 rounded-ios-sm text-center",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
        className,
      )}
    >
      <span
        className={cn(
          // Tope de 5 rem: con 3 columnas a 320 px (90 px cada una) el icono no pasa de 80 px, como un icono de iOS.
          "relative flex aspect-square w-full max-w-[5rem] items-center justify-center rounded-[22%]",
          "transition-[scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
          "group-active:scale-90 group-active:duration-[80ms]",
          ACCENT_BG_SOFT[tool.accent],
          soon && "opacity-55",
        )}
      >
        <Icon
          aria-hidden="true"
          className={cn("size-[40%]", ACCENT_TEXT[tool.accent])}
        />
        {soon ? (
          <span
            aria-hidden="true"
            className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full border-2 border-background bg-white/25 text-foreground"
          >
            <Clock aria-hidden="true" className="size-2.5" />
          </span>
        ) : null}
      </span>
      {/*
        La etiqueta NUNCA se corta (antes `line-clamp-2` escondia la ultima palabra de «Extraer audio de un video» y
        «Convertidor de imágenes» a 320 px): parte en las lineas que haga falta, repartidas con `text-balance`, y solo una palabra
        mas ancha que su columna se parte (`break-words`; sin guiones automaticos: «Elimi-nar» se leia peor que dos lineas).
      */}
      <span className="max-w-full text-caption leading-tight font-medium break-words text-balance text-foreground">
        {copy.name}
      </span>
      {soon ? <span className="sr-only">{t.common.soon}</span> : null}
    </Link>
  );
}
