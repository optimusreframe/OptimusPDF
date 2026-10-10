"use client";

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { Layers } from "lucide-react";
import { cn } from "@/lib/cn";
import type { EditInlineStrings } from "@/app/edit-pdf/strings";
import { usePageThumbs } from "@/app/edit-pdf/usePageThumbs";

/*
 * Tira de miniaturas de las paginas (W5-U4b).
 *
 * Una celda por pagina (de tamano fijo: la tira no se reacomoda al llegar las
 * imagenes, asi el observador no entra en bucle) y solo las que estan a la vista
 * se rasterizan, de a una (`usePageThumbs`). Las demas son un hueco con el
 * numero. Patron de lista de botones con tabindex itinerante: una sola parada
 * de Tab (la pagina activa o la ultima enfocada); flechas, Inicio y Fin mueven el
 * foco; Intro o clic van a la pagina. La celda de la pagina activa lleva
 * `aria-current="page"`. Con muchas paginas no hay un botonazo de 300 paradas
 * de Tab.
 */

export type PageStripProps = {
  doc: PDFDocumentProxy | null;
  pageCount: number;
  activeIndex: number;
  /** Cambios (ediciones, imagenes, formas) por pagina, para la marca de la celda. */
  counts: ReadonlyMap<number, number>;
  /** (W5-U5) Paginas que se aplanaran al exportar, con su marca para lectores de pantalla. */
  flattened?: ReadonlySet<number>;
  flattenMark?: string;
  onGo: (index: number) => void;
  strings: EditInlineStrings;
  id?: string;
  className?: string;
};

const CELL_WIDTH_PX = 56;
const CELL_GAP_PX = 8;


type ThumbCellProps = {
  index: number;
  url: string | undefined;
  changes: number;
  flattened: boolean;
  flattenMark: string;
  active: boolean;
  tabStop: boolean;
  strings: EditInlineStrings;
  onGo: (index: number) => void;
  onFocusCell: (index: number | null) => void;
};

/** Una celda. Memoizada: cargar una miniatura no vuelve a pintar las demas (documentos de cientos de paginas). */
const ThumbCell = memo(function ThumbCell({
  index,
  url,
  changes,
  flattened,
  flattenMark,
  active,
  tabStop,
  strings,
  onGo,
  onFocusCell,
}: ThumbCellProps) {
  return (
    <div role="listitem" className="shrink-0">
      <button
        type="button"
        data-page-thumb={index}
        data-thumb-loaded={url ? "" : undefined}
        aria-label={
          flattened
            ? `${strings.thumbLabel(index + 1, changes)}, ${flattenMark}`
            : strings.thumbLabel(index + 1, changes)
        }
        data-thumb-flattened={flattened ? "" : undefined}
        aria-current={active ? "page" : undefined}
        tabIndex={tabStop ? 0 : -1}
        onFocus={() => onFocusCell(index)}
        onBlur={() => onFocusCell(null)}
        onClick={() => onGo(index)}
        className={cn(
          "relative flex h-[4.5rem] w-14 items-center justify-center overflow-hidden rounded-ios-sm bg-white/6",
          "transition-[box-shadow,background-color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
          "active:scale-[0.96] active:duration-[80ms]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 outline-signal",
          active
            ? "shadow-[inset_0_0_0_2px_var(--color-signal)]"
            : "shadow-[inset_0_0_0_1px_var(--color-hairline)] hover:bg-white/10",
        )}
      >
        {url ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={url}
            alt=""
            draggable={false}
            className="max-h-full max-w-full rounded-[3px] bg-white object-contain"
          />
        ) : null}
        {flattened ? (
          <span
            aria-hidden="true"
            className="absolute top-0.5 left-0.5 flex size-5 items-center justify-center rounded-full bg-background/85 text-signal-text"
          >
            <Layers className="size-3" />
          </span>
        ) : null}
        <span
          aria-hidden="true"
          className={cn(
            "absolute right-0.5 bottom-0.5 rounded-full px-1.5 py-0.5 text-caption-2 leading-tight font-semibold tabular-nums",
            "bg-background/85 text-foreground",
          )}
        >
          {changes > 0 ? `${index + 1} · ${changes}` : index + 1}
        </span>
      </button>
    </div>
  );
});

