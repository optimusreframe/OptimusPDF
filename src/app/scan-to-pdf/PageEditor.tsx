"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Crop, Maximize, RefreshCw, RotateCw, ScanSearch, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Slider } from "@/components/ui/Slider";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { cn } from "@/lib/cn";
import type { ScanFilterMode, ScanPage } from "@/lib/scan/types";
import { FullscreenLayer } from "@/app/scan-to-pdf/FullscreenLayer";
import { useBlobUrl } from "@/app/scan-to-pdf/useBlobUrl";
import type { ScanToPdfStrings } from "@/app/scan-to-pdf/strings";

export const FILTER_ORDER: ScanFilterMode[] = ["auto", "color", "grayscale", "bw", "enhance", "original"];
/** Silencio (ms) tras mover un deslizador antes de pedir el recalculo al motor. */
export const ADJUST_COMMIT_MS = 350;

/** Aproximacion CSS del brillo/contraste mientras se arrastra: el resultado real lo calcula el motor al soltar. */
export function adjustPreview(brightness: number, contrast: number): string | undefined {
  if (brightness === 0 && contrast === 0) return undefined;
  return `brightness(${(1 + brightness * 0.5).toFixed(2)}) contrast(${(1 + contrast * 0.6).toFixed(2)})`;
}

export type PageEditorProps = {
  s: ScanToPdfStrings;
  pages: readonly ScanPage[];
  pageId: string;
  /** La vista COMPLETA de la pagina esta al dia con sus ajustes (si no, se muestra el aviso de proceso). */
  isFresh: (page: ScanPage) => boolean;
  /** Pide el resultado completo de la pagina que se esta viendo (la miniatura rapida no basta aqui). */
  onNeedFull: (id: string) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  onRotate: (id: string) => void;
  onFilter: (id: string, filter: ScanFilterMode) => void;
  onAdjust: (id: string, brightness: number, contrast: number) => void;
  onCrop: (id: string) => void;
  onRetake: (id: string) => void;
  onViewSheet: (id: string) => void;
  onApplyAll: (id: string) => void;
};

