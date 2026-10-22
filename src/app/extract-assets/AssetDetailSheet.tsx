"use client";

import { Download, PenLine } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";
import { formatFileSize } from "@/lib/pdf/core";
import type { AssetFormat, ExtractedAsset } from "@/lib/pdf/extractAssets/types";
import {
  assetLabel,
  assetPages,
  canSaveToVault,
  confidencePercent,
  fill,
  formatName,
  isProbable,
  sourceName,
  typeLabel,
  type ExtractStrings,
} from "@/app/extract-assets/model";
import { CHECKER_STYLE, useBlobUrl } from "@/app/extract-assets/ui";

export type AssetDetailSheetProps = {
  open: boolean;
  asset: ExtractedAsset | null;
  strings: ExtractStrings;
  locale: string;
  closeLabel: string;
  selected: boolean;
  /** Formato que se esta preparando ahora (su boton se desactiva). */
  busyFormat: AssetFormat | null;
  onClose: () => void;
  onToggle: (id: string) => void;
  onDownload: (asset: ExtractedAsset, format: AssetFormat) => void;
  onSave: (asset: ExtractedAsset) => void;
};

/** Detalle de un elemento: vista grande, tipo y confianza, MOTIVOS del clasificador, donde aparece y descargas por formato. */
export function AssetDetailSheet({
  open,
  asset,
  strings,
  locale,
  closeLabel,
  selected,
  busyFormat,
  onClose,
  onToggle,
  onDownload,
  onSave,
}: AssetDetailSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title={strings.detailTitle} closeLabel={closeLabel} inertBackground initialFocus="[data-detail-first]">
      {asset ? (
        <DetailBody
          asset={asset}
          strings={strings}
          locale={locale}
          selected={selected}
          busyFormat={busyFormat}
          onToggle={onToggle}
          onDownload={onDownload}
          onSave={onSave}
        />
      ) : null}
    </Sheet>
  );
}

function DetailBody({
  asset,
  strings,
  locale,
  selected,
  busyFormat,
  onToggle,
  onDownload,
  onSave,
}: Omit<AssetDetailSheetProps, "open" | "closeLabel" | "onClose" | "asset"> & { asset: ExtractedAsset }) {
  const url = useBlobUrl(asset.thumb);
  const pages = assetPages(asset);
  const textOnly = asset.ref.engine === "text" ? asset.ref.text : null;
  const size = asset.pixel
    ? fill(strings.sizeLine, {
        w: asset.pixel.width,
        h: asset.pixel.height,
        kb: asset.bytesEstimate > 0 ? formatFileSize(asset.bytesEstimate, locale) : "—",
      }) + ` · ${asset.pixel.hasAlpha ? strings.alphaYes : strings.alphaNo}`
    : null;

  return (
    <div className="space-y-5 pb-2" data-asset-detail={asset.id}>
      <div
        className="flex min-h-40 items-center justify-center rounded-ios-sm p-4"
        style={CHECKER_STYLE}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={assetLabel(strings, asset)} className="max-h-64 max-w-full object-contain" />
        ) : textOnly !== null ? (
          <p className="text-center text-title-2 font-semibold break-words text-neutral-700">{textOnly}</p>
        ) : (
          <span className="text-footnote text-neutral-600">{strings.noPreview}</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={isProbable(asset) ? "neutral" : "signal"}>{typeLabel(strings, asset)}</Badge>
        <span className="text-footnote text-muted-foreground tabular-nums">
          {fill(strings.confidence, { n: confidencePercent(asset) })}
        </span>
      </div>

      <section aria-labelledby="extract-detail-reasons">
        <h3 id="extract-detail-reasons" className="ui-label mb-2 text-muted-foreground">
          {strings.reasonsTitle}
        </h3>
        {asset.reasons.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5 text-subheadline text-foreground">
            {asset.reasons.map((reason, index) => (
              <li key={`${index}-${reason}`}>{reason}</li>
            ))}
          </ul>
        ) : (
          <p className="text-subheadline text-muted-foreground">{strings.noReasons}</p>
        )}
      </section>

      <dl className="grid gap-x-4 gap-y-3 text-subheadline sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{strings.foundOnTitle}</dt>
        <dd className="text-foreground">{pages.map((page) => fill(strings.foundOnLine, { page })).join(" · ") || "—"}</dd>
        {size ? (
          <>
            <dt className="text-muted-foreground">{strings.sizeTitle}</dt>
            <dd className="text-foreground tabular-nums">{size}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{strings.sourceTitle}</dt>
        <dd className="text-foreground">{sourceName(strings, asset.source)}</dd>
      </dl>

      <section aria-labelledby="extract-detail-formats">
        <h3 id="extract-detail-formats" className="ui-label mb-2 text-muted-foreground">
          {strings.formatsTitle}
        </h3>
        <div className="flex flex-wrap gap-2">
          {asset.formats.map((format, index) => (
            <Button
              key={format}
              size="md"
              variant={index === 0 ? "primary" : "secondary"}
              disabled={busyFormat !== null}
              aria-busy={busyFormat === format}
              onClick={() => onDownload(asset, format)}
              data-detail-first={index === 0 ? "" : undefined}
              data-format={format}
            >
              <Download aria-hidden="true" className="size-4" />
              {busyFormat === format ? strings.downloading : formatName(strings, format)}
            </Button>
          ))}
        </div>
      </section>

      <div className="flex flex-wrap gap-2 border-t border-hairline pt-4">
        <Button size="md" variant="secondary" aria-pressed={selected} onClick={() => onToggle(asset.id)}>
          {selected ? strings.unselectThis : strings.selectThis}
        </Button>
        {canSaveToVault(asset) ? (
          <Button size="md" variant="secondary" onClick={() => onSave(asset)}>
            <PenLine aria-hidden="true" className="size-4" />
            {strings.saveVault}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
