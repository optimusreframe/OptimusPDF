"use client";

import { useEffect, useState } from "react";
import { loadProDraft, type ProDraftSummary } from "@/app/pdf-pro/proDrafts";
import { renderPreviewDataUrl } from "@/app/pdf-pro/ops/previewRender";

/** Por encima de este peso no se dibuja la miniatura (leer el borrador entero solo para un icono no compensa). */
export const THUMB_MAX_DRAFT_BYTES = 25 * 1024 * 1024;
const THUMB_WIDTH = 120;

/** Miniaturas ya dibujadas (clave = huella + fecha de guardado: un borrador nuevo invalida la anterior). */
const cache = new Map<string, string | null>();

function keyOf(draft: ProDraftSummary): string {
  return `${draft.id}:${draft.savedAt}`;
}

/**
 * Miniatura de la primera pagina de cada borrador («Documentos recientes»). Se dibujan de una en una, solo las que
 * pesan poco y sin bloquear la lista: mientras llegan (o si no se pueden dibujar) la interfaz muestra un icono.
 */
export function useDraftThumbnails(drafts: readonly ProDraftSummary[], enabled = true): Record<string, string | null> {
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void (async () => {
      for (const draft of drafts) {
        if (cancelled) return;
        const key = keyOf(draft);
        if (cache.has(key)) {
          const cached = cache.get(key) ?? null;
          setThumbs((previous) => (previous[draft.id] === cached ? previous : { ...previous, [draft.id]: cached }));
          continue;
        }
        if (draft.fileSize > THUMB_MAX_DRAFT_BYTES) {
          cache.set(key, null);
          continue;
        }
        const loaded = await loadProDraft(draft.id);
        if (cancelled) return;
        const url = loaded.ok ? await renderPreviewDataUrl(loaded.draft.bytes, THUMB_WIDTH) : null;
        cache.set(key, url);
        if (cancelled) return;
        setThumbs((previous) => ({ ...previous, [draft.id]: url }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [drafts, enabled]);

  return thumbs;
}

/** Solo para pruebas. */
export function __clearDraftThumbnailCacheForTests(): void {
  cache.clear();
}
