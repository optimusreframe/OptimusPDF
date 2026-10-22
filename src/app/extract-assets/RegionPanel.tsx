"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Crop, Download, Loader2, PenLine } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Checkbox } from "@/components/ui/Checkbox";
import { cn } from "@/lib/cn";
import { closePdfDocument, downloadBlob, openPdfDocument, renderPageToCanvas } from "@/lib/pdf/core";
import { cropRegion } from "@/lib/pdf/extractAssets";
import { inkErrorKey, isAbortError, type CropFraction } from "@/app/sign-pdf/inkImportModel";
import { RadioChips } from "@/app/extract-assets/RadioChips";
import { RegionSelector, regionPercent } from "@/app/extract-assets/RegionSelector";
import { SaveSignatureSheet } from "@/app/extract-assets/SaveSignatureSheet";
import { fill, isCancellation, type ExtractStrings } from "@/app/extract-assets/model";
import { CHECKER_STYLE, INPUT_CLASS, useBlobUrl } from "@/app/extract-assets/ui";

/** Region inicial: abajo y a la izquierda, donde suele estar la firma de un contrato. */
export const DEFAULT_REGION: CropFraction = { x: 0.12, y: 0.66, width: 0.4, height: 0.12 };
/** Ancho maximo (px) del lienzo con que se MUESTRA la pagina (el recorte se renderiza aparte, a 300-600 ppp). */
const VIEW_MAX_CANVAS = 1400;

type Quality = "300" | "600";
type CropResult = { blob: Blob; width: number; height: number; key: string };

export type RegionPanelProps = {
  file: File;
  /** Pagina mostrada (0-based): la gobierna quien aloja el panel (el aviso de «pagina escaneada» salta a ella). */
  page: number;
  onPageChange: (page: number) => void;
  /** Paginas (0-based) que son una sola imagen. */
  scannedPages: readonly number[];
  strings: ExtractStrings;
  closeLabel: string;
  /** Region viva UNICA de la pagina. */
  onStatus: (text: string, isError?: boolean) => void;
  onSaved: (message: string) => void;
};

/**
 * «Recortar región» (F7 · U7.4): visor de una pagina con un rectangulo tactil, vista previa del recorte limpio
 * (`cropRegion`: pdf.js a 300-600 ppp + `inkExtract`) y las acciones de descargar y guardar en «Firmas guardadas».
 */
