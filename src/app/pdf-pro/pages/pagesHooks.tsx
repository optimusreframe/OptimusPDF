"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { usePageThumbs } from "@/app/edit-pdf/usePageThumbs";
import { closePdfDocument, openPdfDocument } from "@/lib/pdf/core";
import { getPagesStore, type PagesState, type PagesStore } from "@/app/pdf-pro/pages/pagesStore";
import type { ProWorkingDoc } from "@/app/pdf-pro/proWorkingDoc";

/** Ancho (px) de las miniaturas del organizador: nitidas en tarjetas de ~190 px con pantallas densas. */
export const PAGES_THUMB_WIDTH = 240;
/** Miniaturas que se conservan por documento (la cuadricula ve ~40; el resto se descarta lejos de lo visible). */
export const PAGES_THUMB_CACHE = 160;

/** Estado del organizador del documento de trabajo (sobrevive al cambio de pestana). */
export function usePagesStore(doc: ProWorkingDoc): { store: PagesStore; state: PagesState } {
  const store = getPagesStore(doc);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return { store, state };
}

export type ContainerSize = { width: number; height: number };

/**
 * Tamano de un contenedor, medido y observado. Sin medida (jsdom, primer pintado) devuelve
 * `fallback`: la cuadricula siempre pinta algo y los tests no dependen del layout.
 */
export function useContainerSize(ref: RefObject<HTMLElement | null>, fallback: ContainerSize): ContainerSize {
  const [size, setSize] = useState<ContainerSize>(fallback);
  const fallbackRef = useRef(fallback);
  useLayoutEffect(() => {
    fallbackRef.current = fallback;
  });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const width = element.clientWidth || fallbackRef.current.width;
      const height = element.clientHeight || fallbackRef.current.height;
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/** Abre unos bytes con pdf.js y los suelta al cambiar o desmontar. `null` mientras no hay motor o falla. */
export function usePdfProxy(bytes: Uint8Array | null): PDFDocumentProxy | null {
  const [state, setState] = useState<{ bytes: Uint8Array; proxy: PDFDocumentProxy } | null>(null);
  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    let opened: PDFDocumentProxy | null = null;
    void (async () => {
      try {
        const proxy = await openPdfDocument(bytes);
        if (cancelled) {
          void closePdfDocument(proxy);
          return;
        }
        opened = proxy;
        setState({ bytes, proxy });
      } catch {
        // Sin pdf.js (o un PDF que solo pdf-lib lee): las tarjetas se quedan con el numero de pagina.
      }
    })();
    return () => {
      cancelled = true;
      if (opened) void closePdfDocument(opened);
      setState((previous) => (previous && previous.proxy === opened ? null : previous));
    };
  }, [bytes]);
  return state && state.bytes === bytes ? state.proxy : null;
}

export type ThumbMap = Readonly<Record<string, Readonly<Record<number, string | undefined>>>>;

/**
 * Anfitrion de miniaturas de UN documento (el actual o uno sumado): abre pdf.js, rasteriza por
 * visibilidad con `usePageThumbs` y publica el resultado. No pinta nada.
 */
export function ThumbHost({
  sourceKey,
  bytes,
  shared,
  visible,
  active,
  onThumbs,
}: {
  sourceKey: string;
  bytes: Uint8Array;
  /**
   * Documento de pdf.js ya abierto por otro (el visor): se reutiliza en vez de abrir una copia mas del
   * archivo en memoria. `null` = el visor aun lo esta abriendo (se espera); `undefined` = no hay visor.
   */
  shared?: PDFDocumentProxy | null;
  visible: ReadonlySet<number> | null;
  active: number;
  onThumbs: (key: string, thumbs: Readonly<Record<number, string | undefined>>) => void;
}) {
  const own = usePdfProxy(shared === undefined ? bytes : null);
  const proxy = shared === undefined ? own : shared;
  const { thumbs, setVisible } = usePageThumbs(proxy, active, true, {
    width: PAGES_THUMB_WIDTH,
    max: PAGES_THUMB_CACHE,
  });
  useEffect(() => {
    setVisible(visible);
  }, [visible, setVisible]);
  useEffect(() => {
    onThumbs(sourceKey, thumbs);
  }, [sourceKey, thumbs, onThumbs]);
  useEffect(() => () => onThumbs(sourceKey, {}), [sourceKey, onThumbs]);
  return null;
}

/**
 * Cuantos cambios de paginas sin aplicar hay en este documento de trabajo (0 = ninguno). La suite
 * puede mostrarlo en la pestana «Paginas» aunque el organizador no este montado.
 */
export function usePagesPendingCount(doc: ProWorkingDoc): number {
  const store = getPagesStore(doc);
  return useSyncExternalStore(
    store.subscribe,
    () => store.getState().changeCount,
    () => 0,
  );
}
