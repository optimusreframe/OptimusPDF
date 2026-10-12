"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isRasterCancelled, planRaster, renderPageRaster } from "@/lib/pdf/pageRaster";
import { RenderQueue, type RenderJob } from "@/app/pdf-pro/viewer/renderQueue";
import {
  pageSignature,
  snapshotScopedSignature,
  viewerSignatureMemo,
  type SignatureMemo,
} from "@/app/pdf-pro/viewer/pageSignature";
import { viewerRasterCache, type ViewerRasterCache } from "@/app/pdf-pro/viewer/viewerRasterCache";
import type { ViewerDocument } from "@/app/pdf-pro/viewer/useViewerDocument";
import { VIEWER_RENDER_CONCURRENCY } from "@/app/pdf-pro/viewer/viewerTypes";

/*
 * Imagenes nitidas de las paginas del visor (Wave 7 · U3). Para cada pagina de la ventana de render:
 *  1. busca en la cache LRU (huella de pagina + tamano de bitmap) y, si esta, la muestra al instante;
 *  2. si no, encola un render (cola de concurrencia 2, prioridad a la pagina central, cancelable) con la
 *     misma tecnica que Firmar: bitmap a `ancho x zoom x devicePixelRatio` (tope 16 MP) como PNG;
 *  3. mientras llega el bitmap nuevo se sigue mostrando el anterior, estirado por CSS.
 * Las URL que el DOM muestra estan ancladas en la cache: nunca se expulsan ni se revocan bajo una <img> viva.
 */

/** Tamano de bitmap al que se dibuja (estable mientras el zoom no se asiente en otro paso). */
export type SettledSize = {
  /** Identifica el tamano (`paso@base x densidad`); cambia cuando hay que redibujar. */
  key: string;
  /** Ancho base (px CSS, zoom 1). */
  base: number;
  /** Zoom redondeado al paso de 0,25. */
  bucket: number;
  dpr: number;
};

export type ViewerImage = {
  url: string;
  /** Proporcion alto/ancho de la pagina cuando se dibujo. */
  aspect: number;
  snapshotId: string;
  /** `snapshot|tamano` con el que se resolvio. */
  renderKey: string;
};

export type ViewerImages = Readonly<Record<number, ViewerImage>>;

export type UseViewerImagesArgs = {
  document: ViewerDocument | null;
  /** Paginas con imagen (ya limitadas a `VIEWER_MAX_IMAGES`). */
  pages: readonly number[];
  /** Pagina central: manda la prioridad de los renders. */
  center: number;
  settled: SettledSize;
  cache?: ViewerRasterCache;
  memo?: SignatureMemo;
  render?: typeof renderPageRaster;
};

type Resolved = { url: string; aspect: number };

