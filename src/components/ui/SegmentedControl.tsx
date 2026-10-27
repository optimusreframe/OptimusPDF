"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { springs } from "@/lib/motion";
import { HIT_44 } from "@/components/ui/touchTarget";

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
};

export type SegmentedControlProps<T extends string> = {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label?: string;
  className?: string;
  size?: "sm" | "md";
  /** El nombre accesible se queda (`aria-label`) pero no se pinta encima: para filas compactas. */
  hideLabel?: boolean;
  /**
   * Los segmentos pasan a una segunda fila cuando no caben en una (fuente grande del sistema en un panel estrecho, p. ej. iPad de
   * 834 px con la fuente al 150 %): ninguno se recorta ni desborda la pagina y cada uno mide >= 44 px de alto y de ancho. El
   * pulgar deja de ser un solo elemento que se desliza por porcentajes y es el fondo del segmento activo, que se anima entre
   * posiciones con `layoutId` (tambien de una fila a otra).
   */
  wrap?: boolean;
};

/**
 * Control segmentado al estilo iOS: pista hundida, pulgar elevado que se
 * desliza con un spring sin rebote (`springs.snappy`; bajo reduced motion
 * MotionConfig lo vuelve instantaneo). Roles tablist/tab intactos;
 * flechas, Home y End mueven la seleccion y el foco (roving tabindex);
 * cada segmento responde en pointerdown escalando a 0.96.
 *
 * Las etiquetas NUNCA se truncan (W1-D): una etiqueta que no cabe pasa a dos
 * lineas y la pista crece lo justo (`min-h` en vez de altura fija; el pulgar
 * es absoluto con `inset-y-1` y la sigue). Con 4 o mas opciones (tamaño md)
 * los segmentos son estrechos y usan caption (12 px): asi ninguna etiqueta
 * pasa de dos lineas y la pista no crece (medido: "Black and white" a 13 px
 * eran tres lineas y 61 px de alto); `title` deja la etiqueta completa al
 * pasar el puntero.
 *
 * Columnas `minmax(min-content, 1fr)`: iguales mientras la palabra mas larga
 * de cada etiqueta quepa; si una palabra suelta no cabe en su parte ("Portuguese"
 * en un panel de 280 px con 4 idiomas), su columna se ensancha lo justo y las
 * demas ceden. En ese caso (y solo en ese) los anchos difieren y el pulgar usa
 * la geometria medida del segmento activo en px; con anchos iguales sigue
 * siendo un porcentaje que no depende del contenido (como en jsdom y en SSR).
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  size = "md",
  hideLabel = false,
  wrap = false,
}: SegmentedControlProps<T>) {
  const thumbId = useId();
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const count = Math.max(1, options.length);
  // sm: footnote. md: subheadline, o caption con 4+ segmentos (estrechos).
  const tabText =
    size === "sm"
      ? "text-footnote"
      : count >= 4
        ? "text-caption"
        : "text-subheadline";
  const tabsRef = useRef<(HTMLButtonElement | null)[]>([]);
  const trackRef = useRef<HTMLDivElement>(null);
  /* Geometria del pulgar cuando los segmentos no miden lo mismo; null = iguales. */
  const [box, setBox] = useState<{ left: number; width: number } | null>(null);

  const measure = useCallback(() => {
    if (wrap) return;
    const tabs = tabsRef.current.slice(0, count);
    if (tabs.length < count || tabs.some((tab) => !tab)) return;
    const widths = tabs.map((tab) => tab!.offsetWidth);
    const unequal = Math.max(...widths) - Math.min(...widths) > 1;
    const active = tabs[index];
    const next =
      unequal && active
        ? { left: active.offsetLeft, width: active.offsetWidth }
        : null;
    setBox((prev) =>
      prev === next ||
      (prev && next && prev.left === next.left && prev.width === next.width)
        ? prev
        : next,
    );
  }, [count, index, wrap]);

  // Medir antes de pintar (sin parpadeo) al montar y cada vez que cambian
  // el activo, el numero de segmentos o las etiquetas; y al cambiar el ancho
  // de la pista o cargar las fuentes (alteran el ancho del texto).
  useLayoutEffect(() => {
    measure();
  }, [measure, options]);

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(track);
    void document.fonts?.ready.then(measure);
    return () => observer?.disconnect();
  }, [measure]);

  const select = (nextIndex: number) => {
    const wrapped = (nextIndex + count) % count;
    const option = options[wrapped];
    if (!option) return;
    onChange(option.value);
    tabsRef.current[wrapped]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        select(index + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        select(index - 1);
        break;
      case "Home":
        event.preventDefault();
        select(0);
        break;
      case "End":
        event.preventDefault();
        select(count - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className={cn("w-full", className)}>
      {label && !hideLabel ? (
        <span className="ui-label mb-2 block text-muted-foreground">
          {label}
        </span>
      ) : null}
      <div
        ref={trackRef}
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        className={cn(
          wrap
            ? // Segmentos que pasan a otra fila: pista con relleno, esquinas amplias en vez de capsula.
              "relative isolate flex w-full flex-wrap gap-1 rounded-[22px] bg-white/8 p-1"
            : // Sin padding vertical: cada tab ocupa la altura entera de la pista
              // (44 px de toque); el pulgar se inseta 4 px por su cuenta.
              "relative isolate grid w-full auto-cols-[minmax(min-content,1fr)] grid-flow-col rounded-full bg-white/8 px-1",
          // forced-colors: la pista se delimita con borde del sistema.
          "forced-colors:border forced-colors:border-[ButtonText]",
          size === "sm" ? "min-h-9" : "min-h-11",
        )}
      >
        {wrap ? null : (
          <motion.span
            // Al cambiar de modo (porcentaje <-> px) se remonta: no se mezclan unidades.
            key={box ? "medido" : "iguales"}
            aria-hidden="true"
            initial={false}
            animate={
              box
                ? { x: box.left - 4, width: box.width }
                : { x: `${index * 100}%` }
            }
            transition={springs.snappy}
            // forced-colors: sin relleno ni sombra, el pulgar (opcion activa) es
            // un anillo grueso en Highlight.
            className="absolute inset-y-1 left-1 -z-10 rounded-full bg-elevated shadow-elevation-1 will-change-transform forced-colors:border-2 forced-colors:border-[Highlight]"
            style={
              box ? undefined : { width: `calc((100% - 0.5rem) / ${count})` }
            }
          />
        )}
        {options.map((option, optionIndex) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              ref={(element) => {
                tabsRef.current[optionIndex] = element;
              }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              title={option.label}
              onClick={() => onChange(option.value)}
              className={cn(
                wrap
                  ? // En fila que se parte: crece a lo ancho, nunca baja de 44 px (alto y ancho), y su fondo activo es el pulgar.
                    "relative min-h-11 min-w-11 flex-[1_1_auto] rounded-full px-3 py-1.5"
                  : "h-full px-1 py-1.5",
                "flex items-center justify-center rounded-full text-center leading-tight whitespace-normal select-none",
                tabText,
                "font-semibold",
                "transition-[color,scale,opacity] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                "active:scale-[0.96] active:duration-[80ms]",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
                // Con puntero grueso las pestañas `sm` (pista de 36 px) amplian
                // su zona de toque a 44 px sin cambiar el aspecto.
                size === "sm" && HIT_44,
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground active:opacity-70",
              )}
            >
              {wrap && active ? (
                <motion.span
                  layoutId={thumbId}
                  aria-hidden="true"
                  transition={springs.snappy}
                  className="absolute inset-0 -z-10 rounded-full bg-elevated shadow-elevation-1 forced-colors:border-2 forced-colors:border-[Highlight]"
                />
              ) : null}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
