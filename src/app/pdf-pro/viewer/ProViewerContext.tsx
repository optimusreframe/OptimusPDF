"use client";

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useI18n } from "@/lib/i18n";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { createViewerStore, type ProViewerStore } from "@/app/pdf-pro/viewer/viewerStore";
import { useViewerDocument, type ViewerDocumentState } from "@/app/pdf-pro/viewer/useViewerDocument";
import { zoomPercent } from "@/app/pdf-pro/viewer/viewerLayout";
import { viewerSignatureMemo } from "@/app/pdf-pro/viewer/pageSignature";
import { viewerRasterCache } from "@/app/pdf-pro/viewer/viewerRasterCache";
import type {
  ProViewerApi,
  ProViewerState,
  ViewerPageOverlay,
  ViewerPageToolbarSlot,
  ViewerSnapshot,
} from "@/app/pdf-pro/viewer/viewerTypes";

/*
 * Proveedor del visor (Wave 7 · U3): crea el almacen (`ProViewerStore`), abre el documento de pdf.js del
 * snapshot vigente y conecta los anuncios (region viva UNICA de la pagina) de saltos y zoom. Todos los
 * consumidores (visor, miniaturas, barra, paleta, pestañas de los modos) leen lo mismo de aqui.
 */

type ViewerContextValue = { store: ProViewerStore; documentState: ViewerDocumentState };

const ViewerContext = createContext<ViewerContextValue | null>(null);

export type ProViewerProviderProps = {
  snapshot: ViewerSnapshot | null;
  /**
   * Paginas del documento de trabajo, conocidas antes de que pdf.js termine de abrirlo: el visor y las
   * miniaturas reservan sus huecos al instante en vez de aparecer vacios.
   */
  pageCountHint?: number;
  /** Anuncia un texto en la region viva unica (`ProWorkingDoc.announce`). */
  announce?: (text: string) => void;
  /**
   * Identificador del ultimo anuncio de la region viva (`ProWorkingState.announcement.id`). Si otro anuncio
   * (p. ej. «Aplicado: ...») llega mientras se espera la pausa del zoom o del desplazamiento, esos avisos
   * atrasados se descartan: no pisan un mensaje mas importante.
   */
  getAnnouncementId?: () => number | null;
  /** Almacen ya creado (tests). */
  store?: ProViewerStore;
  children: ReactNode;
};

/** Espera tras el ultimo cambio de zoom antes de anunciarlo (la rueda manda decenas por segundo). */
const ZOOM_ANNOUNCE_DELAY_MS = 350;
/** Espera tras dejar de desplazarse antes de anunciar la pagina a la que se llego. */
export const SCROLL_ANNOUNCE_DELAY_MS = 700;

export function ProViewerProvider({
  snapshot,
  pageCountHint = 0,
  announce,
  getAnnouncementId,
  store: given,
  children,
}: ProViewerProviderProps) {
  const { language } = useI18n();
  const [owned] = useState(() => given ?? createViewerStore());
  const store = given ?? owned;
  const documentState = useViewerDocument(snapshot, () => store.getState().currentPage);
  const pageCount = documentState.document?.pageCount ?? pageCountHint;
  const ready = documentState.document !== null;

  useLayoutEffect(() => {
    store.setPageCount(pageCount);
    store.setReady(ready);
  }, [store, pageCount, ready]);

  /* Anuncios por la region viva unica. */
  const announceRef = useRef(announce);
  const announcementIdRef = useRef(getAnnouncementId);
  const languageRef = useRef(language);
  useEffect(() => {
    announceRef.current = announce;
    announcementIdRef.current = getAnnouncementId;
    languageRef.current = language;
  });
  useEffect(() => {
    const zoomTimer: { id: number | null } = { id: null };
    const scrollTimer: { id: number | null } = { id: null };
    store.setNavigationListener((kind) => {
      const strings = getProStrings(languageRef.current).viewer;
      const state = store.getState();
      if (kind === "page") {
        announceRef.current?.(strings.pageOf(state.currentPage + 1, state.pageCount));
        return;
      }
      // Zoom y desplazamiento: se anuncia el ultimo valor tras una pausa (la rueda manda decenas por segundo).
      const timers = kind === "zoom" ? zoomTimer : scrollTimer;
      if (timers.id !== null) window.clearTimeout(timers.id);
      const baseline = announcementIdRef.current?.() ?? null;
      timers.id = window.setTimeout(() => {
        timers.id = null;
        // Otro mensaje se anuncio mientras tanto: el de zoom/pagina ya es viejo y taparia al importante.
        if (announcementIdRef.current && announcementIdRef.current() !== baseline) return;
        const latest = store.getState();
        const text =
          kind === "zoom"
            ? getProStrings(languageRef.current).viewer.zoomLevel(zoomPercent(latest.zoom))
            : getProStrings(languageRef.current).viewer.pageOf(latest.currentPage + 1, latest.pageCount);
        announceRef.current?.(text);
      }, kind === "zoom" ? ZOOM_ANNOUNCE_DELAY_MS : SCROLL_ANNOUNCE_DELAY_MS);
    });
    return () => {
      store.setNavigationListener(null);
      if (zoomTimer.id !== null) window.clearTimeout(zoomTimer.id);
      if (scrollTimer.id !== null) window.clearTimeout(scrollTimer.id);
    };
  }, [store]);

  /* Al cerrar el documento (o salir de /pdf-pro) se libera todo lo dibujado y las huellas. */
  useEffect(
    () => () => {
      viewerRasterCache.clear();
      viewerSignatureMemo.clear();
    },
    [],
  );

  const value = useMemo(() => ({ store, documentState }), [store, documentState]);
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>;
}

export function useProViewerContext(): ViewerContextValue {
  const value = useContext(ViewerContext);
  if (!value) throw new Error("useProViewer necesita <ProViewerProvider>");
  return value;
}

/** Igual que `useProViewerContext` pero devuelve `null` sin proveedor (componentes que funcionan con o sin visor). */
export function useProViewerOptional(): ViewerContextValue | null {
  return useContext(ViewerContext);
}

export type UseProViewer = {
  /** API imperativa (estable). */
  api: ProViewerApi;
  store: ProViewerStore;
  /** Estado reactivo (pagina actual, zoom, visibles, seleccion...). */
  state: ProViewerState;
  /** Documento de pdf.js que se muestra (compartido con las miniaturas). */
  documentState: ViewerDocumentState;
};

/** Estado reactivo + API del visor. */
export function useProViewer(): UseProViewer {
  const { store, documentState } = useProViewerContext();
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  return { api: store, store, state, documentState };
}

/** Solo la API (no repinta con cada cambio del visor). */
export function useProViewerApi(): ProViewerApi {
  return useProViewerContext().store;
}

/** Registra una capa superpuesta por pagina mientras el componente esta montado (y `active`). */
export function useViewerOverlay(overlay: ViewerPageOverlay, active = true): void {
  const { store } = useProViewerContext();
  useEffect(() => {
    if (!active) return;
    return store.registerOverlay(overlay);
  }, [store, overlay, active]);
}

/** Registra la barra de la pagina activa mientras el componente esta montado (y `active`). */
export function useViewerPageToolbar(slot: ViewerPageToolbarSlot, active = true): void {
  const { store } = useProViewerContext();
  useEffect(() => {
    if (!active) return;
    return store.registerPageToolbar(slot);
  }, [store, slot, active]);
}
