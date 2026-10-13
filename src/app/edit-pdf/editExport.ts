import { splitForExport, type EditSession } from "@/app/edit-pdf/editSession";
import type { EditFlowStrings } from "@/app/edit-pdf/flowStrings";
import type { SignatureState } from "@/app/edit-pdf/editPrepare";
import {
  PdfError,
  readFileBytes,
  scaleProgress,
  throwIfAborted,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { applyEdits, groupElementsByPage } from "@/lib/pdf/editPdf";
import {
  applyTextEdits,
  flattenPages,
  type ApplyTextEditsOptions,
  type FlattenOptions,
} from "@/lib/pdf/editTextExport";
import type { EditWarning, TextEdit } from "@/lib/pdf/editTypes";

/**
 * Exportacion del editor (Wave 5 · U5): une los tres motores en el orden que
 * hace correcto el resultado —texto (cubrir y redibujar), luego imagenes y
 * formas, y por ULTIMO aplanar— y devuelve tambien lo que hay que contarle a la
 * persona (cuentas y avisos).
 *
 * Aplanar va al final a proposito: asi lo anadido (imagenes, formas, texto
 * nuevo) queda DENTRO de la imagen de la pagina y el texto original deja de
 * existir en ella.
 */

export type ExportCounts = {
  /** Textos que reemplazan un bloque del PDF. */
  editedTexts: number;
  /** Textos nuevos (con contenido). */
  addedTexts: number;
  images: number;
  shapes: number;
  flattenedPages: number;
};

/** Avisos de la exportacion, contados por TEXTO afectado. */
export type ExportWarningCounts = {
  fontSubstituted: number;
  glyphMissing: number;
  originalRemains: number;
  /** (Wave 8 · F2) Textos cuyo original se elimino de verdad del PDF. */
  originalRemoved: number;
  backgroundNotUniform: number;
  /** (W5-U5) Textos cuyo dibujo invade a otro bloque de texto (`overlap`). */
  overlap: number;
  /** (W5-U5 · N4) Bloques con estilos mezclados que la edicion unifica (el editor lo avisa en «Más»). */
  mixedStyle: number;
  /** (W5-U5) Textos girados cuya cobertura cruza a un vecino: parte del original queda visible. */
  coverOverlaps: number;
  /** (W5-U5) Lo que aplanar descarto de TODO el documento (`flatten-drops-forms`), o `null`. */
  flattenDrops: { forms: boolean; outlines: boolean } | null;
  /** Cambios que el motor no pudo aplicar. */
  skipped: number;
};

export type EditExportOptions = {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
  /** Inyectables (pruebas en Node): fuentes del catalogo y rasterizador de paginas. */
  textOptions?: Pick<ApplyTextEditsOptions, "loadFontBytes" | "loadFontkit">;
  createRasterizer?: FlattenOptions["createRasterizer"];
};

export type EditExportResult = {
  blob: Blob;
  counts: ExportCounts;
  warnings: ExportWarningCounts;
};

export function countsOf(split: ReturnType<typeof splitForExport>): ExportCounts {
  let editedTexts = 0;
  let addedTexts = 0;
  for (const edit of split.textEdits) {
    if (edit.blockId !== undefined) editedTexts += 1;
    else if (edit.text.trim().length > 0) addedTexts += 1;
  }
  let images = 0;
  let shapes = 0;
  for (const element of split.elements) {
    if (element.type === "image") images += 1;
    else shapes += 1;
  }
  return { editedTexts, addedTexts, images, shapes, flattenedPages: split.flattenPages.length };
}

/**
 * Cuenta los avisos por texto. «El texto original sigue ahi» no se cuenta para
 * las ediciones de una pagina que se aplana: el aplanado lo elimina.
 */
export function countWarnings(
  warningsByEdit: Record<string, EditWarning[]>,
  skipped: number,
  edits: readonly TextEdit[] = [],
  flattened: readonly number[] = [],
): ExportWarningCounts {
  const pageOf = new Map(edits.map((edit) => [edit.id, edit.pageIndex]));
  const flat = new Set(flattened);
  const result: ExportWarningCounts = {
    fontSubstituted: 0,
    glyphMissing: 0,
    originalRemains: 0,
    originalRemoved: 0,
    backgroundNotUniform: 0,
    overlap: 0,
    mixedStyle: 0,
    coverOverlaps: 0,
    flattenDrops: null,
    skipped,
  };
  // Lo decide la edicion (no el motor): el editor lo avisa desde el bloque y aqui se cuenta igual.
  for (const edit of edits) {
    if (edit.blockId !== undefined && edit.mixedStyle === true) result.mixedStyle += 1;
  }
  for (const [id, list] of Object.entries(warningsByEdit)) {
    const kinds = new Set(list.map((warning) => warning.kind));
    const page = pageOf.get(id);
    if (kinds.has("font-substituted")) result.fontSubstituted += 1;
    if (kinds.has("glyph-missing")) result.glyphMissing += 1;
    if (kinds.has("original-text-remains") && !(page !== undefined && flat.has(page))) {
      result.originalRemains += 1;
    }
    if (kinds.has("original-text-removed")) result.originalRemoved += 1;
    if (kinds.has("background-not-uniform")) result.backgroundNotUniform += 1;
    if (kinds.has("overlap")) result.overlap += 1;
    if (kinds.has("cover-overlaps-neighbor")) result.coverOverlaps += 1;
  }
  return result;
}

/**
 * Aplica TODA la sesion sobre el PDF de trabajo. Lanza `PdfError`
 * (`nothingSelected` sin cambios, `cancelled` si `signal` se aborta...).
 */
export async function exportEditedPdf(
  file: File,
  session: EditSession,
  options: EditExportOptions = {},
): Promise<EditExportResult> {
  const split = splitForExport(session);
  const counts = countsOf(split);
  const hasText = split.textEdits.length > 0;
  const hasElements = split.elements.length > 0;
  const hasFlatten = split.flattenPages.length > 0;
  if (!hasText && !hasElements && !hasFlatten) {
    throw new PdfError("nothingSelected", "edit:noElements");
  }

  // Reparto del progreso: aplanar rasteriza y pesa mucho mas que dibujar.
  const weights = {
    text: hasText ? 3 : 0,
    elements: hasElements ? 2 : 0,
    flatten: hasFlatten ? 5 : 0,
  };
  const total = weights.text + weights.elements + weights.flatten;
  const text0 = 0;
  const text1 = weights.text / total;
  const el1 = text1 + weights.elements / total;
  const report = options.onProgress;

  throwIfAborted(options.signal);
  let bytes = await readFileBytes(file);
  let warningsByEdit: Record<string, EditWarning[]> = {};
  let skipped = 0;

  if (hasText) {
    const result = await applyTextEdits(bytes, split.textEdits, {
      signal: options.signal,
      onProgress: report ? (value) => report(scaleProgress(value, text0, text1)) : undefined,
      ...options.textOptions,
    });
    bytes = result.bytes;
    warningsByEdit = result.warningsByEdit;
    skipped = result.skipped.length;
  }

  if (hasElements) {
    const blob = await applyEdits(
      new File([bytes as BlobPart], file.name, { type: "application/pdf" }),
      groupElementsByPage(split.elements),
      report ? (value) => report(scaleProgress(value, text1, el1)) : undefined,
      options.signal,
    );
    bytes = new Uint8Array(await blob.arrayBuffer());
  }

  let flattenDrops: ExportWarningCounts["flattenDrops"] = null;
  if (hasFlatten) {
    bytes = await flattenPages(bytes, split.flattenPages, {
      signal: options.signal,
      onWarnings: (list) => {
        for (const warning of list) {
          if (warning.kind === "flatten-drops-forms") {
            flattenDrops = { forms: warning.forms, outlines: warning.outlines };
          }
        }
      },
      onProgress: report ? (value) => report(scaleProgress(value, el1, 1)) : undefined,
      createRasterizer: options.createRasterizer,
    });
  }

  report?.(1);
  return {
    blob: new Blob([bytes as BlobPart], { type: "application/pdf" }),
    counts,
    warnings: { ...countWarnings(warningsByEdit, skipped, split.textEdits, split.flattenPages), flattenDrops },
  };
}

/* ------------------------------------------------------------------ *
 * Texto para la pantalla de descarga
 * ------------------------------------------------------------------ */

/** «3 textos editados, 1 imagen añadida, 1 página aplanada.» (solo lo que hubo). */
export function summarizeCounts(counts: ExportCounts, f: EditFlowStrings): string {
  const parts: string[] = [];
  if (counts.editedTexts > 0) parts.push(f.summaryEditedTexts(counts.editedTexts));
  if (counts.addedTexts > 0) parts.push(f.summaryAddedTexts(counts.addedTexts));
  if (counts.images > 0) parts.push(f.summaryImages(counts.images));
  if (counts.shapes > 0) parts.push(f.summaryShapes(counts.shapes));
  if (counts.flattenedPages > 0) parts.push(f.summaryFlattened(counts.flattenedPages));
  return parts.length > 0 ? `${parts.join(", ")}.` : "";
}

/**
 * Lista de avisos de la exportacion, en lenguaje llano y sin repetir. Incluye
 * los que no vienen del motor de texto: firmas invalidadas, contrasena que no se
 * conserva y paginas aplanadas.
 */
export function exportNotices(
  warnings: ExportWarningCounts,
  context: {
    signatures: SignatureState;
    wasEncrypted: boolean;
    flattenedPages: number;
  },
  f: EditFlowStrings,
): string[] {
  const list: string[] = [];
  const remains = warnings.originalRemains;
  if (warnings.fontSubstituted > 0) list.push(f.noticeFont(warnings.fontSubstituted));
  if (warnings.glyphMissing > 0) list.push(f.noticeGlyph(warnings.glyphMissing));
  if (remains > 0) list.push(f.noticeRemains(remains));
  if (warnings.originalRemoved > 0) list.push(f.noticeRemoved(warnings.originalRemoved));
  if (warnings.backgroundNotUniform > 0) list.push(f.noticeBackground(warnings.backgroundNotUniform));
  if (warnings.mixedStyle > 0) list.push(f.noticeMixed(warnings.mixedStyle));
  if (warnings.overlap > 0) list.push(f.noticeOverlap(warnings.overlap));
  if (warnings.coverOverlaps > 0) list.push(f.noticeCoverOverlap(warnings.coverOverlaps));
  if (warnings.skipped > 0) list.push(f.noticeSkipped(warnings.skipped));
  if (context.signatures !== "none") list.push(f.noticeSignatures);
  if (context.wasEncrypted) list.push(f.noticeProtected);
  if (context.flattenedPages > 0) list.push(f.noticeFlattened);
  if (warnings.flattenDrops) list.push(f.noticeFlattenDrops(warnings.flattenDrops.forms, warnings.flattenDrops.outlines));
  return list;
}
