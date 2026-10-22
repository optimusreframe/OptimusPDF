"use client";

import { useEffect, useState } from "react";
import { Archive, Check, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import type { ExtractedAsset } from "@/lib/pdf/extractAssets/types";
import { AssetCard } from "@/app/extract-assets/AssetCard";
import {
  FILTER_ORDER,
  allVisibleSelected,
  fill,
  selectedText,
  type ExtractStrings,
  type FilterId,
  type FormatPreference,
} from "@/app/extract-assets/model";

export type ZipState = { phase: "idle" } | { phase: "working"; done: number; total: number };

export type ExtractGalleryProps = {
  strings: ExtractStrings;
  locale: string;
  assets: readonly ExtractedAsset[];
  visible: readonly ExtractedAsset[];
  counts: Record<FilterId, number>;
  filter: FilterId;
  selected: ReadonlySet<string>;
  busyId: string | null;
  zip: ZipState;
  formatPreference: FormatPreference;
  offersOriginal: boolean;
  onFilter: (filter: FilterId) => void;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onClearSelection: () => void;
  onFormat: (preference: FormatPreference) => void;
  onDetails: (asset: ExtractedAsset) => void;
  onDownload: (asset: ExtractedAsset) => void;
  onSave: (asset: ExtractedAsset) => void;
  onZip: () => void;
  onZipCancel: () => void;
};

/** Tarjetas que se pintan de golpe y las que se anaden en cada turno: con 500 elementos, ningun turno pasa de ~50 ms. */
export const FIRST_BATCH = 48;
export const NEXT_BATCH = 48;

/**
 * Cuantas tarjetas pintar ya: las primeras de golpe y el resto en turnos sucesivos (cediendo el hilo entre medias), para que
 * un resultado de 500 elementos no monte 500 tarjetas en una sola tarea larga. Solo crece (cambiar de filtro no vuelve a
 * empezar): al terminar estan TODAS.
 */
export function useProgressiveCount(total: number): number {
  const [count, setCount] = useState(FIRST_BATCH);
  useEffect(() => {
    if (count >= total) return;
    const timer = window.setTimeout(() => setCount((current) => current + NEXT_BATCH), 0);
    return () => window.clearTimeout(timer);
  }, [count, total]);
  return Math.min(count, Math.max(total, 0));
}

const FILTER_LABEL: Record<Exclude<FilterId, never>, keyof ExtractStrings> = {
  all: "filterAll",
  signature: "filterSignature",
  initials: "filterInitials",
  image: "filterImage",
  logo: "filterLogo",
  stamp: "filterStamp",
  watermark: "filterWatermark",
  other: "filterOther",
};

/** Cuadricula con filtros por tipo (y recuentos), seleccion multiple, formato y «Descargar seleccionados (.zip)». */
export function ExtractGallery(props: ExtractGalleryProps) {
  const {
    strings,
    locale,
    visible,
    counts,
    filter,
    selected,
    busyId,
    zip,
    formatPreference,
    offersOriginal,
  } = props;
  const working = zip.phase === "working";
  const rendered = useProgressiveCount(visible.length);
  const allSelected = allVisibleSelected(selected, visible);
  const someVisibleSelected = visible.some((asset) => selected.has(asset.id));
  const selectedCount = selected.size;

  return (
    <div className="space-y-4">
      <div role="group" aria-label={strings.filtersLabel} className="flex flex-wrap gap-2">
        {FILTER_ORDER.filter((id) => id === "all" || counts[id] > 0 || id === filter).map((id) => {
          const active = id === filter;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              onClick={() => props.onFilter(id)}
              data-filter={id}
              className={cn(
                "inline-flex h-11 items-center gap-2 rounded-full border px-4 text-subheadline font-semibold transition-colors pointer-fine:h-9",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                active
                  ? "border-signal bg-signal/15 text-foreground"
                  : "border-hairline-strong text-muted-foreground hover:text-foreground",
              )}
            >
              {strings[FILTER_LABEL[id]]}
              <span className="tabular-nums text-caption opacity-80">{counts[id]}</span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-ios-sm pr-2 text-subheadline font-semibold text-foreground has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
          <span className="relative flex size-6 shrink-0 items-center justify-center">
            <input
              type="checkbox"
              checked={allSelected}
              disabled={visible.length === 0}
              onChange={props.onToggleAll}
              ref={(element) => {
                if (element) element.indeterminate = !allSelected && someVisibleSelected;
              }}
              data-select-all
              className={cn(
                "peer absolute inset-0 size-full cursor-pointer appearance-none rounded-[7px] border-2 border-hairline-strong bg-white/5",
                "checked:border-signal checked:bg-signal indeterminate:border-signal indeterminate:bg-signal",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
              )}
            />
            <Check
              aria-hidden="true"
              strokeWidth={3}
              className="pointer-events-none size-3.5 scale-50 text-[var(--color-on-signal)] opacity-0 transition-[scale,opacity] peer-checked:scale-100 peer-checked:opacity-100"
            />
          </span>
          {strings.selectAll}
        </label>
        <span className="text-footnote text-muted-foreground tabular-nums">{selectedText(strings, selectedCount)}</span>
        {selectedCount > 0 ? (
          <Button size="sm" variant="ghost" onClick={props.onClearSelection}>
            <X aria-hidden="true" className="size-4" />
            {strings.clearSelection}
          </Button>
        ) : null}
        <span className="text-footnote text-muted-foreground tabular-nums sm:ml-auto">
          {fill(strings.shown, { n: visible.length, total: counts.all })}
        </span>
      </div>

      {offersOriginal ? (
        <div role="group" aria-label={strings.formatLabel} className="flex flex-wrap items-center gap-2">
          <span className="text-footnote text-muted-foreground">{strings.formatLabel}</span>
          {(["png", "original"] as const).map((preference) => (
            <button
              key={preference}
              type="button"
              aria-pressed={formatPreference === preference}
              onClick={() => props.onFormat(preference)}
              title={preference === "original" ? strings.formatOriginalHint : undefined}
              className={cn(
                "inline-flex h-11 items-center rounded-full border px-4 text-subheadline font-semibold pointer-fine:h-9",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                formatPreference === preference ? "border-signal bg-signal/15 text-foreground" : "border-hairline-strong text-muted-foreground",
              )}
            >
              {preference === "png" ? strings.formatPng : strings.formatOriginal}
            </button>
          ))}
        </div>
      ) : null}

      {visible.length === 0 ? (
        <p className="surface-card rounded-ios p-5 text-subheadline text-muted-foreground">{strings.noneInFilter}</p>
      ) : (
        <ul
          role="list"
          aria-label={strings.listLabel}
          className="grid list-none grid-cols-[repeat(auto-fill,minmax(min(15rem,100%),1fr))] gap-3 p-0"
        >
          {visible.slice(0, rendered).map((asset) => (
            <AssetCard
              key={asset.id}
              asset={asset}
              strings={strings}
              locale={locale}
              selected={selected.has(asset.id)}
              busy={busyId === asset.id}
              locked={working}
              onToggle={props.onToggle}
              onDetails={props.onDetails}
              onDownload={props.onDownload}
              onSave={props.onSave}
            />
          ))}
        </ul>
      )}

      {/* Barra de descarga: pegada al borde inferior (sobre la barra de pestanas del movil) mientras haya seleccion. */}
      {selectedCount > 0 ? (
        <div
          data-zip-bar
          className="surface-card sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px)+0.5rem)] z-10 flex flex-wrap items-center gap-3 rounded-ios p-3 md:bottom-4"
        >
          <Button
            variant="primary"
            size="md"
            disabled={working}
            aria-busy={working}
            onClick={props.onZip}
            data-zip
            className="w-full sm:w-auto"
          >
            {working ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Archive aria-hidden="true" className="size-4" />}
            {working ? fill(strings.zipProgress, { done: zip.done, total: zip.total }) : strings.zip}
          </Button>
          {working ? (
            <Button variant="ghost" size="md" onClick={props.onZipCancel}>
              {strings.zipCancel}
            </Button>
          ) : (
            <span className="text-footnote text-muted-foreground tabular-nums">{selectedText(strings, selectedCount)}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
