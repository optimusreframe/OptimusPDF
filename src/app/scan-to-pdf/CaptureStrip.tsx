"use client";

import { ArrowLeft, ArrowRight, Crop, Trash2, Undo2 } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { useI18n } from "@/lib/i18n";
import type { ScanFilter } from "@/lib/pdf/scanToPdf";
import type { QuadCorners } from "@/lib/scan/perspective";
import { STRINGS } from "@/app/scan-to-pdf/strings";
import { previewFilter } from "@/app/scan-to-pdf/preview";

export type ScanCapture = {
  id: string;
  /**
   * Foto cruda tal cual salio de la camara. El recorte de perspectiva y
   * los filtros trabajan siempre sobre copias derivadas, nunca sobre
   * este blob: es lo que permite deshacer.
   */
  originalBlob: Blob;
  /** Version que llega al PDF: la recortada si hay esquinas aplicadas. */
  blob: Blob;
  /** Object URL de `blob`; lo revoca el componente padre. */
  url: string;
  /** Esquinas aplicadas, normalizadas 0-1, o `null` si no hay recorte. */
  corners: QuadCorners | null;
  cornersSource: "auto" | "manual" | null;
  /** Hay una deteccion o un recorte en curso para esta captura. */
  pending: boolean;
};

export type CaptureStripProps = {
  captures: ScanCapture[];
  filter: ScanFilter;
  onMove: (index: number, offset: number) => void;
  onRemove: (id: string) => void;
  onEditCorners: (id: string) => void;
  onUndoCrop: (id: string) => void;
};

/** Tira de miniaturas de las paginas capturadas, en orden de aparicion. */
export function CaptureStrip({
  captures,
  filter,
  onMove,
  onRemove,
  onEditCorners,
  onUndoCrop,
}: CaptureStripProps) {
  const { t, language } = useI18n();
  const s = STRINGS[language];

  return (
    <div>
      <h3 className="ui-label mb-3 text-muted-foreground">
        {s.capturesTitle}
      </h3>

      {captures.length === 0 ? (
        <p className="text-sm text-muted-foreground">{s.capturesEmpty}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {captures.map((capture, index) => (
            <li
              key={capture.id}
              data-capture-id={capture.id}
              className="glass rounded-ios-sm relative overflow-hidden p-2"
            >
              <span className="relative flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-[10px] bg-white/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={capture.url}
                  alt={`${s.captureAlt} ${index + 1}`}
                  className="max-h-full max-w-full object-contain"
                  style={{ filter: previewFilter(filter) }}
                />

                {capture.pending ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-background/55">
                    <Spinner className="size-4" label={s.cropping} />
                  </span>
                ) : null}
              </span>

              {capture.corners && !capture.pending ? (
                <span className="absolute top-3 left-3 rounded-full bg-signal/85 px-2 py-0.5 text-caption-2 leading-tight font-semibold text-[var(--color-on-signal)]">
                  {s.croppedBadge}
                </span>
              ) : null}

              <div className="mt-2 flex items-center justify-between gap-1">
                <span className="text-caption text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <div className="flex items-center gap-0.5 pointer-coarse:flex-wrap pointer-coarse:justify-end">
                  <MiniButton
                    label={s.editCorners}
                    action="edit"
                    disabled={capture.pending}
                    onClick={() => onEditCorners(capture.id)}
                  >
                    <Crop aria-hidden="true" className="size-3" />
                  </MiniButton>
                  {capture.corners ? (
                    <MiniButton
                      label={s.undoCrop}
                      action="undo"
                      disabled={capture.pending}
                      onClick={() => onUndoCrop(capture.id)}
                    >
                      <Undo2 aria-hidden="true" className="size-3" />
                    </MiniButton>
                  ) : null}
                  <MiniButton
                    label={t.tool.moveUp}
                    action="up"
                    disabled={index === 0}
                    onClick={() => onMove(index, -1)}
                  >
                    <ArrowLeft aria-hidden="true" className="size-3" />
                  </MiniButton>
                  <MiniButton
                    label={t.tool.moveDown}
                    action="down"
                    disabled={index === captures.length - 1}
                    onClick={() => onMove(index, 1)}
                  >
                    <ArrowRight aria-hidden="true" className="size-3" />
                  </MiniButton>
                  <MiniButton
                    label={s.removeCapture}
                    action="remove"
                    onClick={() => onRemove(capture.id)}
                  >
                    <Trash2 aria-hidden="true" className="size-3" />
                  </MiniButton>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MiniButton({
  label,
  action,
  disabled,
  onClick,
  children,
}: {
  label: string;
  /** Identifica la accion para llevar el foco a ella (`useFocusTarget` del cliente). */
  action: "edit" | "undo" | "up" | "down" | "remove";
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-capture-action={action}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors pointer-coarse:size-11 hover:bg-white/12 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
