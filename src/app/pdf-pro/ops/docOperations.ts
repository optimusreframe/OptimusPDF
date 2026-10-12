import { addHeaderFooter, type HeaderFooterOptions } from "@/lib/pdf/headerFooter";
import { addPageNumbers } from "@/lib/pdf/pageNumbers";
import { addWatermark, type WatermarkOptions } from "@/lib/pdf/watermark";
import { compressPdf, DEFAULT_COMPRESS_OPTIONS, type CompressOptions } from "@/lib/pdf/compress";
import { cropPdf, cropTargets, type CropScope } from "@/lib/pdf/crop";
import { getPageGeometry, loadPdf, toPdfError } from "@/lib/pdf/core";
import { readMetadata, stripMetadata, writeMetadata, type PdfMetadataInfo } from "@/lib/pdf/metadata";
import { DEFAULT_OCR_OPTIONS, ocrPdf, type OcrOptions } from "@/lib/pdf/ocr";
import { repairPdf, type RepairReport } from "@/lib/pdf/repair";
import { rotatePdf } from "@/lib/pdf/rotate";
import { removeProtection, type UnlockOptions } from "@/lib/pdf/unlock";
import type { PageNumbersToolOptions } from "@/app/add-page-numbers/PageNumbersOptionsPanel";
import { rotateAllPlan, rotateRangePlan } from "@/app/rotate-pdf/rotatePlan";
import {
  marginsToRect,
  pointsToMm,
  sanitizeMargins,
  type CropMargins,
  type PageMm,
} from "@/app/pdf-pro/ops/cropMath";
import { hasPatch, patchFromForm, type MetadataFormFields } from "@/app/pdf-pro/ops/metadataForm";
import { asPdfFile, blobToBytes, sameBytes } from "@/app/pdf-pro/ops/opUtils";
import type { ProOperation, ProOperationResult } from "@/app/pdf-pro/proTypes";

/**
 * Operaciones de documento completo de PDF Pro (Wave 7 · U5). Cada una es un `ProOperation` que envuelve
 * EL MISMO motor y las MISMAS opciones que la herramienta suelta (marca de agua, numerar, comprimir,
 * recortar, rotar, reparar, OCR, desbloquear) o un motor nuevo (metadatos, encabezado y pie), de modo
 * que, con las mismas opciones, la salida es identica byte a byte (`proEquivalence.test.tsx`).
 *
 * Reglas comunes: ninguna conserva la entrada si el resultado no cambia nada (`unchanged`: sin snapshot).
 * Todas conservan el numero de paginas salvo `repair` (informa cuantas recupero).
 */

/* ------------------------------------------------------------------ *
 * Marca de agua, numerar, encabezado y pie
 * ------------------------------------------------------------------ */

export const watermarkOperation: ProOperation<WatermarkOptions> = {
  id: "watermark",
  labelKey: "watermark",
  kind: "document",
  preservesPageCount: true,
  async run(bytes, options, ctx): Promise<ProOperationResult> {
    return { bytes: await blobToBytes(await addWatermark(asPdfFile(bytes), options, ctx.onProgress)) };
  },
};

export const pageNumbersOperation: ProOperation<PageNumbersToolOptions> = {
  id: "page-numbers",
  labelKey: "pageNumbers",
  kind: "document",
  preservesPageCount: true,
  async run(bytes, options, ctx): Promise<ProOperationResult> {
    // `preset` solo lo usa la interfaz (igual que en la herramienta suelta): el motor lo ignora.
    return { bytes: await blobToBytes(await addPageNumbers(asPdfFile(bytes), options, ctx.onProgress)) };
  },
};

export const headerFooterOperation: ProOperation<HeaderFooterOptions> = {
  id: "header-footer",
  labelKey: "headerFooter",
  kind: "document",
  preservesPageCount: true,
  async run(bytes, options, ctx): Promise<ProOperationResult> {
    return { bytes: await blobToBytes(await addHeaderFooter(asPdfFile(bytes), options, ctx.onProgress)) };
  },
};

/* ------------------------------------------------------------------ *
 * Comprimir
 * ------------------------------------------------------------------ */

/** Lo que `compress` informa: pesos MEDIDOS sobre los archivos reales. */
export type ProCompressReport = {
  originalSize: number;
  compressedSize: number;
  alreadyOptimized: boolean;
  mode: CompressOptions["mode"];
};