export function PageEditor({ s, pages, pageId, isFresh, onNeedFull, onSelect, onClose, onRotate, onFilter, onAdjust, onCrop, onRetake, onViewSheet, onApplyAll }: PageEditorProps) {
  const index = Math.max(0, pages.findIndex((page) => page.id === pageId));
  const page = pages[index];
  const url = useBlobUrl(page?.processed ?? page?.thumb ?? page?.original);
  const [tab, setTab] = useState<"filter" | "adjust">("filter");
  const [draft, setDraft] = useState<{ id: string; brightness: number; contrast: number } | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onAdjustRef = useRef(onAdjust);
  useEffect(() => {
    onAdjustRef.current = onAdjust;
  });
  const pageKey = page ? `${page.id}|${page.processed ? "p" : "-"}|${page.rotation}|${page.filter}|${page.adjust.brightness}|${page.adjust.contrast}|${page.corners ? "c" : "-"}` : "";
  const needFullRef = useRef(onNeedFull);
  useEffect(() => {
    needFullRef.current = onNeedFull;
  });
  // Cada vez que cambia la pagina que se ve (o sus ajustes) se pide su resultado completo si aun no esta al dia.
  useEffect(() => {
    if (pageKey) needFullRef.current(pageId);
  }, [pageKey, pageId]);
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  if (!page) return null;
  const brightness = draft?.id === page.id ? draft.brightness : page.adjust.brightness;
  const contrast = draft?.id === page.id ? draft.contrast : page.adjust.contrast;
  const fresh = isFresh(page);

  const changeAdjust = (next: { brightness: number; contrast: number }) => {
    setDraft({ id: page.id, ...next });
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      onAdjustRef.current(page.id, next.brightness, next.contrast);
      setDraft(null);
    }, ADJUST_COMMIT_MS);
  };

  const go = (delta: number) => {
    const target = pages[index + delta];
    if (target) onSelect(target.id);
  };

  return (
    <FullscreenLayer label={s.editorTitle(index + 1, pages.length)} onEscape={onClose} initialFocus='[data-editor-action="done"]' dataAttr="data-page-editor">
      <header className="flex items-center justify-between gap-2 px-3" style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top, 0px))" }}>
        <h2 className="min-w-0 truncate text-callout font-semibold" data-editor-title="">
          {s.editorTitle(index + 1, pages.length)}
        </h2>
        <Button size="md" data-editor-action="done" onClick={onClose}>
          {s.editorDone}
        </Button>
      </header>

      <div className="relative mt-2 min-h-0 flex-1 bg-black/90">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            data-editor-preview=""
            src={url}
            alt={s.editorPreviewAlt(index + 1)}
            draggable={false}
            className="absolute inset-0 size-full object-contain select-none"
            style={{ filter: adjustPreview(brightness - page.adjust.brightness, contrast - page.adjust.contrast) }}
          />
        ) : null}
        {!fresh ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/35" data-editor-processing="">
            <RefreshCw aria-hidden="true" className="size-6 animate-spin text-white motion-reduce:animate-none" />
            <span className="sr-only">{s.processing}</span>
          </span>
        ) : null}
        <button
          type="button"
          aria-label={s.editorPrev}
          data-editor-action="prev"
          disabled={index === 0}
          onClick={() => go(-1)}
          className="absolute top-1/2 left-2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white outline-none focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-30"
        >
          <ChevronLeft aria-hidden="true" className="size-6" />
        </button>
        <button
          type="button"
          aria-label={s.editorNext}
          data-editor-action="next"
          disabled={index === pages.length - 1}
          onClick={() => go(1)}
          className="absolute top-1/2 right-2 flex size-11 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white outline-none focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-30"
        >
          <ChevronRight aria-hidden="true" className="size-6" />
        </button>
      </div>

      <div className="shrink-0 border-t border-hairline bg-surface px-3 pt-2" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom, 0px))" }}>
        <div className="grid grid-cols-4 gap-1.5">
          <EditorTool label={s.editorCrop} action="crop" onClick={() => onCrop(page.id)}>
            <Crop aria-hidden="true" className="size-5" />
          </EditorTool>
          <EditorTool label={s.editorRotate} action="rotate" onClick={() => onRotate(page.id)}>
            <RotateCw aria-hidden="true" className="size-5" />
          </EditorTool>
          <EditorTool label={s.retake} action="retake" onClick={() => onRetake(page.id)}>
            <ScanSearch aria-hidden="true" className="size-5" />
          </EditorTool>
          <EditorTool label={s.viewSheet} action="sheet" onClick={() => onViewSheet(page.id)}>
            <Maximize aria-hidden="true" className="size-5" />
          </EditorTool>
        </div>

        <div className="mt-2">
          <SegmentedControl<"filter" | "adjust">
            label={s.editorFilter}
            hideLabel
            value={tab}
            onChange={setTab}
            options={[
              { value: "filter", label: s.editorFilter },
              { value: "adjust", label: s.editorAdjust },
            ]}
          />
        </div>

        <div className="mt-2 min-h-[5.5rem]">
          {tab === "filter" ? (
            <div role="group" aria-label={s.filterLabel} data-filter-chips="" className="-mx-3 overflow-x-auto px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" style={{ touchAction: "pan-x" }}>
              <div className="flex w-max gap-2">
                {FILTER_ORDER.map((filter) => {
                  const active = page.filter === filter;
                  return (
                    <button
                      key={filter}
                      type="button"
                      data-filter={filter}
                      aria-pressed={active}
                      onClick={() => onFilter(page.id, filter)}
                      className={cn(
                        "inline-flex h-11 shrink-0 items-center rounded-full border px-4 text-subheadline font-semibold whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                        active ? "border-signal bg-signal text-[var(--color-on-signal)]" : "border-hairline bg-white/5 text-foreground",
                      )}
                    >
                      {s.filters[filter]}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-2" data-adjust-panel="">
              <Slider label={s.brightness} value={Math.round(brightness * 100)} min={-100} max={100} step={5} onChange={(value) => changeAdjust({ brightness: value / 100, contrast })} />
              <Slider label={s.contrast} value={Math.round(contrast * 100)} min={-100} max={100} step={5} onChange={(value) => changeAdjust({ brightness, contrast: value / 100 })} />
            </div>
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="md" wrap className="min-w-0 flex-1 basis-40" data-editor-action="apply-all" onClick={() => onApplyAll(page.id)}>
            {s.editorApplyAll}
          </Button>
          {tab === "adjust" ? (
            <Button variant="ghost" size="md" wrap data-editor-action="reset-adjust" onClick={() => changeAdjust({ brightness: 0, contrast: 0 })}>
              {s.resetAdjust}
            </Button>
          ) : null}
        </div>
      </div>
    </FullscreenLayer>
  );
}

function EditorTool({ label, action, onClick, children }: { label: string; action: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      data-editor-action={action}
      onClick={onClick}
      className="flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-ios-sm border border-hairline bg-white/5 px-1 py-1.5 text-center text-caption leading-tight font-semibold text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal active:scale-[0.97]"
    >
      {children}
      <span>{label}</span>
    </button>
  );
}

export type SheetViewerProps = {
  s: ScanToPdfStrings;
  pages: readonly ScanPage[];
  pageId: string;
  onNeedFull: (id: string) => void;
  onSelect: (id: string) => void;
  onClose: () => void;
  onEdit: (id: string) => void;
};

/** Vista de hoja completa: la pagina ya procesada, a pantalla completa, con zoom al tamano real para revisar la nitidez. */
export function SheetViewer({ s, pages, pageId, onNeedFull, onSelect, onClose, onEdit }: SheetViewerProps) {
  const index = Math.max(0, pages.findIndex((page) => page.id === pageId));
  const page = pages[index];
  const url = useBlobUrl(page?.processed ?? page?.thumb ?? page?.original);
  const [actual, setActual] = useState(false);
  const sheetKey = page ? `${page.id}|${page.processed ? "p" : "-"}|${page.rotation}|${page.filter}|${page.adjust.brightness}|${page.adjust.contrast}` : "";
  const needFullRef = useRef(onNeedFull);
  useEffect(() => {
    needFullRef.current = onNeedFull;
  });
  useEffect(() => {
    if (sheetKey) needFullRef.current(pageId);
  }, [sheetKey, pageId]);
  if (!page) return null;
  const go = (delta: number) => {
    const target = pages[index + delta];
    if (target) onSelect(target.id);
  };
  return (
    <FullscreenLayer label={s.sheetTitle(index + 1, pages.length)} tone="dark" onEscape={onClose} initialFocus='[data-sheet-action="close"]' dataAttr="data-sheet-viewer">
      <header className="flex items-center justify-between gap-2 px-3" style={{ paddingTop: "calc(0.5rem + env(safe-area-inset-top, 0px))" }}>
        <h2 className="min-w-0 truncate text-callout font-semibold">{s.sheetTitle(index + 1, pages.length)}</h2>
        <button type="button" data-sheet-action="close" aria-label={s.close} onClick={onClose} className="flex size-11 items-center justify-center rounded-full bg-white/15 text-white outline-none focus-visible:outline-2 focus-visible:outline-signal">
          <X aria-hidden="true" className="size-5" />
        </button>
      </header>
      <p className="px-3 pb-1 text-footnote text-white/75">{s.sheetHint}</p>
      <div
        data-sheet-scroll=""
        tabIndex={0}
        aria-label={s.sheetTitle(index + 1, pages.length)}
        role="region"
        className="min-h-0 flex-1 overflow-auto bg-black outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-signal"
        style={{ touchAction: "pan-x pan-y pinch-zoom" }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            data-sheet-image=""
            src={url}
            alt={s.editorPreviewAlt(index + 1)}
            draggable={false}
            className={cn("mx-auto block select-none", actual ? "max-w-none" : "max-h-full max-w-full object-contain")}
            style={actual ? undefined : { width: "100%", height: "100%" }}
          />
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-3 pt-2" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom, 0px))" }}>
        <div className="flex gap-2">
          <button type="button" aria-label={s.editorPrev} data-sheet-action="prev" disabled={index === 0} onClick={() => go(-1)} className="flex size-11 items-center justify-center rounded-full bg-white/15 text-white outline-none focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-30">
            <ChevronLeft aria-hidden="true" className="size-5" />
          </button>
          <button type="button" aria-label={s.editorNext} data-sheet-action="next" disabled={index === pages.length - 1} onClick={() => go(1)} className="flex size-11 items-center justify-center rounded-full bg-white/15 text-white outline-none focus-visible:outline-2 focus-visible:outline-signal disabled:opacity-30">
            <ChevronRight aria-hidden="true" className="size-5" />
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" data-sheet-action="zoom" aria-pressed={actual} onClick={() => setActual((value) => !value)} className="inline-flex min-h-11 max-w-full items-center justify-center rounded-ios-sm border border-white/25 bg-white/15 px-4 py-2 text-center text-callout font-semibold text-white outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal">
            {actual ? s.sheetFit : s.sheetActual}
          </button>
          <Button size="md" wrap data-sheet-action="edit" onClick={() => onEdit(page.id)}>
            {s.edit}
          </Button>
        </div>
      </div>
    </FullscreenLayer>
  );
}
