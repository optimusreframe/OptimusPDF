"use client";

import { ArrowLeft, ArrowRight, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { ScanFilter } from "@/lib/pdf/scanToPdf";
import { STRINGS } from "@/app/scan-to-pdf/strings";
import { previewFilter } from "@/app/scan-to-pdf/preview";

export type ScanCapture = {
  id: string;
  blob: Blob;
  /** Object URL para la miniatura; lo revoca el componente padre. */
  url: string;
};

export type CaptureStripProps = {
  captures: ScanCapture[];
  filter: ScanFilter;
  onMove: (index: number, offset: number) => void;
  onRemove: (id: string) => void;
};

/** Tira de miniaturas de las paginas capturadas, en orden de aparicion. */
export function CaptureStrip({
  captures,
  filter,
  onMove,
  onRemove,
}: CaptureStripProps) {
  const { t, language } = useI18n();
  const s = STRINGS[language];

  return (
    <div>
      <h3 className="hud-label mb-3 text-[11px] text-muted-foreground">
        {s.capturesTitle}
      </h3>

      {captures.length === 0 ? (
        <p className="text-sm text-muted-foreground">{s.capturesEmpty}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {captures.map((capture, index) => (
            <li
              key={capture.id}
              className="glass rounded-ios-sm relative overflow-hidden p-2"
            >
              <span className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-[10px] bg-white/5">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={capture.url}
                  alt={`${s.captureAlt} ${index + 1}`}
                  className="max-h-full max-w-full object-contain"
                  style={{ filter: previewFilter(filter) }}
                />
              </span>

              <div className="mt-2 flex items-center justify-between gap-1">
                <span className="hud-label text-[9px] text-muted-foreground">
                  {index + 1}
                </span>
                <div className="flex items-center gap-0.5">
                  <MiniButton
                    label={t.tool.moveUp}
                    disabled={index === 0}
                    onClick={() => onMove(index, -1)}
                  >
                    <ArrowLeft aria-hidden="true" className="size-3" />
                  </MiniButton>
                  <MiniButton
                    label={t.tool.moveDown}
                    disabled={index === captures.length - 1}
                    onClick={() => onMove(index, 1)}
                  >
                    <ArrowRight aria-hidden="true" className="size-3" />
                  </MiniButton>
                  <MiniButton
                    label={s.removeCapture}
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
      className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/12 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
