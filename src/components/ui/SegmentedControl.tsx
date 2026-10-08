"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/cn";
import { springs } from "@/lib/motion";

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
}: SegmentedControlProps<T>) {
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
  }, [count, index]);

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
      {label ? (
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
          // Sin padding vertical: cada tab ocupa la altura entera de la pista
          // (44 px de toque); el pulgar se inseta 4 px por su cuenta.
          "relative isolate grid w-full auto-cols-[minmax(min-content,1fr)] grid-flow-col rounded-full bg-white/8 px-1",
          size === "sm" ? "min-h-9" : "min-h-11",
        )}
      >
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
          className="absolute inset-y-1 left-1 -z-10 rounded-full bg-elevated shadow-elevation-1 will-change-transform"
          style={
            box ? undefined : { width: `calc((100% - 0.5rem) / ${count})` }
          }
        />
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
                "flex h-full items-center justify-center rounded-full px-1 py-1.5 text-center leading-tight whitespace-normal select-none",
                tabText,
                "font-semibold",
                "transition-[color,scale,opacity] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                "active:scale-[0.96] active:duration-[80ms]",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground active:opacity-70",
              )}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
