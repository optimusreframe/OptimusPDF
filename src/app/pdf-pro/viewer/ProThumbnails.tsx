"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { X } from "lucide-react";
import { usePageThumbs } from "@/app/edit-pdf/usePageThumbs";
import { cn } from "@/lib/cn";
import { useI18n } from "@/lib/i18n";
import { getProStrings } from "@/app/pdf-pro/proStrings";
import { useProViewer } from "@/app/pdf-pro/viewer/ProViewerContext";
import { aspectsOf } from "@/app/pdf-pro/viewer/useViewerDocument";
import { FALLBACK_ASPECT } from "@/app/pdf-pro/viewer/viewerLayout";
import { isSelectionGesture } from "@/app/pdf-pro/viewer/viewerSelection";
import { useDevicePixelRatio } from "@/app/pdf-pro/viewer/useDevicePixelRatio";

/** Ancho CSS de una miniatura (px) a efectos del bitmap: 160 cubre el rango 120-160 de la rejilla. */
export const THUMB_CSS_WIDTH = 160;
/** Miniaturas que se conservan en memoria. */
export const PRO_MAX_THUMBS = 80;
/** Saltos de PageUp/PageDown dentro de la lista. */
export const THUMB_PAGE_STEP = 8;

type ThumbItemProps = {
  index: number;
  aspect: number;
  url: string | undefined;
  current: boolean;
  selected: boolean;
  tabStop: boolean;
  label: string;
  onActivate: (index: number, event: MouseEvent<HTMLElement>) => void;
  register: (index: number, element: HTMLElement | null) => void;
};

/** Una miniatura (opcion del listbox). Memoizada: cambiar de pagina repinta solo dos. */
const ThumbItem = memo(function ThumbItem({
  index,
  aspect,
  url,
  current,
  selected,
  tabStop,
  label,
  onActivate,
  register,
}: ThumbItemProps) {
  return (
    <li
      ref={(element) => register(index, element)}
      role="option"
      aria-selected={selected}
      aria-current={current ? "page" : undefined}
      aria-label={label}
      tabIndex={tabStop ? 0 : -1}
      data-thumb-index={index}
      data-current={current || undefined}
      onClick={(event) => onActivate(index, event)}
      className={cn(
        "relative flex min-h-11 cursor-pointer flex-col items-center gap-1 rounded-ios-sm p-1.5 outline-none",
        "transition-colors duration-[var(--duration-fast)]",
        "hover:bg-white/6",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal forced-colors:focus-visible:outline-[Highlight]",
        selected && "bg-signal/15 forced-colors:border forced-colors:border-[Highlight]",
        current && !selected && "bg-white/10 forced-colors:border forced-colors:border-[CanvasText]",
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "relative block w-full overflow-hidden rounded-[3px] bg-white shadow-elevation-1",
          current && "ring-2 ring-signal forced-colors:ring-[Highlight]",
        )}
        style={{ aspectRatio: `${1} / ${aspect}` }}
      >
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="" draggable={false} className="absolute inset-0 size-full object-contain" />
        ) : null}
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "text-caption tabular-nums",
          current || selected ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        {index + 1}
      </span>
    </li>
  );
});

export type ProThumbnailsProps = {
  /** `rail`: columna del panel lateral. `grid`: rejilla en una hoja (movil). */
  variant?: "rail" | "grid";
  id?: string;
  className?: string;
  /** Se llama tras saltar a una pagina con clic o Intro (la hoja movil se cierra con ello). */
  onAfterNavigate?: () => void;
};

/**
 * Miniaturas perezosas de las paginas (Wave 7 · U3): una cola de render con concurrencia 1, solo las que la
 * lista tiene a la vista (IntersectionObserver) y como mucho 80 en memoria. Es un `listbox` multiseleccion:
 * clic salta a la pagina, Ctrl/Cmd+clic alterna, Shift+clic selecciona un rango, y el teclado (flechas, Inicio,
 * Fin, Av/Re Pag, Intro, Espacio, Esc, Ctrl+A) hace lo mismo con un unico tabulador (roving tabindex).
 * La seleccion es la MISMA del visor.
 */
