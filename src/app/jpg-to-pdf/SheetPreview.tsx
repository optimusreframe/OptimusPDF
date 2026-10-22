"use client";

import { useMemo } from "react";
import { fillCopy } from "@/lib/image/qualityStrings";
import type { ImageProbe } from "@/lib/image/estimatePdfSize";
import { layoutPhotoGrid, type PhotosPerPage, type PhotoSize } from "@/lib/pdf/photoGrid";
import { MARGINS, pageSizeInPoints, type ImageMargin, type ImageOrientation, type ImagePageSize } from "@/lib/pdf/imagesToPdf";
import { cn } from "@/lib/cn";
import type { JpgToPdfStrings } from "@/app/jpg-to-pdf/strings";

/** Hojas que se dibujan como maximo en la vista previa (las demas se cuentan). */
export const PREVIEW_SHEETS = 3;

export type SheetPreviewProps = {
  /** Fotos en el orden final (las que de verdad entran en el PDF). */
  count: number;
  probes: ReadonlyArray<ImageProbe | undefined> | null;
  /** Miniaturas en el mismo orden: `undefined` = pendiente, `null` = sin miniatura. */
  thumbnails: ReadonlyArray<string | null | undefined>;
  perPage: PhotosPerPage;
  pageSize: ImagePageSize;
  orientation: ImageOrientation;
  margin: ImageMargin;
  strings: JpgToPdfStrings;
  className?: string;
};

/**
 * Vista previa ANTES de generar: miniaturas de las primeras hojas con las fotos en su sitio (la misma composicion
 * `layoutPhotoGrid` que usa el motor, asi que lo que se ve es lo que saldra) y «N hojas en total». Usa miniaturas ya
 * hechas, nunca las fotos enteras. Cada hoja lleva su descripcion en texto («Hoja 1: fotos 1 a 4, 2 columnas × 2 filas»).
 */
export function SheetPreview({ count, probes, thumbnails, perPage, pageSize, orientation, margin, strings, className }: SheetPreviewProps) {
  const sheets = useMemo(() => {
    const sizes: PhotoSize[] = Array.from({ length: count }, (_, index) => {
      const header = probes?.[index]?.header;
      return header && header.displayWidth && header.displayHeight
        ? { width: header.displayWidth, height: header.displayHeight }
        : { width: 4, height: 3 };
    });
    return layoutPhotoGrid(sizes, { perPage, pageSize: pageSizeInPoints(pageSize), orientation, margin: MARGINS[margin] });
  }, [count, probes, perPage, pageSize, orientation, margin]);

  if (count === 0 || perPage === 1) return null;
  const shown = sheets.slice(0, PREVIEW_SHEETS);
  const total = sheets.length;

  const describe = (sheetIndex: number): string => {
    const sheet = sheets[sheetIndex];
    const first = sheet.firstPhoto + 1;
    const last = sheet.firstPhoto + sheet.photoCount;
    const cols = sheet.cols === 1 ? strings.columnOne : fillCopy(strings.columnMany, { n: sheet.cols });
    const rows = sheet.rows === 1 ? strings.rowOne : fillCopy(strings.rowMany, { n: sheet.rows });
    return fillCopy(first === last ? strings.sheetCaptionOne : strings.sheetCaption, { n: sheetIndex + 1, from: first, to: last, cols, rows });
  };

  return (
    <section className={className} aria-labelledby="sheet-preview-title" data-sheet-preview="">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h3 id="sheet-preview-title" className="ui-label text-muted-foreground">
          {strings.sheetsTitle}
        </h3>
      </div>
      <p className="mb-3 text-xs text-muted-foreground" data-sheet-total="">
        {total === 1 ? strings.sheetsTotalOne : fillCopy(strings.sheetsTotalMany, { n: total })}
        {total > shown.length ? ` ${fillCopy(strings.sheetsShown, { shown: shown.length })}` : ""}
      </p>
      <ol className="grid grid-cols-2 gap-4 sm:grid-cols-3" data-sheet-list="">
        {shown.map((sheet, sheetIndex) => (
          <li key={sheet.firstPhoto}>
            <figure className="m-0">
              <div
                className="relative w-full overflow-hidden rounded-[4px] border border-hairline bg-white shadow-sm"
                style={{ aspectRatio: `${sheet.pageWidth} / ${sheet.pageHeight}` }}
                data-sheet=""
                data-sheet-index={sheetIndex}
              >
                {sheet.photos.map((placed) => {
                  const url = thumbnails[placed.index];
                  return (
                    <span
                      key={placed.index}
                      data-sheet-photo={placed.index}
                      className={cn("absolute block overflow-hidden bg-black/10")}
                      style={{
                        left: `${(placed.rect.x / sheet.pageWidth) * 100}%`,
                        top: `${((sheet.pageHeight - placed.rect.y - placed.rect.height) / sheet.pageHeight) * 100}%`,
                        width: `${(placed.rect.width / sheet.pageWidth) * 100}%`,
                        height: `${(placed.rect.height / sheet.pageHeight) * 100}%`,
                      }}
                    >
                      {url ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={url} alt="" decoding="async" className="block size-full object-fill" />
                      ) : null}
                    </span>
                  );
                })}
              </div>
              <figcaption className="mt-1.5 text-caption leading-snug text-muted-foreground">{describe(sheetIndex)}</figcaption>
            </figure>
          </li>
        ))}
      </ol>
    </section>
  );
}
