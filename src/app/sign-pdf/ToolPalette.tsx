"use client";

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  CalendarDays,
  MousePointer2,
  PenLine,
  Signature,
  SquareCheck,
  Type,
} from "lucide-react";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { cn } from "@/lib/cn";
import {
  TOOL_SHORTCUTS,
  type PlacementTool,
} from "@/app/sign-pdf/canvasTools";
import type { SignStrings } from "@/app/sign-pdf/strings";

/*
 * Paleta de herramientas del paso "Documento" (W2-B).
 *
 * Patron APG "toolbar": un unico `role="toolbar"` con tabindex itinerante
 * (una sola parada de Tab; flechas, Inicio y Fin mueven el foco; Enter y
 * Espacio activan). Las herramientas son botones con `aria-pressed`; la
 * activa se vuelve a pulsar para regresar a Seleccionar. Al final van
 * "Campo anterior/siguiente": la alternativa NO precisa a tocar un campo
 * pequeno (WCAG 2.2 · 2.5.8).
 *
 * Escritorio (>= md): carril vertical fijo junto a la pagina. Movil: barra
 * horizontal pegajosa sobre la barra de accion de ToolShell, a todo el ancho
 * para que ocho botones quepan a 44 px en 375 px.
 */

const TOOL_ICONS: Record<PlacementTool, typeof Type> = {
  select: MousePointer2,
  signature: PenLine,
  initials: Signature,
  text: Type,
  checkbox: SquareCheck,
  date: CalendarDays,
};

type ItemKey = PlacementTool | "prev" | "next";

export type ToolPaletteProps = {
  tool: PlacementTool;
  /** Herramientas utilizables ahora, en orden. */
  tools: readonly PlacementTool[];
  onToolChange: (tool: PlacementTool) => void;
  /** Firmante al que se asignaran los huecos nuevos (muestra su color en Firma e Iniciales). */
  owner: { name: string; color: string } | null;
  onPrevField: () => void;
  onNextField: () => void;
  canPrevField: boolean;
  canNextField: boolean;
  strings: SignStrings;
  className?: string;
};

export function ToolPalette({
  tool,
  tools,
  onToolChange,
  owner,
  onPrevField,
  onNextField,
  canPrevField,
  canNextField,
  strings,
  className,
}: ToolPaletteProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const vertical = useMediaQuery("(min-width: 768px)");

  const labelOf = (key: PlacementTool): string => {
    switch (key) {
      case "select":
        return strings.toolSelect;
      case "signature":
        return strings.fieldSignature;
      case "initials":
        return strings.fieldInitials;
      case "text":
        return strings.fieldTypeText;
      case "checkbox":
        return strings.fieldTypeCheckbox;
      case "date":
        return strings.fieldTypeDate;
    }
  };

  /*
   * "Anterior/siguiente" usan `aria-disabled`, no `disabled`: al pulsar
   * "siguiente" en el ultimo campo pendiente el boton se quedaria
   * deshabilitado y el foco caeria a <body>.
   */
  const enabledKeys: ItemKey[] = [...tools, "prev", "next"];

  /* Tabindex itinerante: la parada es el ultimo boton enfocado, o la herramienta activa. */
  const [focusKey, setFocusKey] = useState<ItemKey | null>(null);
  const stop: ItemKey =
    focusKey && enabledKeys.includes(focusKey) ? focusKey : tool;

  useEffect(() => {
    // Un cambio de herramienta desde fuera (atajo, Escape) recoloca la parada.
    if (!rootRef.current?.contains(document.activeElement)) setFocusKey(null);
  }, [tool]);

  const focusItem = (key: ItemKey) => {
    rootRef.current
      ?.querySelector<HTMLElement>(`[data-palette-item="${key}"]`)
      ?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const keys = enabledKeys;
    const current = keys.indexOf(
      (document.activeElement as HTMLElement | null)?.dataset
        .paletteItem as ItemKey,
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
    focusItem(keys[next]);
  };

  const itemClass = (active: boolean, dimmed = false) =>
    cn(
      "relative flex h-11 min-w-11 flex-1 items-center justify-center rounded-ios-sm",
      "md:size-10 md:flex-none md:pointer-coarse:size-11",
      "transition-[background-color,color,scale,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
      "active:scale-[0.92] active:duration-[80ms]",
      "focus-visible:outline-2 focus-visible:outline-offset-[-2px] outline-signal",
      active
        ? "bg-signal/25 text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:bg-[Highlight] forced-colors:text-[HighlightText]"
        : "text-muted-foreground hover:bg-white/8 hover:text-foreground",
      dimmed && "opacity-40",
    );

  return (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label={strings.paletteLabel}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      data-tool-palette=""
      onKeyDown={onKeyDown}
      className={cn(
        "material-thick shadow-elevation-2 rounded-ios p-1",
        "flex items-center md:flex-col md:gap-0.5",
        className,
      )}
    >
      {tools.map((key) => {
        const Icon = TOOL_ICONS[key];
        const active = key === tool;
        const label = labelOf(key);
        const assigns = (key === "signature" || key === "initials") && owner;
        const shortcut = TOOL_SHORTCUTS[key].toUpperCase();
        return (
          <button
            key={key}
            type="button"
            data-palette-item={key}
            aria-pressed={active}
            aria-label={label}
            aria-keyshortcuts={shortcut}
            title={
              assigns
                ? `${label} (${shortcut}) · ${strings.toolAssignedTo(owner.name)}`
                : `${label} (${shortcut})`
            }
            tabIndex={stop === key ? 0 : -1}
            onFocus={() => setFocusKey(key)}
            onClick={() => onToolChange(active && key !== "select" ? "select" : key)}
            className={itemClass(active)}
          >
            <Icon aria-hidden="true" className="size-5" />
            {assigns ? (
              <span
                aria-hidden="true"
                data-owner-dot=""
                className="absolute right-1 bottom-1 size-2.5 rounded-full border border-background"
                /* Color del firmante: dato del documento, no un token del tema. */
                style={{ backgroundColor: owner.color }}
              />
            ) : null}
          </button>
        );
      })}

      <span
        role="separator"
        aria-orientation={vertical ? "horizontal" : "vertical"}
        className="mx-0.5 h-6 w-px shrink-0 bg-hairline md:mx-0 md:my-0.5 md:h-px md:w-6"
      />

      <button
        type="button"
        data-palette-item="prev"
        aria-label={strings.prevField}
        title={strings.prevField}
        aria-disabled={!canPrevField}
        tabIndex={stop === "prev" ? 0 : -1}
        onFocus={() => setFocusKey("prev")}
        onClick={onPrevField}
        className={itemClass(false, !canPrevField)}
      >
        <ArrowUp aria-hidden="true" className="size-5" />
      </button>
      <button
        type="button"
        data-palette-item="next"
        aria-label={strings.nextField}
        title={strings.nextField}
        aria-disabled={!canNextField}
        tabIndex={stop === "next" ? 0 : -1}
        onFocus={() => setFocusKey("next")}
        onClick={onNextField}
        className={itemClass(false, !canNextField)}
      >
        <ArrowDown aria-hidden="true" className="size-5" />
      </button>
    </div>
  );
}
