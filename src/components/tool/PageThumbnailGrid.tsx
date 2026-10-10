"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw, Trash2 } from "lucide-react";
import { Spinner } from "@/components/ui/Spinner";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  closePdfDocument,
  openPdfDocument,
  renderPageToDataUrl,
  toPdfError,
  type PageRef,
  type PdfErrorCode,
} from "@/lib/pdf/core";

export type PageThumbnailGridProps = {
  files: File[];
  /** Permite marcar y desmarcar paginas. */
  selectable?: boolean;
  /** Muestra el boton de rotar 90 grados. */
  rotatable?: boolean;
  /** Muestra el boton de eliminar pagina. */
  removable?: boolean;
  /** Muestra los controles de reordenacion. */
  reorderable?: boolean;
  /** Se dispara cada vez que cambia el plan de paginas. */
  onItemsChange?: (items: PageRef[]) => void;
  onError?: (code: PdfErrorCode) => void;
  className?: string;
};

const THUMB_WIDTH = 200;

/**
 * Reinicia el estado interno remontando el componente cuando cambia el
 * conjunto de archivos (patron "reset state with a key"), en lugar de
 * limpiar estado desde un efecto.
 */
export function PageThumbnailGrid(props: PageThumbnailGridProps) {
  const key = props.files
    .map((file) => `${file.name}:${file.size}:${file.lastModified}`)
    .join("|");
  return <PageThumbnailGridInner key={key} {...props} />;
}

/*
 * Rejilla de paginas sobre superficie solida: numero de pagina como
 * etiqueta sobre la miniatura, acciones debajo (40 px con puntero grueso:
 * cuatro acciones no caben a 44 en una celda de 165 px a 375 px). La
 * reordenacion sigue siendo HTML5 drag and drop (logica intacta) con las
 * flechas como alternativa sin arrastre; la celda destino se marca con
 * anillo y escala, la arrastrada se atenua.
 */
