"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { closePdfDocument, openPdfDocument, toPdfError, type PdfErrorCode } from "@/lib/pdf/core";
import { geometryFromPdfJsPage } from "@/app/edit-pdf/editCanvasMath";
import type { PageGeometry } from "@/lib/pdf/core";
import type { ViewerSnapshot } from "@/app/pdf-pro/viewer/viewerTypes";

/*
 * Documento de pdf.js del visor (Wave 7 · U3): UN `PDFDocumentProxy` por snapshot. Al cambiar el snapshot
 * (deshacer, rehacer, aplicar una operacion) se abre el nuevo MIENTRAS el viejo sigue a la vista y solo
 * entonces se intercambian y se cierra el anterior: no hay parpadeo ni pagina en blanco. Los tamanos de las
 * paginas (con `/Rotate` y CropBox ya aplicados por pdf.js) se miden en lotes sin bloquear: la primera pagina
 * da el visor util al instante y el resto afina la barra de desplazamiento.
 */

/** Paginas que se miden a la vez. */
export const SIZE_BATCH = 24;

export type ViewerPageSizes = {
  /** Ancho de vista de cada pagina en puntos (0 = aun sin medir). */
  widths: Float32Array;
  heights: Float32Array;
  /** `view` de pdf.js (x0, y0, x1, y1) de cada pagina, 4 valores por pagina. */
  views: Float32Array;
  /** `/Rotate` de cada pagina. */
  rotations: Int16Array;
  /** Cuantas paginas llevan medidas. */
  measured: number;
};

export type ViewerDocument = {
  /** `ViewerSnapshot.id` del que sale. */
  snapshotId: string;
  doc: PDFDocumentProxy;
  pageCount: number;
  /** Cambia (objeto nuevo) cada vez que llega un lote de medidas. */
  sizes: ViewerPageSizes;
};

export type ViewerDocumentState = {
  status: "idle" | "loading" | "ready" | "error";
  /** Lo que se esta mostrando (el documento anterior mientras se abre el nuevo). */
  document: ViewerDocument | null;
  error: PdfErrorCode | null;
  /** Hay un snapshot nuevo abriendose. */
  opening: boolean;
  retry: () => void;
};

export function emptySizes(count: number): ViewerPageSizes {
  return {
    widths: new Float32Array(count),
    heights: new Float32Array(count),
    views: new Float32Array(count * 4),
    rotations: new Int16Array(count),
    measured: 0,
  };
}

/** Proporcion alto/ancho por pagina para `computeLayout` (0 = desconocida). */
export function aspectsOf(sizes: ViewerPageSizes): Float32Array {
  const out = new Float32Array(sizes.widths.length);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = sizes.widths[i] > 0 && sizes.heights[i] > 0 ? sizes.heights[i] / sizes.widths[i] : 0;
  }
  return out;
}

/** `PageGeometry` de la pagina i (o `null` si aun no se midio). */
export function geometryOf(sizes: ViewerPageSizes, index: number): PageGeometry | null {
  if (!(sizes.widths[index] > 0)) return null;
  const o = index * 4;
  return geometryFromPdfJsPage({
    view: [sizes.views[o], sizes.views[o + 1], sizes.views[o + 2], sizes.views[o + 3]],
    rotate: sizes.rotations[index],
  });
}

type MeasuredPage = {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  view?: readonly number[];
  rotate?: number;
  cleanup?: () => void;
};

function writeMeasure(sizes: ViewerPageSizes, index: number, page: MeasuredPage): boolean {
  const viewport = page.getViewport({ scale: 1 });
  if (!(viewport.width > 0) || !(viewport.height > 0)) return false;
  if (!(sizes.widths[index] > 0)) sizes.measured += 1;
  sizes.widths[index] = viewport.width;
  sizes.heights[index] = viewport.height;
  const view = page.view ?? [0, 0, viewport.width, viewport.height];
  const o = index * 4;
  sizes.views[o] = view[0] ?? 0;
  sizes.views[o + 1] = view[1] ?? 0;
  sizes.views[o + 2] = view[2] ?? viewport.width;
  sizes.views[o + 3] = view[3] ?? viewport.height;
  sizes.rotations[index] = page.rotate ?? 0;
  return true;
}

function cloneSizes(sizes: ViewerPageSizes): ViewerPageSizes {
  return {
    widths: sizes.widths.slice(),
    heights: sizes.heights.slice(),
    views: sizes.views.slice(),
    rotations: sizes.rotations.slice(),
    measured: sizes.measured,
  };
}

/** Siguiente turno del navegador: cede el hilo entre lotes de medidas. */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Paginas a cada lado de la prioritaria que se miden antes que el resto (lo que el usuario esta viendo). */
export const PRIORITY_RADIUS = 12;

