"use client";

import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";
import { cn } from "@/lib/cn";
import {
  moveCorner,
  nudgeCorner,
  shiftCrop,
  type CropCorner,
  type CropFraction,
} from "@/app/sign-pdf/inkImportModel";
import { fill, type ExtractStrings } from "@/app/extract-assets/model";

/**
 * Rectangulo de recorte sobre la pagina (F7 · U7.4): se arrastra por el cuerpo, se redimensiona con las cuatro asas de
 * esquina (zona de toque de 44 px) y se maneja con el teclado: las flechas lo MUEVEN y Mayus + flechas cambian su TAMANO.
 * Vive en fracciones de la pagina (0..1), asi que no depende de la resolucion con que se pinte. Un toque en la pagina (no un
 * arrastre: el desplazamiento del dedo sigue siendo de la pagina) coloca el rectangulo donde se toco.
 */

const CORNERS: readonly CropCorner[] = ["nw", "ne", "sw", "se"];
const KEY_STEP = 0.01;

const CORNER_POSITION: Record<CropCorner, string> = {
  nw: "left-0 top-0",
  ne: "left-full top-0",
  sw: "left-0 top-full",
  se: "left-full top-full",
};

type Drag = { kind: "corner"; corner: CropCorner; pointerId: number } | { kind: "move"; pointerId: number; lastX: number; lastY: number };

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
  useEffect(() => {
    rectRef.current = rect;
  });

  const fractionOf = (event: PointerEvent): { x: number; y: number } => {
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };

  const startCorner = (corner: CropCorner) => (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "corner", corner, pointerId: event.pointerId };
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
    if (drag.kind === "corner") {
      const point = fractionOf(event);
      onChange(moveCorner(rectRef.current, drag.corner, point.x, point.y));
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
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
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
    const next = event.shiftKey ? nudgeCorner(rectRef.current, "se", dx, dy) : shiftCrop(rectRef.current, dx, dy);
    onChange(next);
    onAnnounce(fill(strings.regionValue, regionPercent(next)));
  };

  /** Un toque en la pagina coloca el centro del rectangulo ahi (sin cambiar su tamano). */
  const place = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const box = frameRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return;
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const current = rectRef.current;
    const next = shiftCrop({ ...current, x: 0, y: 0 }, x - current.width / 2, y - current.height / 2);
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

  return (
    <div ref={frameRef} className="absolute inset-0" onClick={place} data-region-frame>
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
        {CORNERS.map((corner) => (
          <div
            key={corner}
            aria-hidden="true"
            data-region-handle={corner}
            onPointerDown={startCorner(corner)}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            className={cn("absolute flex size-11 -translate-x-1/2 -translate-y-1/2 touch-none items-center justify-center", CORNER_POSITION[corner])}
          >
            <span className="size-4 rounded-full border-2 border-white bg-signal shadow-elevation-1" />
          </div>
        ))}
      </div>
    </div>
  );
}
