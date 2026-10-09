"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  closePdfDocument,
  openPdfDocument,
  renderPageToDataUrl,
} from "@/lib/pdf/core";
import type { DocId } from "@/app/sign-pdf/docSet";

/*
 * Recuento de paginas y miniaturas de TODOS los documentos de la vista
 * continua, sin abrir pdf.js de todos a la vez:
 *
 *  - UNA sola cola con concurrencia 1: se abre un documento, se lee/rasteriza y
 *    se cierra antes de pasar al siguiente (la memoria no crece con el numero
 *    de documentos).
 *  - Las miniaturas son PEREZOSAS: solo se hacen las que la tira tiene a la
 *    vista (`setVisible`, que alimenta un IntersectionObserver), de las del
 *    documento activo a las de los demas, y se interrumpen en cuanto dejan de
 *    verse o aparece algo de mas prioridad. Sin IntersectionObserver
 *    (`lazy: false`) se hacen las del activo y sus dos vecinos.
 *  - Memoria: la cache guarda como mucho `MAX_THUMBS` miniaturas (data URL,
 *    nada que revocar); al pasarse se sueltan las mas antiguas que ya no se ven.
 *  - El recuento de paginas de todos los documentos se hace aparte, de los
 *    mas cercanos al activo a los mas lejanos.
 */

export const THUMB_WIDTH = 96;
/** Miniaturas que se conservan en memoria (unos pocos KB cada una). */
export const MAX_THUMBS = 60;

export type SequenceMetaDoc = { id: DocId; file: File };

/** Clave de una miniatura: `docId:pagina` (0-based). */
export const thumbKey = (docId: DocId, page: number) => `${docId}:${page}`;

export type SequenceMeta = {
  /** Paginas de cada documento ya contado (el resto, `undefined`). */
  counts: Record<DocId, number | undefined>;
  /** Miniaturas ya hechas, por `thumbKey`. */
  thumbs: Record<string, string | undefined>;
  /** Documentos que pdf.js no pudo abrir. */
  failed: Record<DocId, boolean | undefined>;
  /** El lienzo ya abrio el documento activo y sabe sus paginas: ahorra esperar a la cola. */
  reportCount: (docId: DocId, file: File, count: number) => void;
  /** Miniaturas que la tira tiene a la vista (`thumbKey`); `null` = aun no se sabe. */
  setVisible: (keys: ReadonlySet<string> | null) => void;
};

type State = {
  counts: Record<DocId, number | undefined>;
  thumbs: Record<string, string | undefined>;
  failed: Record<DocId, boolean | undefined>;
  /** Archivo con el que se obtuvo cada dato: un `DocId` que pasa a otro archivo lo invalida. */
  files: Record<DocId, File | undefined>;
};

const EMPTY: State = { counts: {}, thumbs: {}, failed: {}, files: {} };

/** Documentos de los que se hacen miniaturas sin IntersectionObserver: el activo y los dos vecinos. */
export function thumbWindow(
  order: readonly DocId[],
  activeId: DocId,
): DocId[] {
  const index = order.indexOf(activeId);
  if (index === -1) return [];
  return [activeId, order[index + 1], order[index - 1]].filter(
    (id): id is DocId => typeof id === "string",
  );
}

