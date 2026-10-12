"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { useReducedMotionPref } from "@/hooks/useReducedMotionPref";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { isTextEditingTarget } from "@/app/pdf-pro/proShortcuts";
import { getProStrings, type ProStrings } from "@/app/pdf-pro/proStrings";
import { useProViewerContext } from "@/app/pdf-pro/viewer/ProViewerContext";
import { ViewerPage } from "@/app/pdf-pro/viewer/ViewerPage";
import { useDevicePixelRatio } from "@/app/pdf-pro/viewer/useDevicePixelRatio";
import { useViewerGestures } from "@/app/pdf-pro/viewer/useViewerGestures";
import { useViewerImages, type SettledSize } from "@/app/pdf-pro/viewer/useViewerImages";
import { aspectsOf, geometryOf } from "@/app/pdf-pro/viewer/useViewerDocument";
import {
  FALLBACK_ASPECT,
  baseWidthFor,
  bucketViewerZoom,
  captureAnchor,
  computeLayout,
  contentWidthFor,
  currentPageFor,
  imagePages,
  mountedPages,
  pageLeftFor,
  restoreAnchor,
  scrollTopForPage,
  visiblePages,
  visibleRange,
  type PageRange,
  type ViewerAnchor,
  type ViewerLayout,
} from "@/app/pdf-pro/viewer/viewerLayout";
import { isSelectionGesture } from "@/app/pdf-pro/viewer/viewerSelection";
import {
  VIEWER_MAX_IMAGES,
  VIEWER_MAX_MOUNTED,
  VIEWER_MOUNT_OVERSCAN,
  VIEWER_RENDER_OVERSCAN,
  VIEWER_RERENDER_DEBOUNCE_MS,
  type ProViewerProps,
  type ViewerPageInfo,
  type ViewerScrollOptions,
  type ViewerZoomAnchor,
} from "@/app/pdf-pro/viewer/viewerTypes";

/** Paso de las flechas (px). */
const ARROW_STEP = 56;
/** Cuanto dura un desplazamiento suave antes de considerarlo terminado si el navegador no avisa (`scrollend`). */
const SMOOTH_SETTLE_MS = 800;

const A4_GEOMETRY = {
  box: { x: 0, y: 0, width: 595, height: 842 },
  rotation: 0,
  viewWidth: 595,
  viewHeight: 842,
};

/** Describe una hoja para lectores de pantalla: medidas en mm y giro. */
export function pageDescription(
  strings: ProStrings["viewer"],
  geometry: { viewWidth: number; viewHeight: number; rotation: number } | null,
): string {
  if (!geometry) return strings.pageMeasuring;
  const mm = (points: number) => Math.round((points * 25.4) / 72);
  const parts = [strings.pageSize(mm(geometry.viewWidth), mm(geometry.viewHeight))];
  if (geometry.rotation !== 0) parts.push(strings.pageRotated(geometry.rotation));
  return parts.join(", ");
}

