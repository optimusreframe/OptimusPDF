"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";
import { shiftCrop, type CropFraction } from "@/app/sign-pdf/inkImportModel";
import { fill, type ExtractStrings } from "@/app/extract-assets/model";
import { HANDLE_NAME_KEY, REGION_HANDLES, handlePoint, keyDelta, moveHandle, nudgeHandle, type RegionHandle } from "@/app/extract-assets/regionModel";

/**
 * Rectangulo de recorte sobre la pagina (F7 · U7.4): se arrastra por el cuerpo y se redimensiona desde CUALQUIERA de sus ocho
 * asas (cuatro esquinas y cuatro bordes, zona de toque de 44 px). Alternativas al arrastre (WCAG 2.5.7):
 *  - teclado: las flechas MUEVEN el rectangulo; Mayus + flechas cambian su tamano desde la esquina inferior derecha; con el foco en
 *    un asa, las flechas mueven ESA esquina o borde (1 %; con Mayus, 5 %);
 *  - UN solo puntero: tocar un asa la elige (queda marcada) y el siguiente toque en la pagina la coloca ahi; sin asa elegida, un
 *    toque coloca el centro del rectangulo.
 * Vive en fracciones de la pagina (0..1), asi que no depende de la resolucion con que se pinte.
 */

const KEY_STEP = 0.01;
/**
 * Un asa de borde solo se pinta si la longitud de ese borde deja sitio entre las dos esquinas: dos objetivos de 44 px (que no se tocan) mas 8 px de aire.
 * En un rectangulo pequeno (el de un movil) sus zonas de toque se tapan con las de las esquinas y ninguna alcanzaria los 24 px de la
 * regla WCAG 2.5.8; las cuatro esquinas (y los botones de «Ajustar sin arrastrar») bastan para llegar a cualquier tamano y posicion.
 */
export const EDGE_HANDLE_MIN_PX = 96;
/** Un toque que se mueve menos que esto (px) sigue siendo un toque (elige el asa); mas es un arrastre. */
const TAP_SLOP_PX = 6;

const HANDLE_POSITION: Record<RegionHandle, string> = {
  nw: "left-0 top-0",
  n: "left-1/2 top-0",
  ne: "left-full top-0",
  e: "left-full top-1/2",
  se: "left-full top-full",
  s: "left-1/2 top-full",
  sw: "left-0 top-full",
  w: "left-0 top-1/2",
};

type Drag =
  | { kind: "handle"; handle: RegionHandle; pointerId: number; startX: number; startY: number; moved: boolean }
  | { kind: "move"; pointerId: number; lastX: number; lastY: number };

export function regionPercent(rect: CropFraction): { left: number; top: number; width: number; height: number } {
  return { left: Math.round(rect.x * 100), top: Math.round(rect.y * 100), width: Math.round(rect.width * 100), height: Math.round(rect.height * 100) };
}

export type RegionSelectorProps = {
  rect: CropFraction;
  onChange: (rect: CropFraction) => void;
  strings: ExtractStrings;
  /** Frase para la region viva tras cada pulsacion de flecha. */
  onAnnounce: (text: string) => void;
  /** Id del texto de ayuda (se enlaza con `aria-describedby`). */
  describedBy?: string;
};

