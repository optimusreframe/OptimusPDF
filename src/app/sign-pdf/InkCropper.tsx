"use client";

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { InkImage } from "@/lib/image/inkCore";
import { cn } from "@/lib/cn";
import { paintImage } from "@/app/sign-pdf/inkImportEngine";
import {
  moveCorner,
  nudgeCorner,
  shiftCrop,
  type CropCorner,
  type CropFraction,
} from "@/app/sign-pdf/inkImportModel";
import type { InkImportStrings } from "@/app/sign-pdf/strings";

/**
 * Recorte manual sobre la imagen ORIGINAL (copia reducida para mostrarla): cuatro asas de esquina con zona de toque de
 * 44 px y el cuerpo del recorte arrastrable. Todo se maneja tambien con el teclado (flechas; con Mayus, saltos mayores)
 * sin depender de pasar el raton por encima. El recorte vive en fracciones de la imagen, asi que no depende de la
 * resolucion con que se pinte.
 */

const CORNERS: readonly CropCorner[] = ["nw", "ne", "sw", "se"];
const KEY_STEP = 0.01;
const KEY_STEP_BIG = 0.05;

const CORNER_POSITION: Record<CropCorner, string> = {
  nw: "left-0 top-0",
  ne: "left-full top-0",
  sw: "left-0 top-full",
  se: "left-full top-full",
};

type Drag =
  | { kind: "corner"; corner: CropCorner; pointerId: number }
  | { kind: "move"; pointerId: number; lastX: number; lastY: number };

export type InkCropperProps = {
  image: InkImage;
  crop: CropFraction;
  onChange: (crop: CropFraction) => void;
  strings: InkImportStrings;
};

export function InkCropper({ image, crop, onChange, strings }: InkCropperProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const cropRef = useRef(crop);
  useEffect(() => {
    cropRef.current = crop;
  });

  useEffect(() => {
    paintImage(canvasRef.current, image);
  }, [image]);

  /** Posicion del puntero como fraccion de la imagen mostrada. */
  const fractionOf = (event: PointerEvent): { x: number; y: number } => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
    };
  };

  const startCorner = (corner: CropCorner) => (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { kind: "corner", corner, pointerId: event.pointerId };
  };

  const startMove = (event: PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      kind: "move",
      pointerId: event.pointerId,
      lastX: event.clientX,
      lastY: event.clientY,
    };
  };

  const onPointerMove = (event: PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.kind === "corner") {
      const point = fractionOf(event);
      onChange(moveCorner(cropRef.current, drag.corner, point.x, point.y));
      return;
    }
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    const dx = (event.clientX - drag.lastX) / rect.width;
    const dy = (event.clientY - drag.lastY) / rect.height;
    drag.lastX = event.clientX;
    drag.lastY = event.clientY;
    onChange(shiftCrop(cropRef.current, dx, dy));
  };

  const endDrag = (event: PointerEvent) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  const onCornerKey = (corner: CropCorner) => (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    let dx = 0;
    let dy = 0;
    if (event.key === "ArrowLeft") dx = -step;
    else if (event.key === "ArrowRight") dx = step;
    else if (event.key === "ArrowUp") dy = -step;
    else if (event.key === "ArrowDown") dy = step;
    else return;
    event.preventDefault();
    onChange(nudgeCorner(cropRef.current, corner, dx, dy));
  };

  const style = {
    left: `${crop.x * 100}%`,
    top: `${crop.y * 100}%`,
    width: `${crop.width * 100}%`,
    height: `${crop.height * 100}%`,
  };

  return (
    // El relleno exterior deja sitio a las asas de 44 px que sobresalen de las esquinas de la imagen.
    <div className="overflow-hidden rounded-ios-sm p-[22px]" data-testid="ink-cropper">
      <div
        ref={frameRef}
        className="relative touch-none select-none"
        style={{ aspectRatio: `${image.width} / ${image.height}` }}
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={strings.originalAlt}
          className="absolute inset-0 size-full rounded-sm border border-white/15 bg-white"
        />
        <div
          role="group"
          aria-label={strings.cropAreaLabel}
          data-crop={`${crop.x.toFixed(3)},${crop.y.toFixed(3)},${crop.width.toFixed(3)},${crop.height.toFixed(3)}`}
          onPointerDown={startMove}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          className="absolute cursor-move border-2 border-signal shadow-[0_0_0_9999px_rgba(0,0,0,0.5)] forced-colors:border-[Highlight]"
          style={style}
        >
          {CORNERS.map((corner) => (
            <button
              key={corner}
              type="button"
              aria-label={strings.cropHandle(corner)}
              data-crop-handle={corner}
              onPointerDown={startCorner(corner)}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onKeyDown={onCornerKey(corner)}
              className={cn(
                "group absolute z-10 flex size-11 -translate-x-1/2 -translate-y-1/2 cursor-pointer touch-none items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal",
                CORNER_POSITION[corner],
              )}
            >
              <span
                aria-hidden="true"
                className="size-4 rounded-full border-2 border-white bg-signal shadow-elevation-1 transition-[scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)] group-active:scale-125"
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
