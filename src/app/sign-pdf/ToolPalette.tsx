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
  ChevronDown,
  ChevronUp,
  MousePointer2,
  PenLine,
  Signature,
  SquareCheck,
  Type,
  TextCursorInput,
} from "lucide-react";
import { useMatchMedia } from "@/app/sign-pdf/useMatchMedia";
import { useInProSuite } from "@/app/sign-pdf/useInProSuite";
import { useGestureStrings } from "@/app/sign-pdf/gestureStrings";
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
 * Espacio activan). Las herramientas son botones con `aria-pressed`. La herramienta elegida SE QUEDA armada tras colocar
 * un elemento (W3-A3) y solo cambia cuando la persona toca OTRA (Seleccionar incluida), pulsa Escape o su atajo; volver a
 * tocar la ya activa no la apaga. Mientras hay una herramienta armada, «Seleccionar» se ofrece aparte con texto visible
 * (junto al boton plegado en el movil; en una etiqueta sobre la paleta en tablet; en el carril de escritorio, su primer
 * boton). Al final van
 * "Campo anterior/siguiente": la alternativa NO precisa a tocar un campo
 * pequeno (WCAG 2.2 · 2.5.8).
 *
 * Escritorio ancho (>= 1 280 px): carril vertical pegajoso junto a la pagina, por debajo de la barra de zoom.
 *
 * Movil y tablet (< 1 280 px; auditoria movil/iPad SC-02 / VI-04 / GE-02 / GE-04): la paleta ya NO es una capa `fixed` de
 * todo el ancho que flotaba sobre el texto de configuracion y tapaba el pie de la hoja y la firma, ni un carril que le
 * quitaba ancho a la hoja y, al final de la pagina, quedaba bajo la barra de zoom. Es un DOCK PEGAJOSO dentro del propio
 * lienzo, DETRAS de la hoja: pegado al borde de abajo (sobre la barra «Opciones/Procesar» en el movil o sobre la barra
 * «Procesar» en tablet) mientras la hoja se ve; al final de la pagina descansa bajo la hoja, sin taparla. En el movil
 * (< 768 px) esta PLEGADO por defecto en un boton con la herramienta activa: asi las capas fijas de abajo (barra + tab
 * bar) suman ~16 % del alto de un iPhone y no ~34 %; al abrirlo, una fila (o dos) de botones de 44 px separados 8 px, y
 * elegir una herramienta lo pliega de nuevo. Dentro de PDF Pro (`<html data-pro-suite>`) el
 * carril de escritorio empieza en 768 px, como antes: ese layout lo gobierna la suite; en el telefono se pliega igual.
 */

const TOOL_ICONS: Record<PlacementTool, typeof Type> = {
  select: MousePointer2,
  signature: PenLine,
  initials: Signature,
  text: Type,
  checkbox: SquareCheck,
  date: CalendarDays,
  editText: TextCursorInput,
};

/**
 * Clases de cada boton de la paleta. Se exportan para que la paleta del editor
 * de PDF (`edit-pdf/EditToolPalette`) tenga EXACTAMENTE el mismo aspecto sin
 * tocar el contrato de esta (decision W5-U4a: una paleta propia que reutiliza
 * las piezas, en vez de abrir `ToolPalette` a una lista generica).
 */