export function RegionSelector({ rect, onChange, strings, onAnnounce, describedBy }: RegionSelectorProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const rectRef = useRef(rect);
  /** Asa elegida con un toque: el siguiente toque en la pagina la coloca ahi. */
  const [picked, setPicked] = useState<RegionHandle | null>(null);
  /** Tamano en pixeles de la pagina: decide que asas de borde caben (ver `EDGE_HANDLE_MIN_PX`). */
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  useEffect(() => {
    rectRef.current = rect;
  });
  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const measure = (): void => {
      const box = element.getBoundingClientRect();
      setFrame((previous) => (previous.width === box.width && previous.height === box.height ? previous : { width: box.width, height: box.height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const widthPx = rect.width * frame.width;
  const heightPx = rect.height * frame.height;
  const visibleHandles = REGION_HANDLES.filter((handle) => (handle === "n" || handle === "s" ? widthPx >= EDGE_HANDLE_MIN_PX : handle === "e" || handle === "w" ? heightPx >= EDGE_HANDLE_MIN_PX : true));

  const handleName = (handle: RegionHandle): string => strings[HANDLE_NAME_KEY[handle]];

  const fractionOf = (event: PointerEvent): { x: number; y: number } => {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };

  const startHandle = (handle: RegionHandle) => (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "handle", handle, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
  };

  const startMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "move", pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY };
  };

  const onPointerMove = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "handle") {
      if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < TAP_SLOP_PX) return;
      drag.moved = true;
      setPicked(null);
      const point = fractionOf(event);
      onChange(moveHandle(rectRef.current, drag.handle, point.x, point.y));
      return;
    }
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    const dx = (event.clientX - drag.lastX) / box.width;
    const dy = (event.clientY - drag.lastY) / box.height;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    onChange(shiftCrop(rectRef.current, dx, dy));
  };

  const endDrag = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    // Un toque sin arrastre sobre un asa la elige (o la suelta si ya lo estaba): la alternativa de un solo puntero.
    if (drag.kind === "handle" && !drag.moved && event.type === "pointerup") {
      const next = picked === drag.handle ? null : drag.handle;
      setPicked(next);
      onAnnounce(next ? fill(strings.regionHandlePicked, { name: handleName(next) }) : fill(strings.regionValue, regionPercent(rectRef.current)));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -KEY_STEP;
    else if (event.key === "ArrowRight") dx = KEY_STEP;
    else if (event.key === "ArrowUp") dy = -KEY_STEP;
    else if (event.key === "ArrowDown") dy = KEY_STEP;
    else return;
    event.preventDefault();
    // Mayus: cambia el tamano (la esquina inferior derecha); sin Mayus: mueve todo el rectangulo.
    const next = event.shiftKey ? nudgeHandle(rectRef.current, "se", dx, dy) : shiftCrop(rectRef.current, dx, dy);
    onChange(next);
    onAnnounce(fill(strings.regionValue, regionPercent(next)));
  };

  /** Flechas con el foco en un asa: mueven ESA esquina o borde (1 %; con Mayus, 5 %). */
  const onHandleKeyDown = (handle: RegionHandle) => (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && picked) {
      setPicked(null);
      return;
    }
    const delta = keyDelta(event.key, event.shiftKey);
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const next = nudgeHandle(rectRef.current, handle, delta.dx, delta.dy);
    onChange(next);
    onAnnounce(fill(strings.regionValue, regionPercent(next)));
  };

  /** Un toque en la pagina: con un asa elegida la coloca ahi; sin ella coloca el centro del rectangulo (sin cambiar su tamano). */
  const place = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const current = rectRef.current;
    const next = picked ? moveHandle(current, picked, x, y) : shiftCrop({ ...current, x: 0, y: 0 }, x - current.width / 2, y - current.height / 2);
    setPicked(null);
    onChange(next);
    onAnnounce(fill(strings.regionValue, regionPercent(next)));
  };

  const style = {
    left: `${rect.x * 100}%`,
    top: `${rect.y * 100}%`,
    width: `${rect.width * 100}%`,
    height: `${rect.height * 100}%`,
  };
  const percent = regionPercent(rect);
  const pickedPoint = picked ? handlePoint(rect, picked) : null;

  return (
    <div ref={frameRef} className="absolute inset-0" onClick={place} data-region-frame data-region-picked={picked ?? undefined}>
      <div
        role="group"
        tabIndex={0}
        aria-label={fill(strings.regionAreaLabel, percent)}
        aria-describedby={describedBy}
        data-region-rect
        onPointerDown={startMove}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={cn(
          "absolute cursor-move touch-none border-2 border-signal bg-signal/10",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white",
        )}
        style={style}
      >
        {visibleHandles.map((handle) => {
          const corner = handle.length === 2;
          const active = picked === handle;
          return (
            <button
              key={handle}
              type="button"
              aria-label={fill(strings.regionHandleLabel, { name: handleName(handle) })}
              aria-pressed={active}
              data-region-handle={handle}
              onPointerDown={startHandle(handle)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={onHandleKeyDown(handle)}
              className={cn(
                "absolute flex size-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center rounded-full",
                "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-white",
                // Las esquinas van por encima de los bordes: en un rectangulo pequeno se alcanzan siempre.
                corner ? "z-10" : "z-0",
                HANDLE_POSITION[handle],
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "border-2 border-white bg-signal shadow-elevation-1",
                  corner ? "size-4 rounded-full" : handle === "n" || handle === "s" ? "h-3 w-7 rounded-full" : "h-7 w-3 rounded-full",
                  active && "ring-2 ring-white ring-offset-2 ring-offset-signal",
                )}
              />
            </button>
          );
        })}
      </div>
      {pickedPoint ? <span hidden data-region-picked-point={`${pickedPoint.x.toFixed(3)},${pickedPoint.y.toFixed(3)}`} /> : null}
    </div>
  );
}
