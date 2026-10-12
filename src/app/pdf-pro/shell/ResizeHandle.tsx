"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";

export type ResizeHandleProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Cuanto crece al mover `+1 px` el puntero hacia la derecha: `1` (miniaturas) o `-1` (panel de la derecha). */
  direction: 1 | -1;
  onChange: (value: number) => void;
  /** El gesto termino (soltar el puntero, o una tecla): momento de guardar. */
  onCommit: () => void;
  onReset: () => void;
  controls?: string;
  className?: string;
};

/** Paso de las flechas y con Mayus. */
const STEP = 16;
const BIG_STEP = 64;

/**
 * Tirador para cambiar el ancho de un panel (separador vertical WAI-ARIA, «window splitter»): arrastrable con
 * puntero (con captura) y con teclado (flechas ±16 px, Mayus ±64, Inicio/Fin = minimo/maximo, Intro = restablecer).
 * Un solo tabulador. En movil no se pinta (los paneles son hojas).
 */
export function ResizeHandle({
  label,
  value,
  min,
  max,
  direction,
  onChange,
  onCommit,
  onReset,
  controls,
  className,
}: ResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; startX: number; startValue: number } | null>(null);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startValue: value };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    onChange(Math.min(max, Math.max(min, drag.startValue + (event.clientX - drag.startX) * direction)));
  };
  const end = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onCommit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? BIG_STEP : STEP;
    let next: number | null = null;
    // La flecha hacia donde crece el panel lo agranda.
    if (event.key === "ArrowRight") next = value + step * direction;
    else if (event.key === "ArrowLeft") next = value - step * direction;
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    else if (event.key === "Enter") {
      event.preventDefault();
      onReset();
      return;
    } else return;
    event.preventDefault();
    onChange(Math.min(max, Math.max(min, next)));
    onCommit();
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-controls={controls}
      tabIndex={0}
      data-pro-resize=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onKeyDown={onKeyDown}
      onDoubleClick={onReset}
      className={cn(
        "group relative z-10 -mx-1.5 hidden w-3 shrink-0 cursor-col-resize touch-none select-none outline-none md:block",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-[var(--color-hairline)] transition-colors",
          "group-hover:w-0.5 group-hover:bg-signal group-active:w-0.5 group-active:bg-signal",
          "group-focus-visible:w-0.5 group-focus-visible:bg-signal forced-colors:bg-[CanvasText] forced-colors:group-focus-visible:bg-[Highlight]",
        )}
      />
    </div>
  );
}