export const compressOperation: ProOperation<CompressOptions | undefined> = {
  id: "compress",
  labelKey: "compress",
  kind: "document",
  preservesPageCount: true,
  async run(bytes, options, ctx): Promise<ProOperationResult> {
    const effective = options ?? DEFAULT_COMPRESS_OPTIONS;
    const result = await compressPdf(asPdfFile(bytes), effective, ctx.onProgress, ctx.signal);
    const report: ProCompressReport = {
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      alreadyOptimized: result.alreadyOptimized,
      mode: effective.mode,
    };
    if (result.alreadyOptimized) {
      return { bytes, pageCount: result.pages, warnings: [{ code: "unchanged" }], report };
    }
    return { bytes: await blobToBytes(result.blob), pageCount: result.pages, report };
  },
};

/* ------------------------------------------------------------------ *
 * Recortar
 * ------------------------------------------------------------------ */

export type ProCropOptions = {
  /** Margenes que se QUITAN, en mm, respecto a la pagina de referencia. */
  margins: CropMargins;
  /** «Igual en todas»: el panel mantiene los cuatro lados iguales (solo interfaz). */
  linked: boolean;
  scope: Extract<CropScope, "all" | "range">;
  fromPage: number;
  toPage: number;
};

export const DEFAULT_PRO_CROP_OPTIONS: ProCropOptions = {
  margins: { top: 10, right: 10, bottom: 10, left: 10 },
  linked: true,
  scope: "all",
  fromPage: 1,
  toPage: 0,
};

/** Tamano VISIBLE (mm) de la primera pagina que se recorta: la referencia de los margenes. */
export async function referencePageMm(bytes: Uint8Array, options: Pick<ProCropOptions, "scope" | "fromPage" | "toPage">): Promise<PageMm> {
  try {
    const document = await loadPdf(bytes);
    const pages = document.getPages();
    const targets = cropTargets(
      {
        rect: { x: 0, y: 0, width: 1, height: 1 },
        scope: options.scope,
        pageIndex: 0,
        fromPage: options.fromPage,
        toPage: options.toPage,
      },
      pages.length,
    );
    const geometry = getPageGeometry(pages[targets[0] ?? 0]);
    return { width: pointsToMm(geometry.viewWidth), height: pointsToMm(geometry.viewHeight) };
  } catch (error) {
    throw toPdfError(error);
  }
}

export const cropOperation: ProOperation<ProCropOptions> = {
  id: "crop",
  labelKey: "crop",
  kind: "document",
  preservesPageCount: true,
  async run(bytes, options, ctx): Promise<ProOperationResult> {
    const page = await referencePageMm(bytes, options);
    const rect = marginsToRect(sanitizeMargins(options.margins), page);
    ctx.onProgress(0.1);
    const blob = await cropPdf(
      asPdfFile(bytes),
      { rect, scope: options.scope, pageIndex: 0, fromPage: options.fromPage, toPage: options.toPage },
      (value) => ctx.onProgress(0.1 + value * 0.9),
    );
    return { bytes: await blobToBytes(blob) };
  },
};

/* ------------------------------------------------------------------ *
 * Rotar (todo / rango)
 * ------------------------------------------------------------------ */

export type ProRotateOptions = {
  angle: number;
  scope: "all" | "range";
  fromPage: number;
  toPage: number;
  parity: "all" | "odd" | "even";
};

export const DEFAULT_PRO_ROTATE_OPTIONS: ProRotateOptions = {
  angle: 90,
  scope: "all",
  fromPage: 1,
  toPage: 0,
  parity: "all",
};

export const rotateOperation: ProOperation<ProRotateOptions> = {
  id: "rotate",
  labelKey: "rotate",
  kind: "document",
  preservesPageCount: true,
  async run(bytes, options, ctx): Promise<ProOperationResult> {
    let plan;
    if (options.scope === "all") {
      plan = rotateAllPlan(options.angle);
    } else {
      const document = await loadPdf(bytes);
      plan = rotateRangePlan(options, document.getPageCount());
    }
    return { bytes: await blobToBytes(await rotatePdf(asPdfFile(bytes), plan, ctx.onProgress)) };
  },
};

/* ------------------------------------------------------------------ *
 * Reparar y OCR
 * ------------------------------------------------------------------ */

export const repairOperation: ProOperation<undefined> = {
  id: "repair",
  labelKey: "repair",
  kind: "document",
  async run(bytes, _options, ctx): Promise<ProOperationResult> {
    const outcome = await repairPdf(asPdfFile(bytes), {}, ctx.onProgress, ctx.signal);
    const report: RepairReport = outcome.report;
    const out = await blobToBytes(outcome.blob);
    // Sin danos ni acciones el motor devuelve los mismos bytes: no hay snapshot que crear.
    if (report.damage.length === 0 && report.actions.length === 0 && sameBytes(out, bytes)) {
      return { bytes, pageCount: report.pagesRecovered, warnings: [{ code: "unchanged" }], report };
    }
    return { bytes: out, pageCount: report.pagesRecovered, report };
  },
};

