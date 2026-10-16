"use client";

import { useEffect, useState, type RefObject } from "react";
import { renderPreviewDataUrl } from "@/app/pdf-pro/ops/previewRender";
import { getDocumentBytes } from "@/lib/docLibrary/store";
import type { DocumentEntry } from "@/lib/docLibrary/types";

/** Por encima de este peso no se dibuja la miniatura (abrir un PDF enorme solo para un icono no compensa). */
export const THUMB_MAX_BYTES = 40 * 1024 * 1024;
export const THUMB_WIDTH = 160;

type ThumbDoc = Pick<DocumentEntry, "id" | "byteLength"> & { fingerprint: Pick<DocumentEntry["fingerprint"], "exact"> };

/**
 * Cache ligera en memoria (data URL JPEG de ~160 px, unos KB cada una): la clave lleva la huella del PDF, asi que
 * reemplazar el PDF de un documento la invalida sola. No se guarda en disco: se vuelve a dibujar, en segundo plano.
 */
const cache = new Map<string, string | null>();
const inflight = new Map<string, Promise<string | null>>();
/** Se dibuja de una en una: la lista no compite por CPU con el resto de la pagina. */
let queue: Promise<unknown> = Promise.resolve();

export function thumbKey(doc: ThumbDoc): string {
  return `${doc.id}:${doc.fingerprint.exact}:${doc.byteLength}`;
}

async function draw(doc: ThumbDoc): Promise<string | null> {
  if (doc.byteLength <= 0 || doc.byteLength > THUMB_MAX_BYTES) return null;
  try {
    const bytes = await getDocumentBytes(doc.id);
    if (!bytes) return null;
    return await renderPreviewDataUrl(bytes, THUMB_WIDTH);
  } catch {
    return null;
  }
}

function load(doc: ThumbDoc): Promise<string | null> {
  const key = thumbKey(doc);
  const pending = inflight.get(key);
  if (pending) return pending;
  const job = queue.then(() => draw(doc)).then((url) => {
    cache.set(key, url);
    inflight.delete(key);
    return url;
  });
  queue = job.catch(() => undefined);
  inflight.set(key, job);
  return job;
}

/** `true` cuando el elemento esta (o esta por estar) en pantalla. Sin `IntersectionObserver`, siempre. */
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (near || !element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

/**
 * Miniatura de la pagina 1 de la copia guardada. `null` mientras se dibuja o si no se pudo: la tarjeta muestra un icono
 * y nunca espera por ella.
 */
export function useDocumentThumbnail(doc: ThumbDoc | null, enabled: boolean): string | null {
  const [, setTick] = useState(0);
  const key = doc ? thumbKey(doc) : null;
  const known = key !== null && cache.has(key);
  useEffect(() => {
    if (!doc || !enabled || known) return;
    let cancelled = false;
    void load(doc).then(() => {
      if (!cancelled) setTick((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
    // `doc` se identifica por su clave: un objeto nuevo con la misma huella no vuelve a dibujar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, known]);
  return key !== null ? (cache.get(key) ?? null) : null;
}

/** Solo para pruebas. */
export function __clearThumbnailCacheForTests(): void {
  cache.clear();
  inflight.clear();
  queue = Promise.resolve();
}