/**
 * `getPriorityPage` (opcional) da la pagina que se esta viendo al abrir el documento: sus vecinas se miden antes
 * que el resto, asi tras deshacer/girar lo visible ya tiene sus proporciones reales y no una estimacion.
 */
export function useViewerDocument(
  snapshot: ViewerSnapshot | null,
  getPriorityPage?: () => number,
): ViewerDocumentState {
  const [state, setState] = useState<{
    document: ViewerDocument | null;
    error: PdfErrorCode | null;
    opening: boolean;
  }>({ document: null, error: null, opening: false });
  const currentRef = useRef<ViewerDocument | null>(null);
  const [attempt, setAttempt] = useState(0);
  const snapshotId = snapshot?.id ?? null;
  const bytes = snapshot?.bytes ?? null;
  /* `bytes` es de un snapshot inmutable: se lee por referencia estable, no por contenido. */
  const bytesRef = useRef(bytes);
  const priorityRef = useRef(getPriorityPage);
  useEffect(() => {
    bytesRef.current = bytes;
    priorityRef.current = getPriorityPage;
  });

  useEffect(() => {
    let cancelled = false;
    const source = bytesRef.current;
    if (snapshotId === null || !source) {
      const previous = currentRef.current;
      currentRef.current = null;
      if (previous) void closePdfDocument(previous.doc);
      queueMicrotask(() => {
        if (!cancelled) setState({ document: null, error: null, opening: false });
      });
      return () => {
        cancelled = true;
      };
    }
    if (currentRef.current?.snapshotId === snapshotId && attempt === 0) return;

    queueMicrotask(() => {
      if (!cancelled) setState((previous) => ({ ...previous, error: null, opening: true }));
    });

    void (async () => {
      let opened: PDFDocumentProxy | null = null;
      try {
        opened = await openPdfDocument(source);
        if (cancelled) {
          void closePdfDocument(opened);
          return;
        }
        const count = opened.numPages;
        const previous = currentRef.current;
        // Estimacion inicial: las proporciones del documento anterior si tiene las mismas paginas.
        const sizes =
          previous && previous.pageCount === count ? cloneSizes(previous.sizes) : emptySizes(count);
        if (count > 0) {
          const first = await opened.getPage(1);
          if (cancelled) {
            void closePdfDocument(opened);
            return;
          }
          writeMeasure(sizes, 0, first as unknown as MeasuredPage);
          first.cleanup?.();
        }
        const next: ViewerDocument = { snapshotId, doc: opened, pageCount: count, sizes: cloneSizes(sizes) };
        currentRef.current = next;
        if (previous) void closePdfDocument(previous.doc);
        setState({ document: next, error: null, opening: false });

        // Primero las paginas que se estan viendo; luego el resto, en lotes.
        const priority = Math.min(count - 1, Math.max(0, priorityRef.current?.() ?? 0));
        const order: number[] = [];
        const near = (i: number) => Math.abs(i - priority) <= PRIORITY_RADIUS;
        for (let i = Math.max(1, priority - PRIORITY_RADIUS); i <= Math.min(count - 1, priority + PRIORITY_RADIUS); i += 1) {
          order.push(i);
        }
        for (let i = 1; i < count; i += 1) if (!near(i)) order.push(i);
        for (let start = 0; start < order.length; start += SIZE_BATCH) {
          const slice = order.slice(start, start + SIZE_BATCH);
          const pages = await Promise.all(slice.map((index) => opened!.getPage(index + 1).catch(() => null)));
          if (cancelled) return;
          pages.forEach((page, k) => {
            if (!page) return;
            writeMeasure(sizes, slice[k], page as unknown as MeasuredPage);
            page.cleanup?.();
          });
          const updated: ViewerDocument = { ...next, sizes: cloneSizes(sizes) };
          currentRef.current = updated;
          setState((previousState) =>
            previousState.document?.doc === opened ? { ...previousState, document: updated } : previousState,
          );
          if (start + SIZE_BATCH < order.length) await yieldToBrowser();
        }
      } catch (caught) {
        if (opened && currentRef.current?.doc !== opened) void closePdfDocument(opened);
        if (!cancelled) setState((previous) => ({ ...previous, error: toPdfError(caught).code, opening: false }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [snapshotId, attempt]);

  /* Cierre al desmontar. */
  useEffect(
    () => () => {
      const current = currentRef.current;
      currentRef.current = null;
      if (current) void closePdfDocument(current.doc);
    },
    [],
  );

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const status: ViewerDocumentState["status"] = state.error
    ? "error"
    : state.document
      ? "ready"
      : snapshotId === null
        ? "idle"
        : "loading";
  return { status, document: state.document, error: state.error, opening: state.opening, retry };
}
