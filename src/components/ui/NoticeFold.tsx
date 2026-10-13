"use client";

import { useId, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type ReactNode } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Varios avisos apilados plegados en UNA linea resumen («2 avisos»), expandible (B1).
 *
 * Con un solo aviso no hace falta plegar nada: quien lo usa pinta ese aviso como siempre. Con dos o mas, la linea
 * ocupa lo de un renglon y el texto completo de TODOS sigue en el documento:
 *
 *  - Plegado, la lista queda solo para lectores de pantalla (`sr-only`: sigue leyendose entera, sin tener que
 *    expandir nada); expandido, se ve en el sitio y empuja el resto.
 *  - El boton lleva `aria-expanded` y `aria-controls`; el foco se queda en el boton al abrir y al cerrar, y Escape
 *    cierra (y no sale de donde se esta: se queda el evento aqui) devolviendo el foco al boton.
 *  - No es una region viva: abrir o cerrar no anuncia nada por si mismo. Los avisos que cambian se anuncian por la
 *    region unica de cada pantalla, no por esta.
 *
 * `children` recibe `open` para que la lista pueda pintar el texto completo solo al expandir.
 */
export function NoticeFold({
  summary,
  children,
  icon,
  className,
  buttonClassName,
  dense = false,
  defaultOpen = false,
  ...rest
}: {
  /** Texto de la linea resumen, p. ej. «2 avisos». */
  summary: ReactNode;
  /** La lista de avisos; recibe si esta expandida. */
  children: (open: boolean) => ReactNode;
  /** Icono de la izquierda; por defecto un triangulo de aviso. */
  icon?: ReactNode;
  className?: string;
  buttonClassName?: string;
  /** Linea de 24 px (44 con puntero grueso) en vez de 44 px siempre: para barras donde cada pixel cuenta. */
  dense?: boolean;
  defaultOpen?: boolean;
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "className">) {
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();
  const buttonId = useId();

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || !open) return;
    // Escape cierra el desplegable y se queda aqui: no debe ademas salir de la pantalla que lo contiene.
    event.preventDefault();
    event.stopPropagation();
    setOpen(false);
    document.getElementById(buttonId)?.focus({ preventScroll: true });
  };

  return (
    <div
      {...rest}
      data-notice-fold=""
      data-open={open ? "" : undefined}
      onKeyDown={onKeyDown}
      className={cn("min-w-0", open && "basis-full", className)}
    >
      <button
        id={buttonId}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "inline-flex max-w-full cursor-pointer select-none items-center gap-1.5 rounded-ios-sm px-1 text-footnote text-foreground",
          dense ? "min-h-6 pointer-coarse:min-h-11" : "min-h-11",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
          buttonClassName,
        )}
      >
        {icon ?? <AlertTriangle aria-hidden="true" className="size-4 shrink-0 text-accent-edit" />}
        <span className="min-w-0 truncate">{summary}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-4 shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none", open && "rotate-180")}
        />
      </button>
      <div id={panelId} data-notice-fold-panel="" className={open ? "w-full pb-1" : "sr-only"}>
        {children(open)}
      </div>
    </div>
  );
}
