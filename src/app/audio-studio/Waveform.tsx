"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { segmentStarts, trackLength, trackPeaks, type Track } from "@/lib/media/audio/edit";

/**
 * Forma de onda de Audio Studio: lienzo + cursor + seleccion, con raton, tacto y TECLADO.
 *
 * Accesibilidad: el lienzo es solo dibujo (`aria-hidden`); el control es el contenedor, un `slider` enfocable cuyo valor
 * es el cursor y cuyo texto (`aria-valuetext`) resume duracion y seleccion. Flechas: mover el cursor 0,1 s (Ctrl/Alt:
 * 1 s; Re Pag/Av Pag: 5 s; Inicio/Fin: extremos); Mayus + cualquiera de ellas: extender la seleccion; Espacio:
 * reproducir o pausar; Esc: quitar la seleccion. Un arrastre con el puntero selecciona (con `touch-action: pan-y` el
 * dedo sigue pudiendo desplazar la pagina en vertical).
 */

export type Selection = { start: number; end: number };

export type WaveformProps = {
  track: Track;
  /** Cursor (donde se pausa, divide y empieza a sonar). */
  cursor: number;
  /** Posicion que suena AHORA (se dibuja, pero no se anuncia a los lectores de pantalla). */
  playhead: number | null;
  selection: Selection | null;
  ariaLabel: string;
  valueText: string;
  /** Mueve el cursor a `frame`; con `extend` se extiende la seleccion desde donde estaba el cursor. */
  onMove: (frame: number, extend: boolean) => void;
  /** Un arrastre ha definido una seleccion (o `null` si fue un simple clic). */
  onDrag: (anchor: number, frame: number, finished: boolean) => void;
  onTogglePlay: () => void;
  onClearSelection: () => void;
  /** Se rellena con el contenedor enfocable (para llevarle el foco tras importar). */
  focusRef?: RefObject<HTMLDivElement | null>;
  className?: string;
};

const FALLBACK_WIDTH = 600;

function readColor(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export function Waveform({ track, cursor, playhead, selection, ariaLabel, valueText, onMove, onDrag, onTogglePlay, onClearSelection, focusRef, className }: WaveformProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(FALLBACK_WIDTH);
  const [themeTick, setThemeTick] = useState(0);
  const dragRef = useRef<{ anchor: number; startX: number; moved: boolean } | null>(null);
  const total = trackLength(track);
  const rate = track.sampleRate;

  useEffect(() => {
    if (focusRef) focusRef.current = wrapRef.current;
  });

  useEffect(() => {
    const node = wrapRef.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(80, Math.floor(node.clientWidth)));
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);

  // El tema (claro/oscuro) cambia los colores: se redibuja.
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeTick((tick) => tick + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => observer.disconnect();
  }, []);

  const peaks = useMemo(() => trackPeaks(track, width), [track, width]);
  const boundaries = useMemo(() => segmentStarts(track).slice(1, -1), [track]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const node = wrapRef.current;
    if (!canvas || !node) return;
    const dpr = window.devicePixelRatio || 1;
    const height = node.clientHeight || 144;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, height);
    const signal = readColor("--color-signal", "#3b5bdb");
    const foreground = readColor("--color-foreground", "#fff");
    const muted = readColor("--color-muted-foreground", "#999");
    const middle = height / 2;
    const scale = middle - 4;
    const toX = (frame: number) => (total > 0 ? (frame / total) * width : 0);

    if (selection) {
      context.fillStyle = signal;
      context.globalAlpha = 0.28;
      context.fillRect(toX(selection.start), 0, Math.max(1, toX(selection.end) - toX(selection.start)), height);
      context.globalAlpha = 1;
    }
    context.fillStyle = muted;
    context.globalAlpha = 0.5;
    context.fillRect(0, middle - 0.5, width, 1);
    context.globalAlpha = 1;
    context.fillStyle = signal;
    for (let x = 0; x < width; x += 1) {
      const top = middle - Math.min(1, peaks.max[x]) * scale;
      const bottom = middle - Math.max(-1, peaks.min[x]) * scale;
      context.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
    // Limites entre clips: lineas discontinuas.
    context.strokeStyle = muted;
    context.lineWidth = 1;
    context.setLineDash([3, 3]);
    for (const frame of boundaries) {
      const x = Math.round(toX(frame)) + 0.5;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
    context.setLineDash([]);
    context.fillStyle = foreground;
    context.fillRect(Math.min(width - 2, Math.max(0, toX(playhead ?? cursor) - 1)), 0, 2, height);
  }, [peaks, boundaries, selection, cursor, playhead, total, width, themeTick]);

  const frameAt = (clientX: number): number => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || total === 0) return 0;
    return Math.round(Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) * total);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    dragRef.current = { anchor: frameAt(event.clientX), startX: event.clientX, moved: false };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved && Math.abs(event.clientX - drag.startX) < 4) return;
    drag.moved = true;
    onDrag(drag.anchor, frameAt(event.clientX), false);
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    if (drag.moved) onDrag(drag.anchor, frameAt(event.clientX), true);
    else onMove(drag.anchor, false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (total === 0) return;
    const small = Math.round(rate * 0.1);
    const large = rate;
    const step = event.ctrlKey || event.altKey || event.metaKey ? large : small;
    let target: number | null = null;
    switch (event.key) {
      case "ArrowLeft":
        target = cursor - step;
        break;
      case "ArrowRight":
        target = cursor + step;
        break;
      case "ArrowDown":
        target = cursor - large;
        break;
      case "ArrowUp":
        target = cursor + large;
        break;
      case "PageDown":
        target = cursor - rate * 5;
        break;
      case "PageUp":
        target = cursor + rate * 5;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = total;
        break;
      case " ":
      case "Spacebar":
        event.preventDefault();
        onTogglePlay();
        return;
      case "Escape":
        if (selection) {
          event.preventDefault();
          onClearSelection();
        }
        return;
      default:
        return;
    }
    event.preventDefault();
    onMove(Math.min(total, Math.max(0, target)), event.shiftKey);
  };

  return (
    <div
      ref={wrapRef}
      role="slider"
      tabIndex={0}
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round((total / rate) * 100) / 100}
      aria-valuenow={Math.round((cursor / rate) * 100) / 100}
      aria-valuetext={valueText}
      data-testid="waveform"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={() => {
        dragRef.current = null;
      }}
      className={
        "relative h-36 w-full cursor-text touch-pan-y overflow-hidden rounded-ios border border-hairline-strong bg-white/5 outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal md:h-44 " +
        (className ?? "")
      }
    >
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 size-full" style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
