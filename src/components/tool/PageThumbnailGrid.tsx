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

  const changeRef = useRef(onItemsChange);
  const errorRef = useRef(onError);

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

  const update = useCallback(
    (id: string, patch: Partial<PageRef>) => {
      setItems((previous) =>
        previous.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      );
    },
    [],
  );

  const move = useCallback((index: number, offset: number) => {
    setItems((previous) => {
      const target = index + offset;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item);
      return next;
    });
  }, []);

  const removeAt = useCallback((id: string) => {
    setItems((previous) => previous.filter((item) => item.id !== id));
  }, []);

  if (files.length === 0) return null;

  return (
    <div className={className}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="hud-label text-[11px] text-muted-foreground">
          {t.tool.pagesPreview}
        </h3>
        {loading ? <Spinner className="size-4" /> : null}
      </div>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((item, index) => {
          const thumb = thumbs[item.id];
          return (
            <li
              key={item.id}
              className={cn(
                "glass rounded-ios-sm group relative overflow-hidden p-2 transition-all duration-200 ease-spring",
                selectable && !item.selected && "opacity-40",
              )}
            >
              <button
                type="button"
                disabled={!selectable}
                onClick={() =>
                  selectable && update(item.id, { selected: !item.selected })
                }
                className="block w-full"
                aria-pressed={selectable ? item.selected : undefined}
              >
                <span className="flex aspect-[3/4] w-full items-center justify-center overflow-hidden rounded-[10px] bg-white/5">
                  {thumb ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={thumb}
                      alt={`${t.tool.page} ${index + 1}`}
                      className="max-h-full max-w-full object-contain transition-transform duration-300 ease-spring"
                      style={{ transform: `rotate(${item.rotation}deg)` }}
                    />
                  ) : (
                    <Spinner className="size-4" />
                  )}
                </span>
              </button>

              <div className="mt-2 flex items-center justify-between gap-1">
                <span className="hud-label text-[9px] text-muted-foreground">
                  {index + 1}
                </span>
                <div className="flex items-center gap-0.5">
                  {reorderable ? (
                    <>
                      <MiniButton
                        label={t.tool.moveUp}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowLeft aria-hidden="true" className="size-3" />
                      </MiniButton>
                      <MiniButton
                        label={t.tool.moveDown}
                        disabled={index === items.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowRight aria-hidden="true" className="size-3" />
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
                      <RotateCw aria-hidden="true" className="size-3" />
                    </MiniButton>
                  ) : null}
                  {removable ? (
                    <MiniButton
                      label={t.tool.remove}
                      onClick={() => removeAt(item.id)}
                    >
                      <Trash2 aria-hidden="true" className="size-3" />
                    </MiniButton>
                  ) : null}
                </div>
              </div>
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
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/12 hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
    >
      {children}
    </button>
  );
}
