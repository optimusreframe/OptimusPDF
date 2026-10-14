"use client";

import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { Spinner } from "@/components/ui/Spinner";
import {
  geometryFromPdfJsPage,
  lineStripsToUserBoxes,
  makeMetrics,
  sampleCanvasBackground,
  userBoxToPx,
  type PageMetrics,
} from "@/app/edit-pdf/editCanvasMath";
import type { BackgroundSample } from "@/lib/pdf/editBackground";
import type { UserBox } from "@/lib/pdf/editTypes";
import { createNonOpaqueContext } from "@/lib/pdf/pageRaster";

/*
 * Superficie de la pagina del editor inline (W5-U4a).
 *
 * Renderiza la pagina con pdf.js en un <canvas> con la densidad de pixeles de
 * la pantalla (nada de JPEG de 900 px) y la vuelve a renderizar NITIDA al
 * cambiar el tamano (zoom o ancho disponible). El render nuevo va a un canvas
 * fuera de pantalla y se copia al visible de golpe, asi no hay parpadeo; entre
 * tanto el canvas viejo se estira por CSS. Un `PDFDocumentProxy` por sesion
 * (lo abre `useEditDocument`); aqui solo se pide la pagina.
 *
 * Geometria: `/Rotate` y el CropBox con origen no cero salen de `view`/`rotate`
 * de la pagina de pdf.js y de `getPageGeometry`-compatible (`editCanvasMath`).
 * Los hijos (capa de bloques) viven DENTRO de la hoja, con las mismas
 * coordenadas en px CSS.
 */

/** Ancho maximo (px CSS) de la hoja a zoom 1. */
export const MAX_FIT_WIDTH_PX = 860;
/** Area maxima del canvas (px de dispositivo) para no agotar la memoria. */
const MAX_CANVAS_PIXELS = 16_000_000;
const MAX_PIXEL_RATIO = 3;
const RENDER_DEBOUNCE_MS = 120;

export type SurfaceHandle = {
  /** Color de fondo alrededor de una caja de usuario, leido del canvas ya pintado. */
  /** `quad`: esquinas (espacio de usuario) del cuadrilatero girado a cubrir; el anillo se toma pegado a el. */
  sampleBackground: (
    box: UserBox,
    quad?: ReadonlyArray<{ x: number; y: number }>,
    /** Cajas de otros bloques de texto: su tinta no cuenta como fondo. */
    ignore?: readonly UserBox[],
    /** Caja del texto original, DENTRO de `box`: se revisan tambien las filas entre ambas por si llevan un borde. */
    inner?: UserBox,
  ) => SurfaceSample | null;
};

/** Muestra de fondo mas las franjas de borde fino (espacio de usuario) que la cobertura no debe pisar. */
export type SurfaceSample = BackgroundSample & { clip?: UserBox[] };

/** Holgura (pt) que se deja entre la cobertura y un borde fino. */
const LINE_CLEARANCE_PT = 0.5;

export type EditSurfaceProps = {
  doc: PDFDocumentProxy | null;
  pageIndex: number;
  zoom: number;
  /** Hoja (anfitrion de los hijos): la usa la barra flotante como referencia. */
  hostRef: RefObject<HTMLDivElement | null>;
  /** Tarjeta con scroll horizontal que recorta la hoja con zoom. */
  clipRef: RefObject<HTMLDivElement | null>;
  handleRef?: Ref<SurfaceHandle>;
  /** `pageIndex` es la pagina a la que pertenecen las metricas (-1 si aun no hay). */
  onMetrics: (metrics: PageMetrics | null, pageIndex: number) => void;
  /**
   * Se llama cada vez que el canvas visible acaba de repintarse (primer render, zoom, cambio
   * de ancho): a partir de ahi `sampleBackground` lee la pagina NUEVA. Quien muestreo antes
   * (con el canvas viejo o sin pintar) debe volver a muestrear.
   */
  onRendered?: (info: { pageIndex: number }) => void;
  loadingLabel: string;
  /** Texto cuando la pagina no se pudo leer o dibujar (sin spinner perpetuo). */
  failedLabel?: string;
  stageLabel: string;
  /** Props del anfitrion de la hoja (gestos de puntero, tabIndex...). */
  hostProps?: ComponentPropsWithoutRef<"div"> & {
    [attribute: `data-${string}`]: string | undefined;
  };
  children?: ReactNode;
};

