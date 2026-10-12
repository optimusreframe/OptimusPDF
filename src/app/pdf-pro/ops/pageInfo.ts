import { PDFDocument } from "@cantoo/pdf-lib";
import { getPageGeometry, loadPdf } from "@/lib/pdf/core";
import { pointsToMm, type PageMm } from "@/app/pdf-pro/ops/cropMath";

/**
 * Lecturas baratas del snapshot actual para los paneles de herramientas (Wave 7 · U5): medidas de la
 * primera pagina y un PDF de UNA pagina (la primera) sobre el que se genera la vista previa del resultado.
 * Se guardan en una cache de una entrada por id de snapshot: cambiar de panel no vuelve a abrir el PDF.
 */

/** Por encima de este peso no se generan vistas previas (abrir el PDF entero en cada cambio costaria demasiado). */
export const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;

type Entry = { snapshotId: string; size: Promise<PageMm | null>; firstPage: Promise<Uint8Array | null> | null };
let entry: Entry | null = null;

function entryFor(snapshotId: string, bytes: Uint8Array): Entry {
  if (entry && entry.snapshotId === snapshotId) return entry;
  const size = (async (): Promise<PageMm | null> => {
    try {
      const document = await loadPdf(bytes);
      const page = document.getPages()[0];
      if (!page) return null;
      const geometry = getPageGeometry(page);
      return { width: pointsToMm(geometry.viewWidth), height: pointsToMm(geometry.viewHeight) };
    } catch {
      return null;
    }
  })();
  entry = { snapshotId, size, firstPage: null };
  return entry;
}

/** Medidas (mm) de la primera pagina visible, o `null` si no se pudo leer. */
export function readFirstPageMm(snapshotId: string, bytes: Uint8Array): Promise<PageMm | null> {
  return entryFor(snapshotId, bytes).size;
}

/** PDF de una sola pagina con la primera del documento, o `null` si no se pudo o pesa demasiado. */
export function readFirstPagePdf(snapshotId: string, bytes: Uint8Array): Promise<Uint8Array | null> {
  const current = entryFor(snapshotId, bytes);
  if (bytes.byteLength > PREVIEW_MAX_BYTES) return Promise.resolve(null);
  current.firstPage ??= (async () => {
    try {
      const source = await loadPdf(bytes);
      if (source.getPageCount() === 0) return null;
      const target = await PDFDocument.create();
      const [copied] = await target.copyPages(source, [0]);
      target.addPage(copied);
      return await target.save({ useObjectStreams: true });
    } catch {
      return null;
    }
  })();
  return current.firstPage;
}

/** Solo para pruebas. */
export function __resetPageInfoCacheForTests(): void {
  entry = null;
}