export function RegionPanel({ file, page, onPageChange, scannedPages, strings, closeLabel, onStatus, onSaved }: RegionPanelProps) {
  const helpId = useId();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [aspect, setAspect] = useState(0.7727);
  const [width, setWidth] = useState(0);
  const [rendering, setRendering] = useState(false);
  const [pageError, setPageError] = useState(false);
  const [rect, setRect] = useState<CropFraction>(DEFAULT_REGION);
  const [quality, setQuality] = useState<Quality>("300");
  const [clean, setClean] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CropResult | null>(null);
  const [cropError, setCropError] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveKey, setSaveKey] = useState(0);
  const [pageText, setPageText] = useState(String(page + 1));
  const [syncedPage, setSyncedPage] = useState(page);
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const counterRef = useRef(new Map<number, number>());
  const aliveRef = useRef(true);

  // El texto del campo sigue a la pagina cuando cambia desde fuera (botones, aviso de escaneo).
  if (syncedPage !== page) {
    setSyncedPage(page);
    setPageText(String(page + 1));
  }

  const numPages = doc?.numPages ?? 0;
  const scanned = scannedPages.includes(page);
  const key = `${page}|${rect.x.toFixed(4)},${rect.y.toFixed(4)},${rect.width.toFixed(4)},${rect.height.toFixed(4)}|${quality}|${clean}`;
  const fresh = result && result.key === key ? result : null;
  const previewUrl = useBlobUrl(fresh?.blob ?? null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  // El documento se abre una vez por archivo y se cierra al salir.
  useEffect(() => {
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    openPdfDocument(file).then(
      (loaded) => {
        if (cancelled) {
          void closePdfDocument(loaded);
          return;
        }
        opened = loaded;
        setDoc(loaded);
      },
      () => {
        if (!cancelled) setLoadError(true);
      },
    );
    return () => {
      cancelled = true;
      if (opened) void closePdfDocument(opened);
    };
  }, [file]);

  // Ancho disponible (en pasos de 8 px: no se vuelve a pintar la pagina por cada pixel de redimensionado).
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const measure = (): void => setWidth(Math.round(element.clientWidth / 8) * 8);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Pinta la pagina (para MOSTRARLA: el recorte se renderiza aparte, a 300-600 ppp).
  useEffect(() => {
    if (!doc || width <= 0) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        setRendering(true);
        setPageError(false);
      }
    });
    void (async () => {
      try {
        const pdfPage = await doc.getPage(page + 1);
        try {
          const base = pdfPage.getViewport({ scale: 1 });
          if (cancelled) return;
          setAspect(base.width / base.height);
          const dpr = typeof window === "undefined" ? 1 : Math.min(2, window.devicePixelRatio || 1);
          const target = Math.min(VIEW_MAX_CANVAS, width * dpr);
          const canvas = await renderPageToCanvas(pdfPage, { scale: target / base.width, intent: "print" });
          if (cancelled) return;
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.display = "block";
          hostRef.current?.replaceChildren(canvas);
          setRendering(false);
        } finally {
          pdfPage.cleanup();
        }
      } catch {
        if (!cancelled) {
          setPageError(true);
          setRendering(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [doc, page, width]);

  const goTo = useCallback(
    (next: number) => {
      if (numPages === 0) return;
      const clamped = Math.min(numPages - 1, Math.max(0, next));
      if (clamped !== page) onPageChange(clamped);
    },
    [numPages, onPageChange, page],
  );

  const crop = async (): Promise<void> => {
    if (busy) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setCropError(null);
    const runKey = key;
    try {
      const out = await cropRegion(file, page, rect, {
        dpi: Number(quality),
        cleanBackground: clean,
        signal: controller.signal,
      });
      if (!aliveRef.current) return;
      setResult({ blob: out.png, width: out.width, height: out.height, key: runKey });
      onStatus(fill(strings.regionDone, { w: out.width, h: out.height }));
    } catch (error) {
      if (!aliveRef.current || controller.signal.aborted || isCancellation(error) || isAbortError(error)) return;
      const code = inkErrorKey(error);
      const message = code === "noInk" ? strings.regionNoInk : code === "tooDark" ? strings.regionTooDark : strings.regionFailed;
      setCropError(message);
      onStatus(message, true);
    } finally {
      if (aliveRef.current) setBusy(false);
    }
  };

  const download = (): void => {
    if (!fresh) return;
    const count = (counterRef.current.get(page) ?? 0) + 1;
    counterRef.current.set(page, count);
    const pageLabel = String(page + 1).padStart(numPages > 99 ? 3 : 2, "0");
    const name = `p${pageLabel}-${strings.nameRegion}-${String(count).padStart(2, "0")}.png`;
    downloadBlob(fresh.blob, name);
    onStatus(fill(strings.regionDownloaded, { name }));
  };

  const load = useMemo(() => (fresh ? async () => fresh.blob : null), [fresh]);
  /** «Recortar otra» tras guardar: se cierra la hoja, se descarta el recorte ya guardado y el foco vuelve al rectangulo. */
  const cropAnother = (): void => {
    setSaveOpen(false);
    setResult(null);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-region-rect]")?.focus());
  };
  const openSave = (): void => {
    setSaveKey((current) => current + 1);
    setSaveOpen(true);
  };

  const qualityOptions = [
    { value: "300" as const, label: strings.regionQualityNormal },
    { value: "600" as const, label: strings.regionQualityHigh },
  ];

  if (loadError) {
    return (
      <p role="alert" className="surface-card rounded-ios p-5 text-subheadline text-destructive-text">
        {strings.regionLoadError}
      </p>
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 space-y-3">
        <p id={helpId} className="text-subheadline text-muted-foreground">
          {strings.regionIntro}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="md" variant="secondary" disabled={page <= 0 || numPages === 0} onClick={() => goTo(page - 1)} aria-label={strings.regionPrev}>
            <ChevronLeft aria-hidden="true" className="size-4" />
          </Button>
          <label className="flex min-w-0 flex-wrap items-center gap-x-2 text-subheadline text-muted-foreground">
            <span>{strings.regionPageLabel}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={Math.max(1, numPages)}
              value={pageText}
              disabled={numPages === 0}
              onChange={(event) => {
                setPageText(event.target.value);
                const value = Number.parseInt(event.target.value, 10);
                if (Number.isInteger(value) && value >= 1 && value <= numPages) goTo(value - 1);
              }}
              onBlur={() => setPageText(String(page + 1))}
              data-region-page
              className={cn(INPUT_CLASS, "w-20 shrink-0 text-center tabular-nums")}
            />
            <span className="whitespace-nowrap tabular-nums">{numPages > 0 ? fill(strings.regionPageOf, { total: numPages }) : ""}</span>
          </label>
          <Button size="md" variant="secondary" disabled={numPages === 0 || page >= numPages - 1} onClick={() => goTo(page + 1)} aria-label={strings.regionNext}>
            <ChevronRight aria-hidden="true" className="size-4" />
          </Button>
        </div>
        {scanned ? (
          <p className="rounded-ios-sm border border-hairline-strong p-3 text-subheadline text-foreground" data-region-scanned>
            {strings.regionScanned}
          </p>
        ) : null}
        {/* El relleno de 22 px deja sitio a las asas de 44 px que sobresalen de las esquinas de la pagina. */}
        <div ref={wrapRef} className="px-[22px] py-[22px]">
          <div className="relative mx-auto max-w-[900px] overflow-visible rounded-sm bg-white shadow-elevation-2" style={{ aspectRatio: String(aspect) }}>
            <div
              ref={hostRef}
              role="img"
              aria-label={doc ? fill(strings.regionPageAlt, { page: page + 1, total: numPages }) : strings.regionLoading}
              className="absolute inset-0 overflow-hidden rounded-sm"
              data-region-page-canvas
            />
            {rendering || (!doc && !loadError) ? (
              <div className="absolute inset-0 flex items-center justify-center" aria-hidden="true">
                <Loader2 className="size-6 animate-spin text-neutral-500" />
              </div>
            ) : null}
            {pageError ? (
              <p role="alert" className="absolute inset-x-3 top-3 rounded-ios-sm bg-white p-3 text-subheadline text-destructive-text">
                {strings.regionLoadError}
              </p>
            ) : null}
            {doc && !pageError ? <RegionSelector rect={rect} onChange={setRect} strings={strings} onAnnounce={(text) => onStatus(text)} describedBy={helpId} /> : null}
          </div>
        </div>
        <p className="text-footnote text-muted-foreground">{strings.regionTapHint}</p>
      </div>

      <div className="min-w-0 space-y-4">
        <div className="surface-card space-y-4 rounded-ios p-4">
          <Checkbox label={strings.regionClean} hint={strings.regionCleanHint} checked={clean} onChange={setClean} />
          <RadioChips legend={strings.regionQuality} name="extract-region-quality" value={quality} options={qualityOptions} onChange={setQuality} />
          <Button size="lg" fullWidth disabled={busy || !doc || pageError} aria-busy={busy} onClick={() => void crop()} data-region-crop>
            {busy ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Crop aria-hidden="true" className="size-4" />}
            {busy ? strings.regionCropping : strings.regionCrop}
          </Button>
          {cropError ? <p className="text-footnote text-destructive-text">{cropError}</p> : null}
        </div>

        {fresh ? (
          <section className="surface-card space-y-3 rounded-ios p-4" aria-labelledby={`${helpId}-preview`} data-region-result>
            <h3 id={`${helpId}-preview`} className="ui-label text-muted-foreground">
              {strings.regionPreviewTitle}
            </h3>
            <div className="flex min-h-28 items-center justify-center rounded-ios-sm p-3" style={CHECKER_STYLE}>
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={previewUrl} alt={strings.regionPreviewAlt} className="max-h-48 max-w-full object-contain" data-region-preview />
              ) : null}
            </div>
            <p className="text-footnote text-muted-foreground tabular-nums">{fill(strings.regionResultInfo, { w: fresh.width, h: fresh.height })}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="md" variant="secondary" onClick={download} data-region-download>
                <Download aria-hidden="true" className="size-4" />
                {strings.regionDownload}
              </Button>
              <Button size="md" variant="secondary" onClick={(event) => {
                  event.currentTarget.focus();
                  openSave();
                }}
                data-region-save
              >
                <PenLine aria-hidden="true" className="size-4" />
                {strings.saveVault}
              </Button>
            </div>
          </section>
        ) : null}
      </div>

      <SaveSignatureSheet
        open={saveOpen}
        instanceKey={saveKey}
        onClose={() => setSaveOpen(false)}
        strings={strings}
        closeLabel={closeLabel}
        sourceDocument={file.name}
        load={load}
        preCleaned={clean}
        hasAlpha={clean}
        defaultKind="signature"
        onSaved={onSaved}
        onCropAnother={cropAnother}
      />
      <span hidden>{regionPercent(rect).left}</span>
    </div>
  );
}