export function PageStrip({
  doc,
  pageCount,
  activeIndex,
  counts,
  flattened,
  flattenMark = "",
  onGo,
  strings,
  id,
  className,
}: PageStripProps) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const { thumbs, setVisible } = usePageThumbs(doc, activeIndex);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const visibleRef = useRef(new Set<number>());
  const observerRef = useRef<IntersectionObserver | null>(null);

  const stop = focusIndex !== null && focusIndex < pageCount ? focusIndex : activeIndex;

  /* Que celdas se ven: alimenta la cola de miniaturas. */
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || typeof IntersectionObserver === "undefined") return;
    const visible = visibleRef.current;
    visible.clear();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = Number((entry.target as HTMLElement).dataset.pageThumb);
          if (!Number.isFinite(page)) continue;
          if (entry.isIntersecting) visible.add(page);
          else visible.delete(page);
        }
        setVisible(new Set(visible));
      },
      // Un par de celdas de margen: la siguiente ya esta lista cuando llega a la vista.
      { root: scroller, rootMargin: `0px ${CELL_WIDTH_PX * 2}px` },
    );
    observerRef.current = observer;
    scroller.querySelectorAll<HTMLElement>("[data-page-thumb]").forEach((cell) => observer.observe(cell));
    setVisible(new Set());
    return () => {
      observer.disconnect();
      observerRef.current = null;
      setVisible(null);
    };
  }, [pageCount, setVisible]);

  /* La celda activa siempre a la vista (sin tocar el desplazamiento de la pagina). */
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const cell = scroller.querySelector<HTMLElement>(`[data-page-thumb="${activeIndex}"]`);
    const left = cell ? cell.offsetLeft : activeIndex * (CELL_WIDTH_PX + CELL_GAP_PX);
    const width = cell ? cell.offsetWidth : CELL_WIDTH_PX;
    const viewLeft = scroller.scrollLeft;
    const viewRight = viewLeft + scroller.clientWidth;
    if (left < viewLeft) scroller.scrollLeft = Math.max(0, left - CELL_GAP_PX);
    else if (left + width > viewRight) scroller.scrollLeft = left + width - scroller.clientWidth + CELL_GAP_PX;
  }, [activeIndex, pageCount]);

  const focusCell = useCallback((index: number) => {
    const scroller = scrollerRef.current;
    scroller?.querySelector<HTMLElement>(`[data-page-thumb="${index}"]`)?.focus();
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = Number((document.activeElement as HTMLElement | null)?.dataset.pageThumb);
    if (!Number.isFinite(current)) return;
    let next = -1;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = Math.min(pageCount - 1, current + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = Math.max(0, current - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = pageCount - 1;
    if (next === -1) return;
    event.preventDefault();
    focusCell(next);
  };

  const pages = useMemo(() => Array.from({ length: pageCount }, (_, index) => index), [pageCount]);
  // Callback estable: con cientos de celdas, solo se vuelve a pintar la que cambia.
  const onGoRef = useRef(onGo);
  useEffect(() => {
    onGoRef.current = onGo;
  });
  const go = useCallback((index: number) => onGoRef.current(index), []);

  return (
    <nav
      id={id}
      aria-label={strings.thumbsLabel}
      data-page-strip=""
      className={cn("surface-card rounded-ios p-2", className)}
    >
      <div
        ref={scrollerRef}
        role="list"
        onKeyDown={onKeyDown}
        className="flex gap-2 overflow-x-auto overscroll-x-contain pb-1"
        style={{ scrollbarWidth: "thin" }}
      >
        {pages.map((index) => (
          <ThumbCell
            key={index}
            index={index}
            url={thumbs[index]}
            changes={counts.get(index) ?? 0}
            flattened={flattened?.has(index) ?? false}
            flattenMark={flattenMark}
            active={index === activeIndex}
            tabStop={stop === index}
            strings={strings}
            onGo={go}
            onFocusCell={setFocusIndex}
          />
        ))}
      </div>
    </nav>
  );
}
