"use client";

import { memo } from "react";
import { Check, Download, Info, PenLine } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { formatFileSize } from "@/lib/pdf/core";
import type { ExtractedAsset } from "@/lib/pdf/extractAssets/types";
import {
  assetLabel,
  assetPages,
  canSaveToVault,
  fill,
  isProbable,
  pagesText,
  sizeText,
  typeLabel,
  type ExtractStrings,
  type Ordinal,
} from "@/app/extract-assets/model";
import { CHECKER_STYLE, useBlobUrl } from "@/app/extract-assets/ui";

export type AssetCardProps = {
  asset: ExtractedAsset;
  /** Posicion entre los que se llaman igual («1 de 2»): lo distingue el lector de pantalla. */
  ordinal?: Ordinal;
  strings: ExtractStrings;
  locale: string;
  selected: boolean;
  /** Descargando este elemento (el boton se desactiva y lo dice). */
  busy: boolean;
  /** Hay otra tarea larga en curso (ZIP): no se lanzan descargas a la vez. */
  locked: boolean;
  onToggle: (id: string) => void;
  onDetails: (asset: ExtractedAsset) => void;
  onDownload: (asset: ExtractedAsset) => void;
  onSave: (asset: ExtractedAsset) => void;
};

/**
 * Tarjeta de la galeria: miniatura sobre damero, casilla de 44 px (su nombre ES el nombre del elemento: «Firma probable,
 * página 3, 420 × 140 px»), chip de tipo, pagina y tamano, y las acciones. `memo`: con 500 elementos, marcar uno no repinta
 * los demas.
 */
export const AssetCard = memo(function AssetCard({
  asset,
  ordinal,
  strings,
  locale,
  selected,
  busy,
  locked,
  onToggle,
  onDetails,
  onDownload,
  onSave,
}: AssetCardProps) {
  const label = assetLabel(strings, asset, ordinal);
  const url = useBlobUrl(asset.thumb);
  const pages = assetPages(asset);
  const probable = isProbable(asset);
  const textOnly = asset.ref.engine === "text" ? asset.ref.text : null;
  const meta = [
    pages.length > 1 ? fill(strings.repeatedIn, { n: pages.length }) : pagesText(strings, pages),
    sizeText(strings, asset),
    asset.bytesEstimate > 0 ? formatFileSize(asset.bytesEstimate, locale) : "",
  ].filter(Boolean);

  return (
    <li
      aria-label={label}
      data-asset-id={asset.id}
      data-asset-kind={asset.kind}
      className={cn(
        "surface-card flex min-w-0 flex-col overflow-hidden rounded-ios",
        selected && "ring-2 ring-signal",
      )}
    >
      <div className="relative flex aspect-[4/3] items-center justify-center p-3" style={CHECKER_STYLE}>
        {url ? (
          // Decorativa: el nombre del elemento ya esta en la casilla y en la lista.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" decoding="async" loading="lazy" className="max-h-full max-w-full object-contain" draggable={false} />
        ) : textOnly !== null ? (
          <p className="line-clamp-3 w-full text-center text-title-3 font-semibold break-words text-neutral-700">{textOnly}</p>
        ) : (
          <span className="text-footnote text-neutral-600">{strings.noPreview}</span>
        )}
        <label className="absolute top-0 left-0 flex size-11 cursor-pointer items-center justify-center">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggle(asset.id)}
            aria-label={label}
            data-asset-select
            className={cn(
              "peer size-6 shrink-0 cursor-pointer appearance-none rounded-[7px] border-2 border-[#52525b] bg-[#ffffff]",
              "checked:border-signal checked:bg-signal",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
            )}
          />
          <Check
            aria-hidden="true"
            strokeWidth={3}
            className="pointer-events-none absolute size-3.5 scale-50 text-[var(--color-on-signal)] opacity-0 transition-[scale,opacity] peer-checked:scale-100 peer-checked:opacity-100"
          />
        </label>
      </div>
      <div className="flex flex-1 flex-col gap-3 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={probable ? "neutral" : "signal"}>{typeLabel(strings, asset)}</Badge>
          {ordinal ? <span className="text-footnote text-muted-foreground tabular-nums">{fill(strings.ordinalShort, ordinal)}</span> : null}
        </div>
        <p className="text-footnote text-muted-foreground tabular-nums">{meta.join(" · ")}</p>
        <div className="mt-auto flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || locked}
            aria-label={fill(strings.downloadOf, { label })}
            aria-busy={busy}
            onClick={() => onDownload(asset)}
          >
            <Download aria-hidden="true" className="size-4" />
            {busy ? strings.downloading : strings.download}
          </Button>
          <Button size="sm" variant="ghost" aria-label={fill(strings.detailsOf, { label })} onClick={(event) => {
              // Safari no enfoca un boton al tocarlo: sin esto la hoja no sabria a quien devolver el foco al cerrarse.
              event.currentTarget.focus();
              onDetails(asset);
            }}
          >
            <Info aria-hidden="true" className="size-4" />
            {strings.details}
          </Button>
          {canSaveToVault(asset) ? (
            <Button size="sm" variant="ghost" aria-label={fill(strings.saveVaultOf, { label })} onClick={(event) => {
                event.currentTarget.focus();
                onSave(asset);
              }}
            >
              <PenLine aria-hidden="true" className="size-4" />
              {strings.saveVaultShort}
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
});
