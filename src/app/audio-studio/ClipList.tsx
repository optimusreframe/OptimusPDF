"use client";

import { ChevronDown, ChevronUp, X } from "lucide-react";
import { HIT_44 } from "@/components/ui/touchTarget";
import { cn } from "@/lib/cn";
import { segmentLength, type Track } from "@/lib/media/audio/edit";
import { formatClock } from "@/lib/media/audio/format";

/**
 * Lista de clips de la pista, EN EL ORDEN en que suenan. Reordenar con botones Subir/Bajar (sin arrastre: sirve con
 * teclado y con lector de pantalla) y quitar un clip. Cada boton nombra el clip, asi no hay etiquetas repetidas.
 */
export type ClipListStrings = {
  title: string;
  hint: string;
  moveUp: string;
  moveDown: string;
  remove: string;
  clipOf: string;
};

export type ClipListProps = {
  track: Track;
  strings: ClipListStrings;
  disabled?: boolean;
  onMove: (from: number, to: number) => void;
  onRemove: (index: number) => void;
};

const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (m, k: string) => values[k] ?? m);

const ICON_BUTTON =
  "flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-signal disabled:pointer-events-none disabled:opacity-40";

export function ClipList({ track, strings, disabled = false, onMove, onRemove }: ClipListProps) {
  const count = track.segments.length;
  return (
    <section aria-labelledby="studio-clips-title">
      <h2 id="studio-clips-title" className="ui-label mb-1 text-muted-foreground">
        {strings.title}
      </h2>
      <p className="mb-3 text-footnote text-muted-foreground">{strings.hint}</p>
      <ol className="surface-card divide-y divide-hairline overflow-hidden rounded-ios">
        {track.segments.map((segment, index) => (
          <li key={segment.id} className="flex items-center gap-2 px-3 py-2" aria-label={fill(strings.clipOf, { index: String(index + 1), total: String(count) })}>
            <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/8 text-caption text-muted-foreground tabular-nums">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-subheadline font-medium text-foreground">{segment.name}</p>
              <p className="text-footnote text-muted-foreground tabular-nums">{formatClock(segmentLength(segment) / track.sampleRate)}</p>
            </div>
            <button type="button" className={cn(ICON_BUTTON, HIT_44)} disabled={disabled || index === 0} aria-label={fill(strings.moveUp, { index: String(index + 1), name: segment.name })} onClick={() => onMove(index, index - 1)}>
              <ChevronUp aria-hidden="true" className="size-5" />
            </button>
            <button type="button" className={cn(ICON_BUTTON, HIT_44)} disabled={disabled || index === count - 1} aria-label={fill(strings.moveDown, { index: String(index + 1), name: segment.name })} onClick={() => onMove(index, index + 1)}>
              <ChevronDown aria-hidden="true" className="size-5" />
            </button>
            <button type="button" className={cn(ICON_BUTTON, HIT_44)} disabled={disabled} aria-label={fill(strings.remove, { index: String(index + 1), name: segment.name })} onClick={() => onRemove(index)}>
              <X aria-hidden="true" className="size-5" />
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