export function useSequenceMeta(
  docs: readonly SequenceMetaDoc[],
  activeId: DocId,
  lazy = true,
): SequenceMeta {
  const [state, setState] = useState<State>(EMPTY);
  const stateRef = useRef<State>(EMPTY);
  const inputsRef = useRef({ docs, activeId, lazy });
  const visibleRef = useRef<ReadonlySet<string> | null>(null);
  const aliveRef = useRef(true);
  const runningRef = useRef(false);

  const commit = useCallback((update: (current: State) => State) => {
    const next = update(stateRef.current);
    if (next === stateRef.current) return;
    stateRef.current = next;
    setState(next);
  }, []);

  /** El documento sigue en la cola y es ESE archivo. */
  const isLive = (doc: SequenceMetaDoc) =>
    inputsRef.current.docs.some((d) => d.id === doc.id && d.file === doc.file);

  /** Miniaturas que hace falta tener ahora, por documento y en orden de lectura. */
  const wantedPages = (): Map<DocId, number[]> => {
    const { docs: list, activeId: active, lazy: isLazy } = inputsRef.current;
    const current = stateRef.current;
    const out = new Map<DocId, number[]>();
    const known = (doc: SequenceMetaDoc) => current.files[doc.id] === doc.file;
    const add = (doc: SequenceMetaDoc, page: number) => {
      if (known(doc) && current.failed[doc.id]) return;
      const count = known(doc) ? current.counts[doc.id] : undefined;
      if (count !== undefined && page >= count) return;
      if (current.thumbs[thumbKey(doc.id, page)]) return;
      const pages = out.get(doc.id) ?? [];
      pages.push(page);
      out.set(doc.id, pages);
    };
    if (isLazy) {
      const visible = visibleRef.current;
      if (visible) {
        for (const key of visible) {
          const at = key.lastIndexOf(":");
          const doc = list.find((d) => d.id === key.slice(0, at));
          if (doc) add(doc, Number(key.slice(at + 1)));
        }
      }
    } else {
      const order = list.map((d) => d.id);
      for (const id of thumbWindow(order, active)) {
        const doc = list.find((d) => d.id === id);
        if (!doc) continue;
        const count = known(doc) ? current.counts[doc.id] : undefined;
        // Sin recuento aun: se pide la primera y el resto llega al conocerlo.
        for (let page = 0; page < (count ?? 1); page += 1) add(doc, page);
      }
    }
    for (const pages of out.values()) pages.sort((a, b) => a - b);
    return out;
  };

  const pickJob = (): { doc: SequenceMetaDoc; thumbs: boolean } | null => {
    const { docs: list, activeId: active } = inputsRef.current;
    const current = stateRef.current;
    const order = list.map((doc) => doc.id);
    const activeIndex = order.indexOf(active);
    const distance = (id: DocId) => Math.abs(order.indexOf(id) - activeIndex);
    const wanted = [...wantedPages().keys()].sort((a, b) => distance(a) - distance(b));
    if (wanted.length > 0) {
      const doc = list.find((d) => d.id === wanted[0]);
      if (doc) return { doc, thumbs: true };
    }
    // Resto de documentos: solo el recuento, de los mas cercanos a los mas lejanos.
    const rest = [...list].sort((a, b) => distance(a.id) - distance(b.id));
    for (const doc of rest) {
      const known = current.files[doc.id] === doc.file;
      if (known && (current.failed[doc.id] || current.counts[doc.id] !== undefined)) {
        continue;
      }
      return { doc, thumbs: false };
    }
    return null;
  };

  const runJob = async (job: { doc: SequenceMetaDoc; thumbs: boolean }) => {
    const { doc } = job;
    const markFailed = () =>
      commit((current) => ({
        ...current,
        failed: { ...current.failed, [doc.id]: true },
        files: { ...current.files, [doc.id]: doc.file },
      }));
    let document: Awaited<ReturnType<typeof openPdfDocument>> | null = null;
    try {
      document = await openPdfDocument(doc.file);
      if (!aliveRef.current || !isLive(doc)) return;
      const pages = document.numPages;
      commit((current) =>
        current.counts[doc.id] === pages && current.files[doc.id] === doc.file
          ? current
          : {
              ...current,
              counts: { ...current.counts, [doc.id]: pages },
              files: { ...current.files, [doc.id]: doc.file },
            },
      );
      if (!job.thumbs) return;
      for (;;) {
        if (!aliveRef.current || !isLive(doc)) return;
        // Un documento con mas prioridad (el activo cambio, aparecio a la vista): cede el turno.
        const next = pickJob();
        if (!next || next.doc.id !== doc.id || !next.thumbs) return;
        const page = wantedPages().get(doc.id)?.[0];
        if (page === undefined || page >= pages) return;
        const handle = await document.getPage(page + 1);
        const url = await renderPageToDataUrl(handle, { maxWidth: THUMB_WIDTH });
        handle.cleanup();
        if (!aliveRef.current || !isLive(doc)) return;
        commit((current) => withThumb(current, thumbKey(doc.id, page), url, visibleRef.current));
      }
    } catch {
      if (aliveRef.current && isLive(doc)) markFailed();
    } finally {
      if (document) void closePdfDocument(document);
    }
  };

  const pump = () => {
    if (runningRef.current || !aliveRef.current) return;
    runningRef.current = true;
    void (async () => {
      try {
        for (;;) {
          if (!aliveRef.current) return;
          const job = pickJob();
          if (!job) return;
          await runJob(job);
        }
      } finally {
        runningRef.current = false;
      }
    })();
  };
  const pumpRef = useRef(pump);
  useEffect(() => {
    pumpRef.current = pump;
  });

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  /* Cambia la cola o el documento activo: poda lo que ya no vale y despierta la cola. */
  useEffect(() => {
    inputsRef.current = { docs, activeId, lazy };
    const live = new Map(docs.map((doc) => [doc.id, doc.file]));
    commit((current) => {
      let changed = false;
      const next: State = {
        counts: { ...current.counts },
        thumbs: { ...current.thumbs },
        failed: { ...current.failed },
        files: { ...current.files },
      };
      for (const id of Object.keys(current.files)) {
        if (live.get(id) !== current.files[id]) {
          delete next.counts[id];
          delete next.failed[id];
          delete next.files[id];
          for (const key of Object.keys(next.thumbs)) {
            if (key.startsWith(`${id}:`)) delete next.thumbs[key];
          }
          changed = true;
        }
      }
      return changed ? next : current;
    });
    pumpRef.current();
  }, [docs, activeId, lazy, commit]);

  const setVisible = useCallback((keys: ReadonlySet<string> | null) => {
    const before = visibleRef.current;
    if (
      before === keys ||
      (before && keys && before.size === keys.size && [...keys].every((key) => before.has(key)))
    ) {
      return;
    }
    visibleRef.current = keys;
    pumpRef.current();
  }, []);

  const reportCount = useCallback(
    (docId: DocId, file: File, count: number) => {
      if (!inputsRef.current.docs.some((d) => d.id === docId && d.file === file)) return;
      commit((current) =>
        current.counts[docId] === count && current.files[docId] === file
          ? current
          : {
              ...current,
              counts: { ...current.counts, [docId]: count },
              files: { ...current.files, [docId]: file },
            },
      );
      pumpRef.current();
    },
    [commit],
  );

  return {
    counts: state.counts,
    thumbs: state.thumbs,
    failed: state.failed,
    reportCount,
    setVisible,
  };
}

/** Anade una miniatura y, pasado `MAX_THUMBS`, suelta las mas antiguas que ya no se ven. */
function withThumb(
  current: State,
  key: string,
  url: string,
  visible: ReadonlySet<string> | null,
): State {
  const thumbs = { ...current.thumbs, [key]: url };
  const keys = Object.keys(thumbs);
  let excess = keys.length - MAX_THUMBS;
  for (const old of keys) {
    if (excess <= 0) break;
    if (old === key || visible?.has(old)) continue;
    delete thumbs[old];
    excess -= 1;
  }
  return { ...current, thumbs };
}