export function useViewerImages({
  document,
  pages,
  center,
  settled,
  cache = viewerRasterCache,
  memo = viewerSignatureMemo,
  render = renderPageRaster,
}: UseViewerImagesArgs): { images: ViewerImages; failed: Readonly<Record<number, string>>; renderKey: string } {
  const [images, setImages] = useState<ViewerImages>({});
  const [failed, setFailed] = useState<Readonly<Record<number, string>>>({});
  const imagesRef = useRef<ViewerImages>({});
  const pendingRef = useRef(new Set<string>());
  const failedRef = useRef(new Map<number, string>());
  const queueRef = useRef<RenderQueue | null>(null);
  const windowRef = useRef<ReadonlySet<number>>(new Set());
  const renderKeyRef = useRef("");
  const renderKey = document ? `${document.snapshotId}|${settled.key}` : "";

  const repin = useCallback(() => {
    cache.setPinned([...Object.values(imagesRef.current).map((image) => image.url), ...pendingRef.current]);
  }, [cache]);

  const commit = useCallback(
    (next: ViewerImages) => {
      imagesRef.current = next;
      repin();
      setImages(next);
    },
    [repin],
  );

  /* La cola vive lo que el visor. */
  useEffect(() => {
    const queue = new RenderQueue(VIEWER_RENDER_CONCURRENCY);
    const pending = pendingRef.current;
    queueRef.current = queue;
    return () => {
      queue.dispose();
      queueRef.current = null;
      imagesRef.current = {};
      pending.clear();
      cache.setPinned([]);
    };
  }, [cache]);

  /* Otro documento de pdf.js: los renders en curso eran de otro y los fallos ya no cuentan. */
  const pdfDoc = document?.doc ?? null;
  useEffect(() => {
    queueRef.current?.cancelAll();
    pendingRef.current.clear();
    failedRef.current.clear();
    queueMicrotask(() => setFailed({}));
  }, [pdfDoc]);

  const pagesKey = pages.join(",");
  useEffect(() => {
    const queue = queueRef.current;
    if (!document || !queue) return;
    const wanted = new Set(pagesKey === "" ? [] : pagesKey.split(",").map(Number));
    windowRef.current = wanted;
    renderKeyRef.current = renderKey;
    const { sizes } = document;
    const snapshotId = document.snapshotId;

    let next = imagesRef.current;
    let changed = false;
    const edit = () => {
      if (!changed) {
        next = { ...next };
        changed = true;
      }
      return next as Record<number, ViewerImage>;
    };

    for (const key of Object.keys(next)) {
      if (!wanted.has(Number(key))) delete edit()[Number(key)];
    }

    const jobs: RenderJob<Resolved>[] = [];
    for (const i of [...wanted].sort((a, b) => a - b)) {
      const shown = next[i];
      if (shown && shown.renderKey === renderKey) continue;
      if (failedRef.current.get(i) === renderKey) continue;
      const w = sizes.widths[i];
      const h = sizes.heights[i];
      const aspect = w > 0 && h > 0 ? h / w : 0;
      // Un bitmap de otro snapshot con otra proporcion (pagina girada) estaria deformado: se retira.
      if (shown && shown.snapshotId !== snapshotId && aspect > 0 && Math.abs(shown.aspect / aspect - 1) > 0.005) {
        delete edit()[i];
      }
      // Via rapida: huella ya conocida (deshacer/rehacer) y bitmap en la cache.
      const sig = memo.get(snapshotId, i);
      if (sig && aspect > 0) {
        const plan = planRaster({ width: w, height: h }, { cssWidth: settled.base * settled.bucket, zoom: 1, pixelRatio: settled.dpr });
        const hit = cache.get(`${sig}|${plan.width}x${plan.height}`);
        if (hit) {
          edit()[i] = { url: hit.url, aspect, snapshotId, renderKey };
          continue;
        }
      }
      jobs.push({
        key: `${renderKey}|${i}`,
        priority: Math.abs(i - center),
        run: async (signal) => {
          const handle = await document.doc.getPage(i + 1);
          try {
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
            const view = handle.getViewport({ scale: 1 });
            const plan = planRaster(view, { cssWidth: settled.base * settled.bucket, zoom: 1, pixelRatio: settled.dpr });
            let signature = memo.get(snapshotId, i);
            if (!signature) {
              signature = await pageSignature(handle, snapshotScopedSignature(snapshotId, i));
              memo.set(snapshotId, i, signature);
            }
            if (signal.aborted) throw new DOMException("aborted", "AbortError");
            const key = `${signature}|${plan.width}x${plan.height}`;
            const pageAspect = view.height / view.width;
            const hit = cache.get(key);
            if (hit) {
              pendingRef.current.add(hit.url);
              repin();
              return { url: hit.url, aspect: pageAspect };
            }
            const result = await render(handle, plan, { signal });
            const url = URL.createObjectURL(result.blob);
            cache.set(key, { url, bytes: result.blob.size, width: result.width, height: result.height });
            pendingRef.current.add(url);
            repin();
            return { url, aspect: pageAspect };
          } finally {
            try {
              handle.cleanup();
            } catch {
              // Nada que liberar.
            }
          }
        },
        onDone: (resolved) => {
          pendingRef.current.delete(resolved.url);
          if (!windowRef.current.has(i) || renderKeyRef.current !== renderKey) {
            repin();
            return;
          }
          commit({ ...imagesRef.current, [i]: { url: resolved.url, aspect: resolved.aspect, snapshotId, renderKey } });
        },
        onError: (error) => {
          if (isRasterCancelled(error) || (error instanceof DOMException && error.name === "AbortError")) return;
          failedRef.current.set(i, renderKey);
          setFailed((previous) => ({ ...previous, [i]: renderKey }));
        },
      });
    }
    if (changed) commit(next);
    queue.retarget(jobs);
  }, [document, pagesKey, center, settled, renderKey, cache, memo, render, commit, repin]);

  return { images, failed, renderKey };
}
