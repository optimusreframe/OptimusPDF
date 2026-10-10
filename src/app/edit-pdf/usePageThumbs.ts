"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { renderPageToDataUrl } from "@/lib/pdf/core";

/*
 * Miniaturas PEREZOSAS de las paginas del editor (W5-U4b), pensadas para
 * documentos de cientos de paginas:
 *
 *  - UNA cola con concurrencia 1: se rasteriza una pagina cada vez, y entre una
 *    y otra se vuelve a decidir que hace falta (cede el turno al instante si la
 *    tira ya no ve esa pagina o la pagina activa cambio).
 *  - Solo las que la tira tiene A LA VISTA (`setVisible`, que alimenta un
 *    IntersectionObserver), las mas cercanas a la activa primero. Sin esa
 *    informacion (aun no hay observador, o no existe) se hacen las de la activa y
 *    sus vecinas (`FALLBACK_RADIUS`).
 *  - Reutiliza el `PDFDocumentProxy` que ya tiene abierto `useEditDocument`: no
 *    se vuelve a leer ni a analizar el archivo (`useSequenceMeta` de Firmar abre y
 *    cierra el documento en cada pasada, razonable con 3 documentos pero un
 *    coste evitable con un solo PDF de 300 paginas).
 *  - Memoria: la cache guarda como mucho `MAX_THUMBS` miniaturas (data URL JPEG de
 *    unos pocos KB; no hay nada que revocar) y suelta primero las mas lejanas a
 *    la pagina activa que no se ven.
 */

export const THUMB_WIDTH = 96;
export const MAX_THUMBS = 60;
/** Paginas a cada lado de la activa que se hacen si no se sabe cuales se ven. */
export const FALLBACK_RADIUS = 5;

export type PageThumbs = {
  /** Miniaturas ya hechas (data URL), por indice de pagina (0-based). */
  thumbs: Readonly<Record<number, string | undefined>>;
  /** Paginas que la tira tiene a la vista; `null` = aun no se sabe. */
  setVisible: (pages: ReadonlySet<number> | null) => void;
};

type Cache = { doc: PDFDocumentProxy; thumbs: Record<number, string> };

/** Pagina que toca hacer ahora: la mas cercana a la activa entre las que se ven y faltan. */
export function nextThumbPage(args: {
  visible: ReadonlySet<number> | null;
  active: number;
  pageCount: number;
  have: (page: number) => boolean;
  failed: (page: number) => boolean;
}): number | undefined {
  const { visible, active, pageCount, have, failed } = args;
  const candidates: number[] = [];
  if (visible) {
    for (const page of visible) candidates.push(page);
  } else {
    for (let page = active - FALLBACK_RADIUS; page <= active + FALLBACK_RADIUS; page += 1) {
      candidates.push(page);
    }
  }
  let best: number | undefined;
  for (const page of candidates) {
    if (page < 0 || page >= pageCount || have(page) || failed(page)) continue;
    if (best === undefined || Math.abs(page - active) < Math.abs(best - active)) best = page;
  }
  return best;
}

/** Quita las miniaturas mas lejanas a la activa (y no visibles) hasta quedar en `limit`. */
export function evictThumbs(
  thumbs: Record<number, string>,
  active: number,
  visible: ReadonlySet<number> | null,
  keep: number,
  limit: number = MAX_THUMBS,
): Record<number, string> {
  const pages = Object.keys(thumbs).map(Number);
  let excess = pages.length - limit;
  if (excess <= 0) return thumbs;
  const next = { ...thumbs };
  const order = pages.sort((a, b) => Math.abs(b - active) - Math.abs(a - active));
  for (const page of order) {
    if (excess <= 0) break;
    if (page === keep || visible?.has(page)) continue;
    delete next[page];
    excess -= 1;
  }
  return next;
}

export function usePageThumbs(
  doc: PDFDocumentProxy | null,
  active: number,
  enabled = true,
): PageThumbs {
  const [cache, setCache] = useState<Cache | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const activeRef = useRef(active);
  const visibleRef = useRef<ReadonlySet<number> | null>(null);
  const cacheRef = useRef<Record<number, string>>({});
  const failedRef = useRef(new Set<number>());
  const generationRef = useRef(0);
  const runningRef = useRef(false);
  const pumpRef = useRef<() => void>(() => undefined);

  const pump = useCallback(() => {
    if (runningRef.current) return;
    runningRef.current = true;
    const generation = generationRef.current;
    void (async () => {
      try {
        for (;;) {
          const current = docRef.current;
          if (!current || generation !== generationRef.current) return;
          const page = nextThumbPage({
            visible: visibleRef.current,
            active: activeRef.current,
            pageCount: current.numPages,
            have: (candidate) => cacheRef.current[candidate] !== undefined,
            failed: (candidate) => failedRef.current.has(candidate),
          });
          if (page === undefined) return;
          try {
            const handle = await current.getPage(page + 1);
            const url = await renderPageToDataUrl(handle, { maxWidth: THUMB_WIDTH });
            handle.cleanup();
            if (generation !== generationRef.current) return;
            cacheRef.current = evictThumbs(
              { ...cacheRef.current, [page]: url },
              activeRef.current,
              visibleRef.current,
              page,
            );
            setCache({ doc: current, thumbs: cacheRef.current });
          } catch {
            // Una pagina que no se puede rasterizar no se reintenta en bucle.
            if (generation === generationRef.current) failedRef.current.add(page);
          }
        }
      } finally {
        runningRef.current = false;
        // Si el documento cambio mientras corria, la cola nueva no pudo arrancar: se arranca ahora.
        if (generation !== generationRef.current) pumpRef.current();
      }
    })();
  }, []);
  useEffect(() => {
    pumpRef.current = pump;
  }, [pump]);

  /* Otro documento (u apagado): cola y cache nuevas. */
  useEffect(() => {
    generationRef.current += 1;
    docRef.current = enabled ? doc : null;
    cacheRef.current = {};
    failedRef.current = new Set();
    pump();
  }, [doc, enabled, pump]);

  useEffect(() => {
    activeRef.current = active;
    pump();
  }, [active, pump]);

  const setVisible = useCallback(
    (pages: ReadonlySet<number> | null) => {
      const before = visibleRef.current;
      if (
        before === pages ||
        (before && pages && before.size === pages.size && [...pages].every((page) => before.has(page)))
      ) {
        return;
      }
      visibleRef.current = pages;
      pump();
    },
    [pump],
  );

  const own = cache && cache.doc === doc && enabled ? cache.thumbs : null;
  return { thumbs: own ?? EMPTY, setVisible };
}

const EMPTY: Readonly<Record<number, string | undefined>> = {};
