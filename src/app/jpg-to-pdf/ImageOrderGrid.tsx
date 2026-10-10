"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { STRINGS } from "@/app/jpg-to-pdf/strings";

export type ImageOrderGridProps = {
  files: File[];
  /**
   * Indices de `files` en el orden final. Quitar imagenes es tarea de la
   * lista de archivos de `ToolShell`: aqui solo se ordena, para que no
   * haya dos sitios distintos decidiendo que imagenes entran.
   */
  onOrderChange: (order: number[]) => void;
  className?: string;
};

/**
 * Miniaturas reordenables de las imagenes subidas. Igual que
 * `PageThumbnailGrid`, se remonta con una key derivada de los archivos
 * para reiniciar el orden cuando cambia el conjunto.
 */
export function ImageOrderGrid(props: ImageOrderGridProps) {
  const key = props.files
    .map((file) => `${file.name}:${file.size}:${file.lastModified}`)
    .join("|");
  return <ImageOrderGridInner key={key} {...props} />;
}

function ImageOrderGridInner({
  files,
  onOrderChange,
  className,
}: ImageOrderGridProps) {
  const { t, language } = useI18n();
  const s = STRINGS[language];

  const [order, setOrder] = useState<number[]>(() =>
    files.map((_, index) => index),
  );
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // Un object URL por archivo; se revocan al desmontar para no filtrar
  // memoria con lotes grandes de fotos.
  const urls = useMemo(() => files.map((file) => URL.createObjectURL(file)), [
    files,
  ]);
  useEffect(
    () => () => {
      for (const url of urls) URL.revokeObjectURL(url);
    },
    [urls],
  );

  const changeRef = useRef(onOrderChange);
  useEffect(() => {
    changeRef.current = onOrderChange;
  });
  useEffect(() => {
    changeRef.current(order);
  }, [order]);

  const moveTo = useCallback((from: number, to: number) => {
    setOrder((previous) => {
      if (from === to || from < 0 || to < 0) return previous;
      if (from >= previous.length || to >= previous.length) return previous;
      const next = [...previous];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  const move = useCallback(
    (position: number, offset: number) => moveTo(position, position + offset),
    [moveTo],
  );

  if (files.length === 0) return null;

  return (
    <div className={className}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 className="ui-label text-muted-foreground">
          {s.previewTitle}
        </h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground">{s.previewHint}</p>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {order.map((fileIndex, position) => {
          const file = files[fileIndex];
          if (!file) return null;
          return (
            <li
              key={`${fileIndex}-${file.name}`}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", String(fileIndex));
                setDragIndex(position);
              }}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setOverIndex(position);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragIndex !== null) moveTo(dragIndex, position);
                setDragIndex(null);
                setOverIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={cn(
                "glass rounded-ios-sm relative cursor-grab overflow-hidden p-2 active:cursor-grabbing",
                "transition-all duration-200 ease-spring",
                dragIndex === position && "opacity-40",
                overIndex === position &&
                  dragIndex !== position &&
                  "ring-signal/60 ring-2",
              )}
            >
              <span className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-[10px] bg-white/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={urls[fileIndex]}
                  alt={`${s.imageAlt} ${position + 1}`}
                  className="max-h-full max-w-full object-contain"
                />
              </span>

              <div className="mt-2 flex items-center justify-between gap-1">
                <span className="text-caption text-muted-foreground tabular-nums">
                  {position + 1}
                </span>
                <div className="flex items-center gap-0.5">
                  <MiniButton
                    label={t.tool.moveUp}
                    disabled={position === 0}
                    onClick={() => move(position, -1)}
                  >
                    <ArrowLeft aria-hidden="true" className="size-3" />
                  </MiniButton>
                  <MiniButton
                    label={t.tool.moveDown}
                    disabled={position === order.length - 1}
                    onClick={() => move(position, 1)}
                  >
                    <ArrowRight aria-hidden="true" className="size-3" />
                  </MiniButton>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MiniButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      // size-6 con raton; 44 px con puntero grueso (dos botones por celda caben).
      className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors pointer-coarse:size-11 hover:bg-white/12 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