export function paletteItemClass(active: boolean, dimmed = false): string {
  return cn(
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
}

type ItemKey = PlacementTool | "prev" | "next" | "collapse";

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
  const fabRef = useRef<HTMLButtonElement>(null);
  const gesture = useGestureStrings();
  const inPro = useInProSuite();
  /** Carril vertical: desde 1 280 px (dentro de PDF Pro, desde 768 px). Por debajo, dock pegajoso tras la hoja. */
  const railWide = useMatchMedia("(min-width: 1280px)");
  const railMedium = useMatchMedia("(min-width: 768px)");
  const vertical = inPro ? railMedium : railWide;
  const narrow = useMatchMedia("(max-width: 767.98px)");
  /**
   * Movil (< 768 px), tambien dentro de PDF Pro: la paleta se pliega en un boton. En PDF Pro abierta tapaba ~105 px de la
   * hoja (dos filas) en un iPhone de 852 px (hoja visible 216 px); plegada la deja en ~320. En jsdom (`matchMedia` ausente) nunca.
   */
  const collapsible = narrow;
  const [open, setOpen] = useState(false);
  /** Quien debe recibir el foco tras plegar/abrir: lo que la persona acaba de pulsar desaparece del arbol. */
  const focusAfterRef = useRef<"fab" | "tool" | null>(null);

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
      case "editText":
        return strings.toolEditText;
    }
  };

  /*
   * "Anterior/siguiente" usan `aria-disabled`, no `disabled`: al pulsar
   * "siguiente" en el ultimo campo pendiente el boton se quedaria
   * deshabilitado y el foco caeria a <body>.
   */
  const enabledKeys: ItemKey[] = [...tools, "prev", "next", ...(collapsible ? (["collapse"] as const) : [])];

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

  useEffect(() => {
    const target = focusAfterRef.current;
    if (!target) return;
    focusAfterRef.current = null;
    if (target === "fab") fabRef.current?.focus({ preventScroll: true });
    else rootRef.current?.querySelector<HTMLElement>(`[data-palette-item="${tool}"]`)?.focus({ preventScroll: true });
  }, [open, tool]);

  const fold = () => {
    focusAfterRef.current = "fab";
    setOpen(false);
  };

  /** Salir de la herramienta armada: vuelve a Seleccionar y deja el foco en un control que siga en pantalla. */
  const exitTool = () => {
    focusAfterRef.current = collapsible ? "fab" : "tool";
    onToolChange("select");
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

  const onEscape = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && collapsible && open) fold();
  };

  /* En movil cada boton mide 44 px y no se estira (la paleta separa 8 px); en el carril de escritorio/tablet, como siempre. */
  const itemClass = (active: boolean, dimmed = false) =>
    cn(paletteItemClass(active, dimmed), inPro ? "max-md:w-11 max-md:flex-none" : "max-xl:h-11 max-xl:w-11 max-xl:flex-none");

  const ActiveIcon = TOOL_ICONS[tool];
  const armed = tool !== "select";

  /* Plegada (solo movil fuera de PDF Pro): un boton con la herramienta activa. */
  const folded = collapsible && !open;

  const toolbar = (
    <div
      ref={rootRef}
      role="toolbar"
      aria-label={strings.paletteLabel}
      aria-orientation={vertical ? "vertical" : "horizontal"}
      data-tool-palette=""
      onKeyDown={(event) => {
        onKeyDown(event);
        onEscape(event);
      }}
      className={cn(
        "material-thick shadow-elevation-2 rounded-ios p-1",
        "flex items-center",
        inPro
          ? [
              "max-md:pointer-events-auto max-md:mx-auto max-md:max-w-full max-md:flex-wrap max-md:justify-center max-md:gap-2",
              // Carril dentro de PDF Pro: pegado bajo la barra de zoom (la de md mide ~54 px y se pega a 4,5 rem de arriba).
              "md:sticky md:top-[calc(8.25rem+env(safe-area-inset-top,0px))] md:w-12 md:shrink-0 md:flex-col md:gap-0.5 md:pointer-coarse:gap-2 lg:top-20",
            ]
          : [
              "max-xl:pointer-events-auto max-xl:mx-auto max-xl:max-w-full max-xl:flex-wrap max-xl:justify-center max-xl:gap-2",
              // Carril de escritorio ancho: bajo la barra de zoom (que se pega a 0,75 rem de arriba desde 1 024 px).
              "xl:sticky xl:top-20 xl:w-12 xl:shrink-0 xl:flex-col xl:gap-0.5 xl:pointer-coarse:gap-2",
            ],
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
            onClick={() => {
              // Tocar la herramienta ya activa NO la apaga: se sale con «Seleccionar», Escape o su atajo (W3-A3).
              onToolChange(key);
              if (collapsible) fold();
            }}
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
        className={cn(
          "shrink-0 bg-hairline",
          inPro ? "mx-0.5 h-6 w-px max-md:hidden md:mx-0 md:my-0.5 md:h-px md:w-6" : "mx-0.5 h-6 w-px max-xl:hidden xl:mx-0 xl:my-0.5 xl:h-px xl:w-6",
        )}
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
      {collapsible ? (
        <button
          type="button"
          data-palette-item="collapse"
          aria-label={strings.paletteCollapse}
          title={strings.paletteCollapse}
          tabIndex={stop === "collapse" ? 0 : -1}
          onFocus={() => setFocusKey("collapse")}
          onClick={fold}
          className={itemClass(false)}
        >
          <ChevronDown aria-hidden="true" className="size-5" />
        </button>
      ) : null}
    </div>
  );

  return (
    /*
     * Movil y tablet: contenedor PEGAJOSO al final del lienzo (se pone detras de la hoja con `order`): no pinta ni recibe
     * toques, solo sus botones. `bottom` = sobre la barra «Opciones/Procesar» del movil (4,5 rem de la tab bar + 4,25 rem de
     * la barra, 0,5 rem de aire) o sobre la barra «Procesar» de tablet; en PDF Pro no hay esas barras. En escritorio ancho el
     * contenedor desaparece (`contents`) y manda el carril.
     */
    <div
      data-palette-dock=""
      className={
        inPro
          ? "max-md:pointer-events-none max-md:sticky max-md:bottom-2 max-md:z-20 max-md:order-last max-md:flex max-md:flex-col max-md:items-start max-md:gap-2 md:contents"
          : "max-xl:pointer-events-none max-xl:sticky max-xl:z-20 max-xl:order-last max-xl:flex max-xl:flex-col max-xl:items-start max-xl:gap-2 max-md:bottom-[calc(9.5rem+env(safe-area-inset-bottom,0px))] md:max-xl:bottom-28 xl:contents"
      }
    >
      {folded ? (
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <button
            ref={fabRef}
            type="button"
            data-palette-fab=""
            // PDF Pro pliega con «Ocultar herramientas» lo marcado `data-pro-fold` (y la barra desplegada, por `data-tool-palette`).
            data-pro-fold=""
            aria-label={strings.paletteExpand(labelOf(tool))}
            aria-expanded={false}
            title={strings.paletteExpand(labelOf(tool))}
            onClick={() => {
              focusAfterRef.current = "tool";
              setOpen(true);
            }}
            className={cn(
              "material-thick shadow-elevation-2 pointer-events-auto flex h-12 min-w-12 items-center justify-center gap-1.5 rounded-full px-3 text-footnote font-semibold",
              "transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] active:scale-[0.94] active:duration-[80ms]",
              "focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal",
              armed
                ? "text-foreground shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:border-2 forced-colors:border-[Highlight]"
                : "text-muted-foreground",
            )}
          >
            <ActiveIcon aria-hidden="true" className="size-5" />
            {armed ? <span>{labelOf(tool)}</span> : null}
            <ChevronUp aria-hidden="true" className="size-4 opacity-70" />
          </button>
          {armed ? (
            /* Salida explicita de la herramienta armada (W3-A3): texto + icono, 48 px, junto al boton plegado. */
            <button
              type="button"
              data-palette-exit=""
              data-pro-fold=""
              aria-label={gesture.exitToolLabel(strings.toolSelect)}
              onClick={exitTool}
              className={cn(
                "material-thick shadow-elevation-2 pointer-events-auto flex h-12 min-w-12 items-center justify-center gap-1.5 rounded-full px-3.5 text-footnote font-semibold text-foreground",
                "shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:border-2 forced-colors:border-[Highlight]",
                "transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] active:scale-[0.94] active:duration-[80ms] motion-reduce:transition-none",
                "focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal",
              )}
            >
              <MousePointer2 aria-hidden="true" className="size-5" />
              <span className="max-[359px]:sr-only">{strings.toolSelect}</span>
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {armed && !vertical && !collapsible ? (
            /*
             * Tablet (carril aun no disponible): la herramienta armada se dice con TEXTO + icono y «Seleccionar» se ofrece
             * aparte, grande. (En el carril de escritorio el estado lo da el boton activo, `aria-pressed`, y «Seleccionar» es
             * el primero; en el movil, el boton plegado de arriba.)
             */
            <div
              data-armed-label=""
              className="material-thick shadow-elevation-2 pointer-events-auto mx-auto flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-ios py-1 pr-1 pl-3 text-footnote"
            >
              <span className="flex min-w-0 items-center gap-2 font-semibold text-foreground">
                <ActiveIcon aria-hidden="true" className="size-4 shrink-0" />
                {gesture.armedLabel(labelOf(tool))}
              </span>
              {tool !== "editText" ? (
                <span className="min-w-0 text-muted-foreground">{gesture.armedHint}</span>
              ) : null}
              <button
                type="button"
                data-palette-exit=""
                aria-label={gesture.exitToolLabel(strings.toolSelect)}
                onClick={exitTool}
                className={cn(
                  "flex h-11 min-w-11 items-center justify-center gap-1.5 rounded-ios-sm bg-signal/20 px-3 font-semibold text-foreground",
                  "shadow-[inset_0_0_0_1.5px_var(--color-signal)] forced-colors:border-2 forced-colors:border-[Highlight]",
                  "transition-[background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] hover:bg-signal/30 active:scale-[0.94] active:duration-[80ms] motion-reduce:transition-none",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal",
                )}
              >
                <MousePointer2 aria-hidden="true" className="size-5" />
                {strings.toolSelect}
              </button>
            </div>
          ) : null}
          {toolbar}
        </>
      )}
    </div>
  );
}