type PageInfo = {
  doc: PDFDocumentProxy;
  pageIndex: number;
  page: PDFPageProxy;
  geometry: ReturnType<typeof geometryFromPdfJsPage>;
};

function isRenderCancelled(error: unknown): boolean {
  return error instanceof Error && error.name === "RenderingCancelledException";
}

export function EditSurface({
  doc,
  pageIndex,
  zoom,
  hostRef,
  clipRef,
  handleRef,
  onMetrics,
  onRendered,
  loadingLabel,
  failedLabel,
  stageLabel,
  hostProps,
  children,
}: EditSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [info, setInfo] = useState<PageInfo | null>(null);
  const [available, setAvailable] = useState(0);
  const [rendered, setRendered] = useState<{ pageIndex: number; width: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const metricsCallback = useRef(onMetrics);
  useEffect(() => {
    metricsCallback.current = onMetrics;
  });

  /* Ancho disponible: lo da el contenedor con scroll. */
  useLayoutEffect(() => {
    const clip = clipRef.current;
    if (!clip) return;
    const measure = () => setAvailable(clip.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(clip);
    return () => observer.disconnect();
  }, [clipRef]);

  /* La pagina de pdf.js y su geometria. */
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
        setFailed(false);
        setInfo({ doc, pageIndex, page, geometry: geometryFromPdfJsPage(page) });
      } catch {
        if (!cancelled) setFailed(true);
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
  const cssWidth = Math.max(
    1,
    Math.round(Math.min(available || MAX_FIT_WIDTH_PX, MAX_FIT_WIDTH_PX) * zoom),
  );
  const metrics = useMemo(
    () => (current ? makeMetrics(current.geometry, cssWidth) : null),
    [current, cssWidth],
  );

  useEffect(() => {
    metricsCallback.current(metrics, metrics ? pageIndex : -1);
  }, [metrics, pageIndex]);
  useEffect(() => () => metricsCallback.current(null, -1), []);

  /* Render nitido: fuera de pantalla y luego copia; con espera para el zoom a golpes. */
  useEffect(() => {
    if (!current || !metrics) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    const first = rendered === null || rendered.pageIndex !== current.pageIndex;

    const run = async () => {
      const ratio = Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
      let pixelScale = (cssWidth * ratio) / current.geometry.viewWidth;
      const area = current.geometry.viewWidth * current.geometry.viewHeight * pixelScale ** 2;
      if (area > MAX_CANVAS_PIXELS) pixelScale *= Math.sqrt(MAX_CANVAS_PIXELS / area);
      const viewport = current.page.getViewport({ scale: pixelScale });
      const off = document.createElement("canvas");
      off.width = Math.max(1, Math.floor(viewport.width));
      off.height = Math.max(1, Math.floor(viewport.height));
      // El contexto se crea AQUI, antes de `render`, y NO opaco: si no, pdf.js crea el suyo con `alpha: false` y
      // Chromium en Linux y Windows dibuja el texto con antialiasing LCD (franjas de color en el lienzo, distinto al
      // de Firmar). `willReadFrequently: true` es lo que ya usaba pdf.js. Ver `createNonOpaqueContext`.
      createNonOpaqueContext(off, { willReadFrequently: true });
      try {
        const task = current.page.render({ canvas: off, viewport, intent: "display" });
        renderTaskRef.current = task;
        await task.promise;
        if (cancelled) return;
        canvas.width = off.width;
        canvas.height = off.height;
        createNonOpaqueContext(canvas, { willReadFrequently: true })?.drawImage(off, 0, 0);
        setRendered({ pageIndex: current.pageIndex, width: cssWidth });
        onRendered?.({ pageIndex: current.pageIndex });
        setFailed(false);
      } catch (error) {
        if (!cancelled && !isRenderCancelled(error)) setFailed(true);
      }
    };

    const timer = window.setTimeout(() => void run(), first ? 0 : RENDER_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
    // `rendered` solo decide el retardo; no debe relanzar el render al terminar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, metrics, cssWidth]);

  const sampleBackground = useCallback(
    (
      box: UserBox,
      quad?: ReadonlyArray<{ x: number; y: number }>,
      ignore?: readonly UserBox[],
      inner?: UserBox,
    ): SurfaceSample | null => {
      const canvas = canvasRef.current;
      if (!canvas || !metrics || canvas.width === 0) return null;
      const rect = userBoxToPx(metrics, box);
      // Canvas px por px CSS: el canvas cubre la hoja entera, aunque aun sea el del zoom anterior.
      const k = canvas.width / metrics.cssWidth;
      // Canvas px por punto PDF: independiente del zoom y del tamano al que se pinto.
      const pxPerPt = canvas.width / Math.max(1, metrics.geometry.viewWidth);
      const toCanvas = (b: UserBox) => {
        const r = userBoxToPx(metrics, b);
        return { x: r.left * k, y: r.top * k, width: r.width * k, height: r.height * k };
      };
      const sample = sampleCanvasBackground(
        createNonOpaqueContext(canvas, { willReadFrequently: true }),
        { width: canvas.width, height: canvas.height },
        { x: rect.left * k, y: rect.top * k, width: rect.width * k, height: rect.height * k },
        quad?.map((point) => {
          const p = userBoxToPx(metrics, { x: point.x, y: point.y, width: 0, height: 0 });
          return { x: p.left * k, y: p.top * k };
        }),
        ignore?.map(toCanvas),
        { pxPerPt, inner: inner ? toCanvas(inner) : undefined },
      );
      if (!sample) return null;
      if (!sample.lines || sample.lines.length === 0) return sample;
      // Franjas de borde fino -> espacio de usuario, con 0,5 pt de holgura hacia la cobertura.
      const clip = lineStripsToUserBoxes(metrics, sample.lines, k, pxPerPt, LINE_CLEARANCE_PT);
      return { ...sample, clip };
    },
    [metrics],
  );
  useImperativeHandle(handleRef, () => ({ sampleBackground }), [sampleBackground]);

  const ready = rendered !== null && rendered.pageIndex === pageIndex;
  const { className: hostClass, style: hostStyle, ...restHostProps } = hostProps ?? {};

  return (
    <div
      ref={clipRef}
      data-edit-clip=""
      className="w-full overflow-x-auto overflow-y-visible rounded-ios"
    >
      <div
        {...restHostProps}
        ref={hostRef}
        data-page-index={pageIndex}
        data-render-state={failed ? "failed" : ready ? "ready" : "rendering"}
        role="group"
        aria-label={stageLabel}
        className={`relative mx-auto bg-white shadow-elevation-2 select-none ${hostClass ?? ""}`}
        style={{
          width: metrics ? metrics.cssWidth : "100%",
          height: metrics ? metrics.cssHeight : undefined,
          minHeight: metrics ? undefined : 320,
          ...hostStyle,
        }}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          className="absolute inset-0 block size-full"
          data-edit-canvas=""
        />
        {!ready && !failed ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <Spinner className="size-5 text-neutral-500" label={loadingLabel} />
          </div>
        ) : null}
        {failed && failedLabel ? (
          <p
            role="status"
            data-render-failed=""
            className="pointer-events-none absolute inset-x-4 top-1/2 -translate-y-1/2 text-center text-subheadline text-neutral-700"
          >
            {failedLabel}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}