export const ocrOperation: ProOperation<OcrOptions | undefined> = {
  id: "ocr",
  labelKey: "ocr",
  kind: "document",
  preservesPageCount: true,
  async run(bytes, options, ctx): Promise<ProOperationResult> {
    // La guarda de 20 s y el error claro sin red viven en `ocr.ts` (`createOcrWorker`, Wave 6).
    const blob = await ocrPdf(asPdfFile(bytes), options ?? DEFAULT_OCR_OPTIONS, ctx.onProgress, ctx.signal);
    return { bytes: await blobToBytes(blob) };
  },
};

/* ------------------------------------------------------------------ *
 * Metadatos
 * ------------------------------------------------------------------ */

export type ProMetadataOptions = {
  mode: "set" | "strip";
  /** Valores del formulario; solo se escribe lo que difiere de `original`. */
  form: MetadataFormFields;
  /** Metadatos del snapshot actual (los que se leyeron al abrir el panel). */
  original: PdfMetadataInfo | null;
  keepXmp: boolean;
};

export type ProMetadataReport = { xmpRemoved: boolean; changed: string[]; removedInfoKeys?: number };

export const metadataOperation: ProOperation<ProMetadataOptions> = {
  id: "metadata",
  labelKey: "metadata",
  kind: "document",
  preservesPageCount: true,
  async run(bytes, options, ctx): Promise<ProOperationResult> {
    if (options.mode === "strip") {
      const result = await stripMetadata(bytes);
      ctx.onProgress(1);
      const report: ProMetadataReport = {
        xmpRemoved: result.xmpRemoved,
        changed: [],
        removedInfoKeys: result.removedInfoKeys,
      };
      if (result.removedInfoKeys === 0 && !result.xmpRemoved) {
        return { bytes, warnings: [{ code: "unchanged" }], report };
      }
      return { bytes: result.bytes, report };
    }
    const original = options.original ?? (await readMetadata(bytes));
    ctx.onProgress(0.3);
    const patch = patchFromForm(options.form, original);
    if (!hasPatch(patch)) {
      return { bytes, warnings: [{ code: "unchanged" }], report: { xmpRemoved: false, changed: [] } satisfies ProMetadataReport };
    }
    const result = await writeMetadata(bytes, patch, { xmp: options.keepXmp ? "keep" : "remove" });
    ctx.onProgress(1);
    const report: ProMetadataReport = { xmpRemoved: result.xmpRemoved, changed: result.changed };
    if (result.changed.length === 0) return { bytes, warnings: [{ code: "unchanged" }], report };
    return { bytes: result.bytes, report };
  },
};

/* ------------------------------------------------------------------ *
 * Quitar restricciones de firma
 * ------------------------------------------------------------------ */

/** `UnlockOptions` + lo que el panel averiguo del documento (solo interfaz: el motor lo ignora). */
export type ProUnlockOptions = UnlockOptions & { inspected: "pending" | "none" | "restricted" | "failed" };

export const unlockOperation: ProOperation<ProUnlockOptions> = {
  id: "unlock",
  labelKey: "unlock",
  kind: "document",
  preservesPageCount: true,
  async run(bytes, options, ctx): Promise<ProOperationResult> {
    // El documento de trabajo ya esta sin cifrar: aqui solo se retiran restricciones de firma (con consentimiento).
    const result = await removeProtection(
      asPdfFile(bytes),
      { password: "", acknowledgeSignatureInvalidation: options.acknowledgeSignatureInvalidation },
      ctx.onProgress,
    );
    return { bytes: await blobToBytes(result.blob), report: { action: result.action } };
  },
};

/** Operaciones de documento de esta unidad, en el orden en que se ofrecen. */
export const DOCUMENT_OPERATIONS: readonly ProOperation<unknown>[] = [
  watermarkOperation as ProOperation<unknown>,
  pageNumbersOperation as ProOperation<unknown>,
  headerFooterOperation as ProOperation<unknown>,
  cropOperation as ProOperation<unknown>,
  rotateOperation as ProOperation<unknown>,
  metadataOperation as ProOperation<unknown>,
  repairOperation as ProOperation<unknown>,
  ocrOperation as ProOperation<unknown>,
  unlockOperation as ProOperation<unknown>,
];