export function ProThumbnails({ variant = "rail", id, className, onAfterNavigate }: ProThumbnailsProps) {
  const { language } = useI18n();
  const strings = getProStrings(language).viewer;
  const { store, state, documentState } = useProViewer();
  const dpr = useDevicePixelRatio();
  const viewerDoc = documentState.document;
  const pdfDoc = viewerDoc?.doc ?? null;
  const count = state.pageCount;
  const { thumbs, setVisible } = usePageThumbs(pdfDoc, state.currentPage, true, {
    width: Math.round(THUMB_CSS_WIDTH * Math.min(2, Math.max(1, dpr))),
    max: PRO_MAX_THUMBS,
  });

  const aspects = useMemo(() => (viewerDoc ? aspectsOf(viewerDoc.sizes) : new Float32Array(0)), [viewerDoc]);
  const fallback = aspects.length > 0 && aspects[0] > 0 ? aspects[0] : FALLBACK_ASPECT;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const elementsRef = useRef(new Map<number, HTMLElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const visibleRef = useRef(new Set<number>());
  const [focusIndex, setFocusIndex] = useState<number | null>(null);

  /* Observador de visibilidad: la lista decide que miniaturas hacen falta. */
  useEffect(() => {
    const root = scrollerRef.current;
    if (typeof IntersectionObserver === "undefined" || !root) return;
    visibleRef.current = new Set();
    let frame = 0;
    const flush = () => {
      frame = 0;
      setVisible(new Set(visibleRef.current));
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset.thumbIndex);
          if (entry.isIntersecting) visibleRef.current.add(index);
          else visibleRef.current.delete(index);
        }
        if (!frame) frame = window.requestAnimationFrame(flush);
      },
      { root, rootMargin: "240px 0px" },
    );
    observerRef.current = observer;
    // Hasta el primer aviso del observador no se sabe que se ve: «nada» (no la ventana de reserva de la activa).
    setVisible(new Set());
    for (const element of elementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
      if (frame) window.cancelAnimationFrame(frame);
      setVisible(null);
    };
  }, [setVisible, count]);

  const register = useCallback((index: number, element: HTMLElement | null) => {
    const previous = elementsRef.current.get(index);
    if (previous && previous !== element) observerRef.current?.unobserve(previous);
    if (element) {
      elementsRef.current.set(index, element);
      observerRef.current?.observe(element);
    } else {
      elementsRef.current.delete(index);
      visibleRef.current.delete(index);
    }
  }, []);

  /* La miniatura de la pagina actual sigue a la vista cuando el visor se desplaza. */
  const currentPage = state.currentPage;
  useLayoutEffect(() => {
    const root = scrollerRef.current;
    const item = elementsRef.current.get(currentPage);
    if (!root || !item || root.clientHeight === 0) return;
    const top = item.offsetTop;
    const bottom = top + item.offsetHeight;
    if (top < root.scrollTop || bottom > root.scrollTop + root.clientHeight) {
      root.scrollTop = Math.max(0, top - (root.clientHeight - item.offsetHeight) / 2);
    }
  }, [currentPage]);

  const onActivate = useCallback(
    (index: number, event: MouseEvent<HTMLElement>) => {
      const gesture = isSelectionGesture(event);
      if (gesture?.shift) store.selectRange(index);
      else if (gesture?.ctrl) store.togglePage(index);
      else {
        store.scrollToPage(index, { behavior: "auto" });
        onAfterNavigate?.();
      }
    },
    [store, onAfterNavigate],
  );

  const moveFocus = (index: number) => {
    const next = Math.min(count - 1, Math.max(0, index));
    setFocusIndex(next);
    const element = elementsRef.current.get(next);
    element?.focus({ preventScroll: true });
    // Mantiene a la vista la miniatura enfocada sin mover la pagina entera.
    const root = scrollerRef.current;
    if (root && element) {
      if (element.offsetTop < root.scrollTop) root.scrollTop = element.offsetTop - 8;
      else if (element.offsetTop + element.offsetHeight > root.scrollTop + root.clientHeight) {
        root.scrollTop = element.offsetTop + element.offsetHeight - root.clientHeight + 8;
      }
    }
    return next;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>("[data-thumb-index]");
    if (!item) return;
    const index = Number(item.dataset.thumbIndex);
    const modifier = event.ctrlKey || event.metaKey;
    const extend = (next: number) => {
      // Mayus+flecha: amplia la seleccion desde la miniatura que tenia el foco.
      if (store.getSelectedPages().length === 0) store.setSelectedPages([index]);
      store.selectRange(next);
    };
    let target: number | null = null;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        target = index + 1;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        target = index - 1;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = count - 1;
        break;
      case "PageDown":
        target = index + THUMB_PAGE_STEP;
        break;
      case "PageUp":
        target = index - THUMB_PAGE_STEP;
        break;
      case "Enter":
        event.preventDefault();
        store.scrollToPage(index, { behavior: "auto" });
        onAfterNavigate?.();
        return;
      case " ":
        event.preventDefault();
        store.togglePage(index);
        return;
      case "Escape":
        if (state.selectedPages.size > 0) {
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
        return;
    }
    event.preventDefault();
    const next = moveFocus(target);
    if (event.shiftKey) extend(next);
  };

  const tabStop = focusIndex !== null && focusIndex < count ? focusIndex : state.currentPage;
  const items = useMemo(() => Array.from({ length: count }, (_, index) => index), [count]);

  if (count === 0) return null;
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)} id={id}>
      {/* El recuento va en la barra del visor; en la hoja de movil (que la tapa) se repite aqui. */}
      {variant === "grid" && state.selectedPages.size > 0 ? (
        <div className="mb-1 flex shrink-0 items-center justify-between gap-2 px-1 text-footnote text-muted-foreground">
          <span data-selection-count="">{strings.selectedCount(state.selectedPages.size)}</span>
          <button
            type="button"
            onClick={() => store.clearSelection()}
            aria-label={strings.clearSelection}
            title={strings.clearSelection}
            className="group flex size-11 shrink-0 items-center justify-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-[-6px] focus-visible:outline-signal"
          >
            <span className="flex size-8 items-center justify-center rounded-full text-foreground group-hover:bg-white/10">
              <X aria-hidden="true" className="size-4" />
            </span>
          </button>
        </div>
      ) : null}
      <div ref={scrollerRef} data-pro-thumbs-scroller="" className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ul
          ref={listRef}
          role="listbox"
          aria-multiselectable="true"
          aria-label={strings.thumbsListLabel(count)}
          onKeyDown={onKeyDown}
          onFocus={(event) => {
            const item = (event.target as HTMLElement).closest<HTMLElement>("[data-thumb-index]");
            if (item) setFocusIndex(Number(item.dataset.thumbIndex));
          }}
          className={cn(variant === "grid" ? "grid grid-cols-3 gap-2 sm:grid-cols-4" : "flex flex-col gap-1")}
        >
          {items.map((index) => (
            <ThumbItem
              key={index}
              index={index}
              aspect={aspects[index] > 0 ? aspects[index] : fallback}
              url={thumbs[index]}
              current={index === state.currentPage}
              selected={state.selectedPages.has(index)}
              tabStop={index === tabStop}
              label={strings.thumbLabel(index + 1)}
              onActivate={onActivate}
              register={register}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}
