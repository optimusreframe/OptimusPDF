"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { useEditDocument } from "@/app/edit-pdf/useEditDocument";
import {
  renderPageToDataUrl,
  toPdfError,
  type PdfErrorCode,
} from "@/lib/pdf/core";
import {
  RasterCache,
  RasterUnavailableError,
  bucketZoom,
  isRasterCancelled,
  planRaster,
  renderPageRaster,
  type RasterPlan,
} from "@/lib/pdf/pageRaster";

/*
 * Imagen NITIDA de la pagina visible de Firmar (W6-A).
 *
 * Un `PDFDocumentProxy` por archivo (no se reabre en cada pagina), la pagina se
 * dibuja a `ancho mostrado x zoom x devicePixelRatio` (con tope de memoria) y se
 * vuelve a dibujar al cambiar el zoom, el ancho o la densidad de pantalla. Cada
 * render nuevo cancela el anterior; los ya hechos viven en una cache LRU con
 * limite; si el motor de render no esta disponible (o falla) se cae, sin
 * romper nada, a la vista previa de baja resolucion de siempre.
 */

/** Ancho de maquetacion de la hoja si aun no se ha medido (el maximo del lienzo). */
export const DEFAULT_LAYOUT_WIDTH = 640;
/** Espera antes de repetir un render por zoom/ancho (el pellizco manda muchos). */
export const RERENDER_DEBOUNCE_MS = 120;

export type PageImageParams = {
  file: File | null;
  pageIndex: number;
  /** Ancho (px CSS) de la hoja SIN zoom; 0 = aun sin medir. */
  layoutWidth: number;
  zoom: number;
  onError?: (code: PdfErrorCode) => void;
};

export type PageImage = {
  /** URL de la imagen mostrada (la de la ultima pagina lista, mientras llega la nueva). */
  src: string | null;
  /** Pagina (base 0) a la que pertenece `src`. */
  srcPage: number | null;
  /** Ancho real (px) de `src`; 0 en el respaldo. */
  pixelWidth: number;
  /** `true` = render nitido; `false` = respaldo de baja resolucion. */
  sharp: boolean;
  /** Aun no hay imagen de la pagina pedida. */
  loading: boolean;
  /** Ancho / alto de la pagina pedida, leido del propio PDF (con su rotacion). */
  aspect: number | null;
  pageCount: number;
  doc: PDFDocumentProxy | null;
  /** La pagina de pdf.js de la pagina pedida (para medir su geometria), o `null` mientras llega. */
  page: PDFPageProxy | null;
  /** La pagina pedida trae texto extraible; `null` = no se sabe. */
  hasText: boolean | null;
};

type PageInfo = {
  doc: PDFDocumentProxy;
  pageIndex: number;
  page: PDFPageProxy;
  view: { width: number; height: number } | null;
};

type Shown = {
  url: string;
  page: number;
  sharp: boolean;
  pixelWidth: number;
};

/** Densidad de pantalla actual; se actualiza si la ventana pasa a otro monitor. */
function useDevicePixelRatio(): number {
  const [ratio, setRatio] = useState(() =>
    typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
  );
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let query: MediaQueryList | null = null;
    const update = () => {
      query?.removeEventListener("change", update);
      const next = window.devicePixelRatio || 1;
      setRatio(next);
      query = window.matchMedia(`(resolution: ${next}dppx)`);
      query.addEventListener("change", update);
    };
    query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener("change", update);
    return () => query?.removeEventListener("change", update);
  }, []);
  return ratio;
}