export function ProViewer({
  onPageVisible,
  renderPageOverlay,
  renderPageToolbar,
  selectedPages: controlledSelection,
  onSelectPages,
}: ProViewerProps = {}) {
  const { store, documentState } = useProViewerContext();
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const { language } = useI18n();
  const strings = getProStrings(language).viewer;
  const reduced = useReducedMotionPref();
  const dpr = useDevicePixelRatio();

  const scrollerRef = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [range, setRange] = useState<PageRange | null>(null);
  const [focusPage, setFocusPage] = useState<number | null>(null);
  const [focusRequest, setFocusRequest] = useState<number | null>(null);

  const viewerDoc = documentState.document;
  const count = state.pageCount;
  const sizes = viewerDoc?.sizes ?? null;

  /* ------------------------ maquetacion ------------------------ */

  const aspects = useMemo(() => (sizes ? aspectsOf(sizes) : new Float32Array(0)), [sizes]);
  const fallbackAspect = aspects.length > 0 && aspects[0] > 0 ? aspects[0] : FALLBACK_ASPECT;
  const baseWidth = baseWidthFor(box.width);
  const pageWidth = baseWidth * state.zoom;
  const layout: ViewerLayout = useMemo(
    () => computeLayout(aspects, count, pageWidth, fallbackAspect),
    [aspects, count, pageWidth, fallbackAspect],
  );
  const contentWidth = contentWidthFor(box.width, pageWidth);
  const left = pageLeftFor(box.width, pageWidth);

  const layoutRef = useRef(layout);
  const boxRef = useRef(box);
  const stateRef = useRef(state);
  const reducedRef = useRef(reduced);
  const anchorRef = useRef<ViewerAnchor | null>(null);
  const pinnedRef = useRef<number | null>(null);
  const jumpTopRef = useRef(0);
  const smoothingRef = useRef(false);
  const smoothTimerRef = useRef<number | null>(null);
  const seenVisibleRef = useRef(new Set<number>());
  const onVisibleRef = useRef(onPageVisible);
  useEffect(() => {
    stateRef.current = state;
    reducedRef.current = reduced;
    onVisibleRef.current = onPageVisible;
  });

  /* Tamano del visor. */
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setBox((previous) => (previous.width === next.width && previous.height === next.height ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* ------------------------ desplazamiento ------------------------ */

  const syncFromScroll = useCallback((fromUserScroll = false) => {
    const el = scrollerRef.current;
    if (!el) return;
    const current = layoutRef.current;
    const { width, height } = boxRef.current;
    const top = el.scrollTop;
    const horizontal = el.scrollLeft;
    // Un salto ya terminado se suelta en cuanto el usuario se aparta de el.
    if (pinnedRef.current !== null && !smoothingRef.current && Math.abs(top - jumpTopRef.current) > 4) {
      pinnedRef.current = null;
    }
    const nextRange = visibleRange(current, top, height);
    setRange((previous) =>
      previous && nextRange && previous.first === nextRange.first && previous.last === nextRange.last
        ? previous
        : nextRange,
    );
    if (current.count > 0) {
      store.setCurrentPage(currentPageFor(current, top, height, pinnedRef.current), fromUserScroll);
      store.setVisiblePages(visiblePages(nextRange));
      anchorRef.current = captureAnchor(current, width, top, horizontal, 0, 0);
    } else {
      store.setVisiblePages([]);
      anchorRef.current = null;
    }
  }, [store]);

  /* Cada cambio de maquetacion (zoom, ancho, medidas, snapshot) devuelve el punto anclado a su sitio. */
  useLayoutEffect(() => {
    layoutRef.current = layout;
    boxRef.current = box;
    const el = scrollerRef.current;
    if (!el) return;
    const anchor = store.takePendingAnchor() ?? anchorRef.current;
    if (anchor && layout.count > 0 && box.height > 0) {
      const next = restoreAnchor(layout, box.width, box.height, anchor);
      if (Math.abs(el.scrollTop - next.scrollTop) > 0.5) el.scrollTop = next.scrollTop;
      if (Math.abs(el.scrollLeft - next.scrollLeft) > 0.5) el.scrollLeft = next.scrollLeft;
    }
    syncFromScroll();
  }, [layout, box, store, syncFromScroll]);

  /* Saltos y ancla de zoom: lo que el almacen pide al visor. */
  useEffect(() => {
    return store.attach({
      scrollToPage: (index: number, options: ViewerScrollOptions) => {
        const el = scrollerRef.current;
        if (!el) return;
        const current = layoutRef.current;
        const top = scrollTopForPage(current, index, boxRef.current.height, options.align ?? "start");
        const distance = Math.abs(index - stateRef.current.currentPage);
        const requested = options.behavior ?? (distance <= 1 ? "smooth" : "auto");
        const smooth = requested === "smooth" && !reducedRef.current;
        pinnedRef.current = index;
        jumpTopRef.current = top;
        if (smoothTimerRef.current !== null) window.clearTimeout(smoothTimerRef.current);
        smoothingRef.current = smooth;
        if (smooth) {
          smoothTimerRef.current = window.setTimeout(() => {
            smoothingRef.current = false;
            smoothTimerRef.current = null;
          }, SMOOTH_SETTLE_MS);
        }
        if (typeof el.scrollTo === "function") el.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
        else el.scrollTop = top;
        if (options.focus) setFocusRequest(index);
        // Sin evento de scroll (p. ej. ya estaba ahi) tambien se recalcula.
        if (!smooth) syncFromScroll();
      },
      captureZoomAnchor: (anchor?: ViewerZoomAnchor) => {
        const el = scrollerRef.current;
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        const { width, height } = boxRef.current;
        const vx = anchor ? Math.min(width, Math.max(0, anchor.clientX - rect.left)) : width / 2;
        const vy = anchor ? Math.min(height, Math.max(0, anchor.clientY - rect.top)) : height / 2;
        return captureAnchor(layoutRef.current, width, el.scrollTop, el.scrollLeft, vx, vy);
      },
      focus: () => {
        setFocusRequest(stateRef.current.currentPage);
      },
    });
  }, [store, syncFromScroll]);

  useEffect(
    () => () => {
      if (smoothTimerRef.current !== null) window.clearTimeout(smoothTimerRef.current);
    },
    [],
  );

  /* La pagina visible nunca se pierde con un snapshot nuevo de menos paginas. */
  useEffect(() => {
    if (count > 0 && state.currentPage >= count) store.setCurrentPage(count - 1);
  }, [count, state.currentPage, store]);

  /* `onPageVisible`: una vez por entrada en el rango visible. */
  useEffect(() => {
    const seen = seenVisibleRef.current;
    const now = new Set(state.visiblePages);
    for (const page of seen) if (!now.has(page)) seen.delete(page);
    for (const page of now) {
      if (!seen.has(page)) {
        seen.add(page);
        onVisibleRef.current?.(page);
      }
    }
  }, [state.visiblePages]);

  /* ------------------------ zoom ------------------------ */
  useViewerGestures(scrollerRef, store, true);

  /*
   * Zoom asentado: los bitmaps se redibujan tras una pausa (el pellizco manda muchos cambios). Hasta que el visor
   * tiene medida (ancho 0) no se dibuja nada: el primer bitmap ya sale al tamano de verdad, no a uno provisional.
   */
  const measured = box.width > 0;
  const bucket = bucketViewerZoom(state.zoom);
  const wantedKey = `${bucket}@${Math.round(baseWidth)}x${dpr}`;
  const [settledState, setSettledState] = useState<string | null>(null);
  const settledKey = settledState ?? (measured ? wantedKey : null);
  useEffect(() => {
    if (!measured) return;
    if (settledState === null) {
      queueMicrotask(() => setSettledState(wantedKey));
      return;
    }
    if (settledState === wantedKey) return;
    const timer = window.setTimeout(() => setSettledState(wantedKey), VIEWER_RERENDER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [measured, wantedKey, settledState]);
  const settled: SettledSize = useMemo(() => {
    const key = settledKey ?? wantedKey;
    const [bucketText, rest] = key.split("@");
    const [baseText, dprText] = rest.split("x");
    return { key, bucket: Number(bucketText), base: Number(baseText), dpr: Number(dprText) };
  }, [settledKey, wantedKey]);

  /* ------------------------ paginas montadas e imagenes ------------------------ */
  const mounted = useMemo(
    () => mountedPages(range, count, VIEWER_MOUNT_OVERSCAN, VIEWER_MAX_MOUNTED, focusPage !== null ? [focusPage] : []),
    [range, count, focusPage],
  );
  const imageWindow = useMemo(
    () => (measured ? imagePages(range, count, VIEWER_RENDER_OVERSCAN, VIEWER_MAX_IMAGES, state.currentPage) : []),
    [measured, range, count, state.currentPage],
  );
  const { images, failed, renderKey } = useViewerImages({
    document: viewerDoc,
    pages: imageWindow,
    center: state.currentPage,
    settled,
  });

  /* Foco pedido (salto con foco, atajos): cuando la hoja esta montada se le da el foco. */
  useEffect(() => {
    if (focusRequest === null) return;
    const el = feedRef.current?.querySelector<HTMLElement>(`[data-page-index="${focusRequest}"]`);
    if (!el) return;
    el.focus({ preventScroll: true });
    queueMicrotask(() => setFocusRequest(null));
  }, [focusRequest, mounted]);

  /* ------------------------ seleccion ------------------------ */
  const selection = state.selectedPages;
  const lastReportedRef = useRef<ReadonlySet<number> | null>(null);
  const sameAs = (a: ReadonlySet<number>, b: ReadonlySet<number>) => a.size === b.size && [...a].every((page) => b.has(page));
  useEffect(() => {
    if (!controlledSelection) return;
    if (!sameAs(controlledSelection, selection)) store.setSelectedPages(controlledSelection);
    // `pageCount`: al abrirse el documento la seleccion pedida antes se vuelve a aplicar (ya hay paginas).
  }, [controlledSelection, selection, store, state.pageCount]);
  useEffect(() => {
    if (lastReportedRef.current === null) {
      lastReportedRef.current = selection;
      return;
    }
    if (lastReportedRef.current === selection) return;
    lastReportedRef.current = selection;
    // Lo que el padre ya sabe (su propia seleccion devuelta al almacen) no se le vuelve a contar.
    if (controlledSelection && sameAs(controlledSelection, selection)) return;
    onSelectPages?.(selection);
  }, [selection, onSelectPages, controlledSelection]);

  const onClickPage = useCallback(
    (index: number, event: MouseEvent<HTMLElement>) => {
      if (event.defaultPrevented) return;
      const gesture = isSelectionGesture(event);
      if (!gesture) return;
      if (gesture.shift) store.selectRange(index);
      else store.togglePage(index);
    },
    [store],
  );

  /* ------------------------ teclado y foco ------------------------ */
  const goTo = useCallback(
    (index: number, focus = true) => store.scrollToPage(index, { focus }),
    [store],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Solo la hoja con el foco: los controles de la capa superpuesta gestionan sus propias teclas.
    const target = event.target as HTMLElement;
    if (!target.hasAttribute("data-page-index") || isTextEditingTarget(target)) return;
    const { currentPage, pageCount } = stateRef.current;
    const el = scrollerRef.current;
    const modifier = event.ctrlKey || event.metaKey;
    const scrollBy = (dx: number, dy: number) => {
      if (!el) return;
      if (typeof el.scrollBy === "function") el.scrollBy({ left: dx, top: dy, behavior: "auto" });
      else {
        el.scrollLeft += dx;
        el.scrollTop += dy;
      }
    };
    const center: ViewerZoomAnchor | undefined = el
      ? (() => {
          const rect = el.getBoundingClientRect();
          return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
        })()
      : undefined;
    switch (event.key) {
      case "PageDown":
        event.preventDefault();
        goTo(Math.min(pageCount - 1, currentPage + 1));
        return;
      case "PageUp":
        event.preventDefault();
        goTo(Math.max(0, currentPage - 1));
        return;
      case "Home":
        event.preventDefault();
        store.scrollToPage(0, { focus: true, behavior: "auto" });
        return;
      case "End":
        event.preventDefault();
        store.scrollToPage(pageCount - 1, { focus: true, behavior: "auto" });
        return;
      case "ArrowDown":
        event.preventDefault();
        scrollBy(0, ARROW_STEP);
        return;
      case "ArrowUp":
        event.preventDefault();
        scrollBy(0, -ARROW_STEP);
        return;
      case "ArrowRight":
        event.preventDefault();
        scrollBy(ARROW_STEP, 0);
        return;
      case "ArrowLeft":
        event.preventDefault();
        scrollBy(-ARROW_STEP, 0);
        return;
      case "+":
      case "=":
        event.preventDefault();
        store.zoomIn(center);
        return;
      case "-":
      case "_":
        event.preventDefault();
        store.zoomOut(center);
        return;
      case "0":
        event.preventDefault();
        store.fitWidth();
        return;
      case "Escape":
        if (stateRef.current.selectedPages.size > 0) {
          event.preventDefault();
          store.clearSelection();
        }
        return;
      case "a":
      case "A":
        if (modifier) {
          event.preventDefault();
          store.selectAll();
        }
        return;
      default:
    }
  };

  const onFeedFocus = (event: FocusEvent<HTMLDivElement>) => {
    const article = (event.target as HTMLElement).closest<HTMLElement>("[data-page-index]");
    setFocusPage(article ? Number(article.dataset.pageIndex) : null);
  };
  const onFeedBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!feedRef.current?.contains(event.relatedTarget as Node | null)) setFocusPage(null);
  };

  /* ------------------------ capas por pagina ------------------------ */
  const overlayFn = renderPageOverlay ?? store.getOverlay();
  const toolbarFn = renderPageToolbar ?? store.getPageToolbar();
  const tabStop = focusPage ?? state.currentPage;

  const pageInfo = (index: number): ViewerPageInfo | null => {
    if (!sizes) return null;
    const geometry = geometryOf(sizes, index);
    if (!geometry) return null;
    return {
      index,
      widthPx: pageWidth,
      heightPx: layout.heights[index],
      scale: pageWidth / Math.max(1, geometry.viewWidth),
      geometry,
    };
  };

  /* ------------------------ estados vacio / cargando / error ------------------------ */
  const status = documentState.status;
  const showLoading = (status === "loading" || status === "idle") && !viewerDoc;
  const showError = status === "error" && !viewerDoc;
  const showEmpty = viewerDoc !== null && count === 0;
  const showFeed = count > 0 && !showError;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-pro-viewer="" data-ready={viewerDoc ? "" : undefined}>
      <div
        ref={scrollerRef}
        data-pro-viewer-scroller=""
        onScroll={() => syncFromScroll(true)}
        className={cn(
          "min-h-0 flex-1 overflow-auto overscroll-contain [scrollbar-gutter:stable] [touch-action:pan-x_pan-y]",
          "bg-white/3",
        )}
      >
        {showFeed ? (
          <div
            ref={feedRef}
            role="feed"
            aria-label={strings.feedLabel}
            aria-busy={!viewerDoc || undefined}
            onKeyDown={onKeyDown}
            onFocus={onFeedFocus}
            onBlur={onFeedBlur}
            data-pro-feed=""
            data-zoom={state.zoom}
            className="relative"
            style={{ height: layout.total, width: contentWidth }}
          >
            {mounted.map((index) => {
              const info = pageInfo(index);
              const image = images[index];
              const geometry = sizes ? geometryOf(sizes, index) : null;
              const overlay = info && overlayFn ? overlayFn(info) : null;
              const toolbar = info && toolbarFn && index === state.currentPage ? toolbarFn(info) : null;
              return (
                <ViewerPage
                  key={index}
                  index={index}
                  count={count}
                  top={layout.tops[index]}
                  left={left}
                  width={pageWidth}
                  height={layout.heights[index]}
                  imageUrl={image?.url ?? null}
                  failed={failed[index] === renderKey}
                  measured={geometry !== null}
                  current={index === state.currentPage}
                  selected={selection.has(index)}
                  tabStop={index === tabStop}
                  label={strings.pageOf(index + 1, count)}
                  description={pageDescription(strings, geometry ?? (sizes ? null : A4_GEOMETRY))}
                  selectedLabel={strings.pageSelected}
                  failedLabel={strings.pageFailed}
                  overlay={overlay}
                  toolbar={toolbar}
                  onClickPage={onClickPage}
                />
              );
            })}
          </div>
        ) : null}
      </div>

      {showLoading ? (
        <div role="presentation" className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
          <Spinner className="size-6" />
          <p className="text-footnote text-muted-foreground">{strings.loading}</p>
        </div>
      ) : null}
      {showEmpty ? (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-6 text-center">
          <p className="text-subheadline text-muted-foreground">{strings.noPages}</p>
        </div>
      ) : null}
      {showError ? (
        <div role="alert" className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertTriangle aria-hidden="true" className="size-6 text-accent-edit" />
          <p className="text-subheadline font-semibold text-foreground">{strings.errorTitle}</p>
          <p className="max-w-sm text-footnote text-muted-foreground">{strings.errorBody}</p>
          <Button size="md" variant="secondary" onClick={documentState.retry}>
            {strings.retry}
          </Button>
        </div>
      ) : null}
      {documentState.opening && viewerDoc ? (
        <span className="sr-only" data-pro-opening="">
          {strings.loading}
        </span>
      ) : null}
    </div>
  );
}