function PageThumbnailGridInner({
  files,
  selectable = false,
  rotatable = false,
  removable = false,
  reorderable = false,
  onItemsChange,
  onError,
  className,
}: PageThumbnailGridProps) {
  const t = useT();
  const [items, setItems] = useState<PageRef[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(files.length > 0);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  const changeRef = useRef(onItemsChange);
  const errorRef = useRef(onError);
  const headingRef = useRef<HTMLHeadingElement>(null);
  /* Boton "Quitar" de cada pagina, por id (la lista se reordena). */
  const removeButtonsRef = useRef(new Map<string, HTMLButtonElement>());
  /*
   * Pagina que se esta quitando: su posicion (para saber a que boton pasar el
   * foco) y su id (para saber cuando el quitado ya esta confirmado).
   */
  const pendingFocusRef = useRef<{ index: number; id: string } | null>(null);

  useEffect(() => {
    changeRef.current = onItemsChange;
    errorRef.current = onError;
  });

  useEffect(() => {
    let cancelled = false;
    if (files.length === 0) return;

    void (async () => {
      const built: PageRef[] = [];
      try {
        for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
          const document = await openPdfDocument(files[fileIndex]);
          if (cancelled) {
            void closePdfDocument(document);
            return;
          }

          for (
            let pageNumber = 1;
            pageNumber <= document.numPages;
            pageNumber += 1
          ) {
            built.push({
              id: `${fileIndex}-${pageNumber - 1}`,
              fileIndex,
              pageIndex: pageNumber - 1,
              rotation: 0,
              selected: true,
            });
          }
          if (!cancelled) setItems([...built]);

          for (
            let pageNumber = 1;
            pageNumber <= document.numPages;
            pageNumber += 1
          ) {
            if (cancelled) break;
            const page = await document.getPage(pageNumber);
            const url = await renderPageToDataUrl(page, {
              maxWidth: THUMB_WIDTH,
            });
            page.cleanup();
            if (cancelled) break;
            const id = `${fileIndex}-${pageNumber - 1}`;
            setThumbs((previous) => ({ ...previous, [id]: url }));
          }

          void closePdfDocument(document);
        }
      } catch (error) {
        if (!cancelled) errorRef.current?.(toPdfError(error).code);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [files]);

  useEffect(() => {
    changeRef.current?.(items);
  }, [items]);

  // Tras quitar una pagina, el foco pasa al "Quitar" de la pagina que ocupa
  // ahora esa posicion (o al de la ultima), como hace FileList con los
  // archivos. Si no queda ninguna, la fila de acciones desaparece y el foco
  // va al encabezado de la rejilla: nunca cae a <body>.
  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (pending === null) return;
    // Un efecto de un render anterior (la lista recien cargada) puede
    // ejecutarse tras el clic pero antes de confirmarse el quitado: aun ve
    // la pagina en la lista. Si consumiera el aviso ahora, el foco iria al
    // boton que acaba desapareciendo y caeria a <body>.
    if (items.some((item) => item.id === pending.id)) return;
    pendingFocusRef.current = null;
    const next = items[Math.min(pending.index, items.length - 1)];
    const target =
      (next ? removeButtonsRef.current.get(next.id) : null) ??
      headingRef.current;
    target?.focus();
  }, [items]);

  const update = useCallback(
    (id: string, patch: Partial<PageRef>) => {
      setItems((previous) =>
        previous.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    },
    [],
  );

  const moveTo = useCallback((from: number, to: number) => {
    setItems((previous) => {
      if (from === to || from < 0 || to < 0) return previous;
      if (from >= previous.length || to >= previous.length) return previous;
      const next = [...previous];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);

  const move = useCallback(
    (index: number, offset: number) => moveTo(index, index + offset),
    [moveTo],
  );

  const removeAt = useCallback((id: string, index: number) => {
    pendingFocusRef.current = { index, id };
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  if (files.length === 0) return null;

  const hasActions = reorderable || rotatable || removable;

  return (
    <div className={className}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3
          ref={headingRef}
          tabIndex={-1}
          className="ui-label text-muted-foreground"
        >
          {t.tool.pagesPreview}
        </h3>
        <div className="flex items-center gap-3">
          {reorderable ? (
            <span className="hidden text-caption text-muted-foreground sm:block">
              {t.tool.dragToReorder}
            </span>
          ) : null}
          {loading ? (
            <Spinner className="size-4" label={t.common.loading} />
          ) : null}
        </div>
      </div>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item, index) => {
          const thumb = thumbs[item.id];
          const isOver =
            reorderable && overIndex === index && dragIndex !== index;
          return (
            <li
              key={item.id}
              draggable={reorderable}
              onDragStart={
                reorderable
                  ? (event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", item.id);
                      setDragIndex(index);
                    }
                  : undefined
              }
              onDragOver={
                reorderable
                  ? (event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setOverIndex(index);
                    }
                  : undefined
              }
              onDrop={
                reorderable
                  ? (event) => {
                      event.preventDefault();
                      if (dragIndex !== null) moveTo(dragIndex, index);
                      setDragIndex(null);
                      setOverIndex(null);
                    }
                  : undefined
              }
              onDragEnd={
                reorderable
                  ? () => {
                      setDragIndex(null);
                      setOverIndex(null);
                    }
                  : undefined
              }
              className={cn(
                "surface-card relative rounded-ios-sm p-2",
                "transition-[opacity,scale,box-shadow,border-color] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
                selectable && !item.selected && "opacity-40",
                reorderable && "cursor-grab active:cursor-grabbing",
                reorderable && dragIndex === index && "opacity-40",
                isOver &&
                  "scale-[1.02] border-signal shadow-[0_0_0_2px_var(--color-signal),var(--shadow-elevation-2)]",
              )}
            >
              <button
                type="button"
                disabled={!selectable}
                onClick={() =>
                  selectable && update(item.id, { selected: !item.selected })
                }
                className={cn(
                  "relative block w-full rounded-[10px]",
                  selectable &&
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-signal",
                )}
                aria-pressed={selectable ? item.selected : undefined}
                aria-label={
                  selectable ? `${t.tool.page} ${index + 1}` : undefined
                }
              >
                <span className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-[10px] bg-white/5">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt={`${t.tool.page} ${index + 1}`}
                      className="max-h-full max-w-full object-contain transition-transform duration-[var(--duration-slow)] ease-[var(--ease-spring)]"
                      style={{ transform: `rotate(${item.rotation}deg)` }}
                    />
                  ) : (
                    <Spinner className="size-4" />
                  )}
                </span>
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 left-1.5 flex h-5 min-w-5 items-center justify-center rounded-full bg-background/75 px-1.5 text-caption-2 leading-none font-semibold text-foreground tabular-nums"
                >
                  {index + 1}
                </span>
                {selectable && item.selected ? (
                  <span
                    aria-hidden="true"
                    className="absolute top-1.5 right-1.5 size-3 rounded-full border-2 border-background bg-signal"
                  />
                ) : null}
              </button>

              {hasActions ? (
                <div className="-mx-1 mt-1.5 flex items-center justify-end">
                  {reorderable ? (
                    <>
                      <MiniButton
                        label={t.tool.moveUp}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowLeft aria-hidden="true" className="size-3.5" />
                      </MiniButton>
                      <MiniButton
                        label={t.tool.moveDown}
                        disabled={index === items.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowRight aria-hidden="true" className="size-3.5" />
                      </MiniButton>
                    </>
                  ) : null}
                  {rotatable ? (
                    <MiniButton
                      label={t.tool.rotate}
                      onClick={() =>
                        update(item.id, {
                          rotation: (item.rotation + 90) % 360,
                        })
                      }
                    >
                      <RotateCw aria-hidden="true" className="size-3.5" />
                    </MiniButton>
                  ) : null}
                  {removable ? (
                    <MiniButton
                      label={t.tool.remove}
                      onClick={() => removeAt(item.id, index)}
                      buttonRef={(element) => {
                        if (element) removeButtonsRef.current.set(item.id, element);
                        else removeButtonsRef.current.delete(item.id);
                      }}
                    >
                      <Trash2 aria-hidden="true" className="size-3.5" />
                    </MiniButton>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function MiniButton({
  label,
  disabled,
  onClick,
  children,
  buttonRef,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  buttonRef?: (element: HTMLButtonElement | null) => void;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-8 items-center justify-center rounded-full text-muted-foreground pointer-coarse:size-10",
        "transition-[background-color,color,scale] duration-[var(--duration-fast)] ease-[var(--ease-spring)]",
        "hover:bg-white/10 hover:text-foreground active:scale-90 active:duration-[80ms]",
        "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-signal",
        "disabled:pointer-events-none disabled:opacity-30",
      )}
    >
      {children}
    </button>
  );
}