export function usePageImage({
  file,
  pageIndex,
  layoutWidth,
  zoom,
  onError,
}: PageImageParams): PageImage {
  const { doc, pageCount, error } = useEditDocument(file);
  const [info, setInfo] = useState<PageInfo | null>(null);
  const [textInfo, setTextInfo] = useState<{
    doc: PDFDocumentProxy;
    pageIndex: number;
    hasText: boolean;
  } | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  const pixelRatio = useDevicePixelRatio();

  const errorRef = useRef(onError);
  useEffect(() => {
    errorRef.current = onError;
  });
  useEffect(() => {
    if (error) errorRef.current?.(error);
  }, [error]);

  /* Cache por documento: se vacia (y se liberan sus URL) al cambiar de archivo o desmontar. */
  const cacheRef = useRef<RasterCache | null>(null);
  if (cacheRef.current === null) cacheRef.current = new RasterCache();
  useEffect(() => {
    const cache = cacheRef.current;
    return () => cache?.clear();
  }, [doc]);

  /* La pagina de pdf.js y su tamano. */
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    let opened: PDFPageProxy | null = null;
    void (async () => {
      try {
        const number = Math.min(Math.max(1, pageIndex + 1), Math.max(1, doc.numPages));
        const page = await doc.getPage(number);
        if (cancelled) {
          page.cleanup();
          return;
        }
        opened = page;
        const viewport = page.getViewport?.({ scale: 1 });
        setInfo({
          doc,
          pageIndex,
          page,
          view:
            viewport && viewport.width > 0 && viewport.height > 0
              ? { width: viewport.width, height: viewport.height }
              : null,
        });
        if (typeof page.getTextContent === "function") {
          try {
            const content = await page.getTextContent();
            if (!cancelled) {
              setTextInfo({
                doc,
                pageIndex,
                hasText: content.items.some((item) => "str" in item && item.str.trim().length > 0),
              });
            }
          } catch {
            // Sin analisis de texto no hay accion de buscar huecos; nada mas.
          }
        }
      } catch (caught) {
        if (!cancelled) errorRef.current?.(toPdfError(caught).code);
      }
    })();
    return () => {
      cancelled = true;
      try {
        opened?.cleanup();
      } catch {
        // Nada que liberar.
      }
    };
  }, [doc, pageIndex]);

  const current = info && info.doc === doc && info.pageIndex === pageIndex ? info : null;
  const effectiveWidth = layoutWidth > 0 ? layoutWidth : DEFAULT_LAYOUT_WIDTH;
  const zoomStep = bucketZoom(zoom);
  const plan: RasterPlan | null = useMemo(
    () =>
      current?.view
        ? planRaster(current.view, { cssWidth: effectiveWidth, zoom: zoomStep, pixelRatio })
        : null,
    [current, effectiveWidth, zoomStep, pixelRatio],
  );

  /** Tras un `RasterUnavailableError` no se vuelve a intentar el render nitido en este documento. */
  const sharpUnavailableRef = useRef(false);
  const shownPageRef = useRef<number | null>(null);
  useEffect(() => {
    shownPageRef.current = shown?.page ?? null;
  });

  /* Render nitido (o respaldo), cancelable y con cache. */
  const planKey = plan ? `${plan.width}x${plan.height}` : "none";
  useEffect(() => {
    if (!current) return;
    const cache = cacheRef.current!;
    const key = `${current.pageIndex}:${planKey}`;

    const cached = plan && !sharpUnavailableRef.current ? cache.get(key) : undefined;
    if (cached) {
      cache.pin(cached.url);
      // `queueMicrotask`: sin `setState` sincrono en el cuerpo del efecto.
      queueMicrotask(() =>
        setShown({ url: cached.url, page: current.pageIndex, sharp: true, pixelWidth: cached.width }),
      );
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    // La primera imagen de una pagina sale ya; repetir por zoom o ancho espera a que se asiente.
    const delay = shownPageRef.current === current.pageIndex ? RERENDER_DEBOUNCE_MS : 0;

    const run = async () => {
      if (plan && !sharpUnavailableRef.current) {
        try {
          const result = await renderPageRaster(current.page, plan, { signal: controller.signal });
          if (cancelled) return;
          const url = URL.createObjectURL(result.blob);
          cache.set(key, {
            url,
            bytes: result.blob.size,
            width: result.width,
            height: result.height,
          });
          cache.pin(url);
          setShown({ url, page: current.pageIndex, sharp: true, pixelWidth: result.width });
          return;
        } catch (caught) {
          if (cancelled || isRasterCancelled(caught)) return;
          if (caught instanceof RasterUnavailableError) sharpUnavailableRef.current = true;
          // Cualquier otro fallo: se intenta el respaldo para esta pagina.
        }
      }
      try {
        const url = await renderPageToDataUrl(current.page, {
          scale: plan ? Math.min(plan.scale, 2) : 1.5,
        });
        if (cancelled) return;
        setShown({ url, page: current.pageIndex, sharp: false, pixelWidth: 0 });
      } catch (caught) {
        if (!cancelled) errorRef.current?.(toPdfError(caught).code);
      }
    };

    // Sin retardo, el primer render arranca en el acto (ni un macrotask de espera).
    let timer: number | null = null;
    if (delay === 0) void run();
    else timer = window.setTimeout(() => void run(), delay);
    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== null) window.clearTimeout(timer);
    };
    // `plan` entra por `planKey`; `current` por identidad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, planKey]);

  const text =
    textInfo && textInfo.doc === doc && textInfo.pageIndex === pageIndex ? textInfo.hasText : null;

  return {
    src: shown?.url ?? null,
    srcPage: shown?.page ?? null,
    pixelWidth: shown?.pixelWidth ?? 0,
    sharp: shown?.sharp ?? false,
    loading: file !== null && !error && (shown === null || shown.page !== pageIndex),
    aspect: current?.view ? current.view.width / current.view.height : null,
    pageCount,
    doc,
    page: current?.page ?? null,
    hasText: text,
  };
}
