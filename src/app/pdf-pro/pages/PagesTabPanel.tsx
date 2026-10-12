"use client";

import { useMemo, useSyncExternalStore } from "react";
import { PagesTab, type PagesSelectionBridge } from "@/app/pdf-pro/pages/PagesTab";
import { useProViewerOptional } from "@/app/pdf-pro/viewer/ProViewerContext";

/**
 * Contenido de la pestana «Paginas» en la suite (Wave 7 · U4): el organizador conectado al visor
 * continuo. La seleccion de paginas se comparte con el visor mientras no hay cambios sin aplicar, y
 * seleccionar UNA pagina lleva el visor a ella. Sin visor (pruebas sueltas) funciona igual, sin puente.
 */
export function PagesTabPanel() {
  const viewer = useProViewerOptional();
  return viewer ? <PagesTabWithViewer /> : <PagesTab />;
}

function PagesTabWithViewer() {
  const viewer = useProViewerOptional();
  // `viewer` no es nulo aqui (lo comprueba el padre); el almacen se lee de forma reactiva.
  const store = viewer?.store;
  const selectedPages = useSyncExternalStore(
    (listener) => (store ? store.subscribe(listener) : () => undefined),
    () => store?.getState().selectedPages,
    () => undefined,
  );
  const bridge = useMemo<PagesSelectionBridge | undefined>(
    () =>
      store
        ? {
            selectedPages,
            onSelectPages: (pages) => store.setSelectedPages(pages),
            scrollToPage: (page) => store.scrollToPage(page, { behavior: "auto" }),
          }
        : undefined,
    [store, selectedPages],
  );
  const shown = viewer?.documentState.document ?? null;
  // El visor ya tiene el documento abierto: las miniaturas lo comparten (una copia menos en memoria).
  const sharedPdf = shown ? { snapshotId: shown.snapshotId, doc: shown.doc } : null;
  return <PagesTab bridge={bridge} sharedPdf={sharedPdf} />;
}
