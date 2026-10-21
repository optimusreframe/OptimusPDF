"use client";

import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { LucideIcon } from "lucide-react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import { paletteItemClass } from "@/app/sign-pdf/ToolPalette";

/*
 * Paleta de herramientas del editor de PDF (W5-U4a).
 *
 * DECISION: paleta propia que reutiliza el aspecto de `sign-pdf/ToolPalette`
 * (`paletteItemClass`) en vez de abrir esa a una lista generica. `ToolPalette`
 * lleva firmante, "campo anterior/siguiente" y 156+ tests del lienzo de Firmar
 * colgando de su contrato; esta recibe una lista generica `{id, icon, label,
 * shortcut}` y acciones (deshacer/rehacer), y U4b solo anade herramientas a la
 * lista.
 *
 * Patron APG "toolbar": un unico `role="toolbar"` con tabindex itinerante (una
 * parada de Tab; flechas, Inicio y Fin mueven el foco). Las herramientas son
 * botones con `aria-pressed`. Las acciones usan `aria-disabled` (no `disabled`):
 * al agotar el historial el boton sigue enfocable y el foco no cae a <body>.
 */

export type PaletteTool = {
  id: string;
  icon: LucideIcon;
  label: string;
  /** Atajo de una letra (se muestra en mayusculas y va en `aria-keyshortcuts`). */
  shortcut: string;
};

export type PaletteAction = {
  id: string;
  icon: LucideIcon;
  label: string;
  /** Valor de `aria-keyshortcuts`, p. ej. "Control+Z Meta+Z". */
  keyShortcuts?: string;
  /** Texto del atajo para el tooltip, p. ej. "Ctrl+Z". */
  shortcutLabel?: string;
  disabled: boolean;
  onClick: () => void;
};

export type EditToolPaletteProps = {
  tool: string;
  tools: readonly PaletteTool[];
  onToolChange: (id: string) => void;
  actions: readonly PaletteAction[];
  label: string;
  className?: string;
  /** (W10-C-A3) Variables CSS de colocacion que mide quien la monta (p. ej. `--edit-palette-bottom`). */
  style?: CSSProperties;
  /**
   * (M6 · b) Bandeja del telefono: UNA fila desplazable en horizontal (sin tarjeta propia: la bandeja ya la tiene), con un
   * desvanecido en el borde que tiene mas herramientas por ver y la herramienta activa a la vista al abrirla.
   */
  scrollRow?: boolean;
};

/** Margen (px) bajo el cual el desplazamiento de la fila cuenta como «al borde». */
const EDGE_EPSILON = 2;

export function EditToolPalette({
  tool,
  tools,
  onToolChange,
  actions,
  label,
  className,
  style,
  scrollRow = false,
}: EditToolPaletteProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<{ start: boolean; end: boolean }>({ start: false, end: false });
  const vertical = useMediaQuery("(min-width: 768px)");
  const keys = [...tools.map((item) => item.id), ...actions.map((item) => item.id)];

  const [focusKey, setFocusKey] = useState<string | null>(null);
  const stop = focusKey && keys.includes(focusKey) ? focusKey : tool;

  useEffect(() => {
    // Un cambio de herramienta desde fuera (atajo) recoloca la parada.
    if (!rootRef.current?.contains(document.activeElement)) setFocusKey(null);
  }, [tool]);

  /* (M6 · b) Fila desplazable: marca de que borde queda mas por ver (desvanecido) y deja la herramienta activa a la vista. */
  useEffect(() => {
    const element = rootRef.current;
    if (!scrollRow || !element) return;
    const measure = () => {
      const start = element.scrollLeft > EDGE_EPSILON;
      const end = element.scrollLeft + element.clientWidth < element.scrollWidth - EDGE_EPSILON;
      setEdges((previous) => (previous.start === start && previous.end === end ? previous : { start, end }));
    };
    const centerActive = () => {
      const active = element.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!active || element.clientWidth === 0) return;
      const box = element.getBoundingClientRect();
      const at = active.getBoundingClientRect();
      element.scrollLeft += at.left - box.left - (element.clientWidth - at.width) / 2;
    };
    centerActive();
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      // Al abrir la bandeja (de `display: none` a visible) la fila vuelve a medir y a centrar la herramienta activa.
      centerActive();
      measure();
    }) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, [scrollRow, tool, tools.length, actions.length]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = keys.indexOf(
      (document.activeElement as HTMLElement | null)?.dataset.paletteItem ?? "",
    );
    if (current === -1) return;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (current + 1) % keys.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (current - 1 + keys.length) % keys.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = keys.length - 1;
    }
    if (next === -1) return;
    event.preventDefault();
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-palette-item="${keys[next]}"]`)
      ?.focus();
  };

  const firstTool = tools[0]?.id;

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label={label}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      data-tool-palette=""
      style={style}
      onKeyDown={onKeyDown}
      className={cn(
        scrollRow
          ? "flex items-center gap-2 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          : "material-thick shadow-elevation-2 rounded-ios p-1 flex items-center md:flex-col md:gap-0.5 pointer-coarse:md:gap-2",
        scrollRow && edges.end && !edges.start && "[mask-image:linear-gradient(to_right,black_calc(100%-1.75rem),transparent)]",
        scrollRow && edges.start && !edges.end && "[mask-image:linear-gradient(to_left,black_calc(100%-1.75rem),transparent)]",
        scrollRow && edges.start && edges.end && "[mask-image:linear-gradient(to_right,transparent,black_1.75rem,black_calc(100%-1.75rem),transparent)]",
        className,
      )}
    >
      {tools.map((item) => {
        const Icon = item.icon;
        const active = item.id === tool;
        const shortcut = item.shortcut.toUpperCase();
        return (
          <button
            key={item.id}
            type="button"
            data-palette-item={item.id}
            aria-pressed={active}
            aria-label={item.label}
            aria-keyshortcuts={shortcut}
            title={`${item.label} (${shortcut})`}
            tabIndex={stop === item.id ? 0 : -1}
            onFocus={() => setFocusKey(item.id)}
            onClick={() =>
              onToolChange(active && item.id !== firstTool ? (firstTool ?? item.id) : item.id)
            }
            className={cn(paletteItemClass(active), scrollRow && "w-11 flex-none")}
          >
            <Icon aria-hidden="true" className="size-5" />
          </button>
        );
      })}

      {actions.length > 0 ? (
        <span
          role="separator"
          aria-orientation={vertical ? "horizontal" : "vertical"}
          className="mx-0.5 h-6 w-px shrink-0 bg-hairline md:mx-0 md:my-0.5 md:h-px md:w-6"
        />
      ) : null}

      {actions.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            type="button"
            data-palette-item={action.id}
            aria-label={action.label}
            aria-keyshortcuts={action.keyShortcuts}
            aria-disabled={action.disabled}
            title={
              action.shortcutLabel ? `${action.label} (${action.shortcutLabel})` : action.label
            }
            tabIndex={stop === action.id ? 0 : -1}
            onFocus={() => setFocusKey(action.id)}
            onClick={() => {
              if (!action.disabled) action.onClick();
            }}
            className={cn(paletteItemClass(false, action.disabled), scrollRow && "w-11 flex-none")}
          >
            <Icon aria-hidden="true" className="size-5" />
          </button>
        );
      })}
    </div>
  );
}
