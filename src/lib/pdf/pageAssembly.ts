import {
  PDFDocument,
  PDFNumber,
  PDFPage,
  PDFRef,
  type PDFPageLeaf,
} from "@cantoo/pdf-lib";
import {
  MAX_SAFE_FILE_SIZE,
  PdfError,
  loadPdf,
  readFileBytes,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import type { ImageLayout } from "@/lib/pdf/imagesToPdf";
import { normalizeRotation } from "@/lib/pdf/rotate";
import {
  KEY,
  cloneLeafInPlace,
  collectGarbage,
  collectNamedDests,
  collectPresentWidgets,
  dropPageLabels,
  dropStructureTree,
  fixCopiedLeaf,
  hasStructureTree,
  leafRotation,
  materializeInherited,
  pruneAcroForm,
  pruneLinks,
  pruneNamedDests,
  pruneOpenAction,
  pruneOutline,
  refKey,
  registerNewFields,
  sanitizeLeavesForCopy,
  setLeafRotation,
} from "@/lib/pdf/pageAssemblyStructure";

/**
 * Motor de ensamblado de paginas (Wave 7 · U4): reordenar, rotar, eliminar, duplicar, insertar
 * paginas en blanco, de otro PDF o desde imagenes, en UNA sola pasada. Modulo puro (sin React).
 *
 * ESTRATEGIA «EN SITIO». El documento actual se carga una vez y se edita ahi mismo, en vez de
 * copiar las paginas a un documento nuevo: `copyPages` hacia un documento vacio pierde el titulo,
 * el autor, el formulario (AcroForm) y los marcadores. Concretamente:
 *
 *  - las paginas que se quedan se REUTILIZAN (la misma hoja, el mismo objeto): sus marcadores,
 *    enlaces y widgets siguen apuntando a ellas sin tocar nada;
 *  - `removePage` NO sirve para reordenar (borra el objeto de la pagina del contexto), asi que
 *    el arbol de paginas se reescribe aplanado (`/Kids` en el orden del plan) tras materializar
 *    en cada hoja lo que heredaba (`/Resources`, `/MediaBox`, `/CropBox`, `/Rotate`);
 *  - duplicar clona la hoja (contenido y recursos compartidos, anotaciones propias);
 *  - las paginas de otro PDF (o de imagenes) entran con `copyPages` DESDE el otro documento hacia
 *    este, tras quitarles los enlaces internos y las referencias a su pagina original;
 *  - la rotacion es ADITIVA sobre la que ya trae cada hoja (`/Rotate`);
 *  - despues se repara lo que quedo colgando (marcadores, enlaces, destinos con nombre, formulario,
 *    PDF etiquetado, etiquetas de pagina) y se sueltan los objetos sin referencia, de modo que lo
 *    eliminado no sigue dentro del archivo.
 *
 * Limites declarados: ver `PAGE_ASSEMBLY_LIMITS` y las advertencias (`PageAssemblyWarning`).
 */

export const PAGE_ASSEMBLY_LIMITS = {
  /** Documentos PDF externos distintos en una misma operacion. */
  maxExternalDocuments: 10,
  /** Tamano maximo de cada documento externo o imagen. */
  maxExternalBytes: MAX_SAFE_FILE_SIZE,
  /** Paginas AÑADIDAS (de otro PDF, imagenes, blancas o copias) a partir de las que se avisa. */
  warnAddedPages: 500,
} as const;

/** Tamanos de pagina en blanco habituales (puntos PostScript, vertical). */
export const BLANK_PAGE_SIZES = {
  a4: { width: 595.28, height: 841.89 },
  letter: { width: 612, height: 792 },
} as const;

/* ------------------------------------------------------------------ *
 * Tipos publicos
 * ------------------------------------------------------------------ */

type EntryBase = {
  /** Identificador estable para la interfaz (claves de React, seleccion, arrastre). El motor lo ignora. */
  id?: string;
  /** Grados que se SUMAN a la rotacion de la hoja (multiplos de 90; se normaliza a 0..270). */
  rotation: number;
};

/** Una pagina del documento actual. */
export type ExistingEntry = EntryBase & {
  kind: "existing";
  /** Indice 0-based de la pagina en el documento actual. */
  sourceIndex: number;
  /**
   * Es una COPIA (duplicado): nunca se queda con la hoja original, de modo que los marcadores y
   * enlaces siguen apuntando a la pagina que ya estaba.
   */
  copy?: boolean;
};

/** Una pagina de otro PDF (`externals[sourceId]`). */
export type ExternalEntry = EntryBase & {
  kind: "external";
  sourceId: string;
  sourceIndex: number;
};

/** Una pagina en blanco del tamano indicado (puntos). */
export type BlankEntry = EntryBase & {
  kind: "blank";
  width: number;
  height: number;
};

/** Una pagina nueva con una imagen (`externals[sourceId]` es el archivo de imagen). */
export type ImageEntry = EntryBase & {
  kind: "image";
  sourceId: string;
  layout?: Partial<ImageLayout>;
};

export type PageEntry = ExistingEntry | ExternalEntry | BlankEntry | ImageEntry;

export type ExternalSource = Uint8Array | Blob;

export type PageAssemblyWarningCode =
  /** Marcadores que apuntaban a paginas quitadas y se eliminaron. */
  | "outlinesRemoved"
  /** Enlaces internos que apuntaban a paginas quitadas (o no vienen con las paginas copiadas). */
  | "linksRemoved"
  /** Destinos con nombre que apuntaban a paginas quitadas. */
  | "namedDestinationsRemoved"
  /** Las etiquetas de pagina (i, ii, 1...) ya no coinciden con las paginas y se quitaron. */
  | "pageLabelsRemoved"
  /** El arbol de estructura (PDF etiquetado) se quito al eliminar paginas. */
  | "structureRemoved"
  /** Campos de formulario cuyas paginas se quitaron. */
  | "formFieldsRemoved"
  /** Campos de formulario renombrados por repetir un nombre ya usado. */
  | "fieldsRenamed"
  /** Campos de firma que no se copian a otro documento. */
  | "signatureFieldsRemoved"
  /** Se anaden muchas paginas de golpe (puede tardar). */
  | "largeInsert";

export type PageAssemblyWarning = { code: PageAssemblyWarningCode; count: number };

export type PageAssemblyOptions = {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
  /** Comprobar tras guardar que el archivo tiene exactamente las paginas del plan (por defecto, si). */
  verify?: boolean;
};

export type PageAssemblyResult = {
  bytes: Uint8Array;
  warnings: PageAssemblyWarning[];
  /** Paginas del documento resultante (= longitud del plan). */
  pageCount: number;
};

/* ------------------------------------------------------------------ *
 * Plan: utilidades de lectura
 * ------------------------------------------------------------------ */

/** Plan identidad: todas las paginas, en orden y sin girar. */
export function identityPlan(pageCount: number, makeId?: (index: number) => string): PageEntry[] {
  return Array.from({ length: Math.max(0, pageCount) }, (_, index) => ({
    kind: "existing" as const,
    sourceIndex: index,
    rotation: 0,
    ...(makeId ? { id: makeId(index) } : {}),
  }));
}

/** `true` si el plan deja el documento tal cual (mismas paginas, mismo orden, sin girar). */
export function isIdentityPlan(plan: readonly PageEntry[], pageCount: number): boolean {
  if (plan.length !== pageCount) return false;
  return plan.every(
    (entry, index) =>
      entry.kind === "existing" &&
      entry.sourceIndex === index &&
      normalizeRotation(entry.rotation) === 0 &&
      !entry.copy,
  );
}

/** Paginas que entran de fuera (otro PDF, imagen, blanco o copia). */
export function countAddedPages(plan: readonly PageEntry[]): number {
  const seen = new Set<number>();
  let added = 0;
  for (const entry of plan) {
    if (entry.kind !== "existing") {
      added += 1;
    } else if (entry.copy || seen.has(entry.sourceIndex)) {
      added += 1;
    } else {
      seen.add(entry.sourceIndex);
    }
  }
  return added;
}

/** Identificadores de documentos externos (PDF) usados por el plan, en orden de primer uso. */
export function externalPdfIds(plan: readonly PageEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of plan) {
    if (entry.kind === "external" && !ids.includes(entry.sourceId)) ids.push(entry.sourceId);
  }
  return ids;
}

/** El plan conserva las etiquetas de pagina: las primeras paginas son las originales, en su sitio. */
export function preservesPageLabels(plan: readonly PageEntry[], pageCount: number): boolean {
  const limit = Math.min(plan.length, pageCount);
  for (let index = 0; index < limit; index += 1) {
    const entry = plan[index];
    if (entry.kind !== "existing" || entry.sourceIndex !== index || entry.copy) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Lectura de paginas
 * ------------------------------------------------------------------ */

export type PageInfo = {
  /** Ancho visible (puntos), con la rotacion de la hoja aplicada. */
  width: number;
  /** Alto visible (puntos), con la rotacion de la hoja aplicada. */
  height: number;
  /** `/Rotate` de la hoja (0/90/180/270). */
  rotation: number;
};

/** Tamano visible y rotacion de cada pagina (CropBox si existe, si no MediaBox). */
export async function readPageInfo(source: Uint8Array | Blob): Promise<PageInfo[]> {
  const document = await loadPdf(source);
  return document.getPages().map((page) => {
    const rotation = normalizeRotation(page.getRotation().angle);
    const media = page.getMediaBox();
    const crop = page.getCropBox();
    // El recorte solo vale si cae dentro de la hoja; si no, se ve la hoja entera.
    const box =
      crop.width > 0 &&
      crop.height > 0 &&
      crop.x >= media.x - 0.01 &&
      crop.y >= media.y - 0.01 &&
      crop.x + crop.width <= media.x + media.width + 0.01 &&
      crop.y + crop.height <= media.y + media.height + 0.01
        ? crop
        : media;
    const swap = rotation === 90 || rotation === 270;
    return {
      width: swap ? box.height : box.width,
      height: swap ? box.width : box.height,
      rotation,
    };
  });
}

/** Tamano visible de una entrada (con su rotacion extra), o `null` si no se conoce. */
export function entryVisualSize(
  entry: PageEntry,
  sizeOf: (entry: PageEntry) => { width: number; height: number } | null,
): { width: number; height: number } | null {
  const base = entry.kind === "blank" ? { width: entry.width, height: entry.height } : sizeOf(entry);
  if (!base) return null;
  const extra = normalizeRotation(entry.rotation);
  return extra === 90 || extra === 270 ? { width: base.height, height: base.width } : base;
}

/* ------------------------------------------------------------------ *
 * Motor
 * ------------------------------------------------------------------ */

async function sourceBytes(source: ExternalSource): Promise<Uint8Array> {
  const size = source instanceof Uint8Array ? source.byteLength : source.size;
  if (size > PAGE_ASSEMBLY_LIMITS.maxExternalBytes) throw new PdfError("tooLarge");
  return source instanceof Uint8Array ? source : readFileBytes(source);
}

function validatePlan(
  plan: readonly PageEntry[],
  pageCount: number,
  externals: Readonly<Record<string, ExternalSource>>,
): void {
  const pdfIds = new Set<string>();
  for (const entry of plan) {
    if (!Number.isFinite(entry.rotation)) throw new PdfError("invalidConfig");
    if (entry.kind === "existing") {
      if (!Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0 || entry.sourceIndex >= pageCount) {
        throw new PdfError("invalidConfig");
      }
    } else if (entry.kind === "external") {
      if (!Number.isInteger(entry.sourceIndex) || entry.sourceIndex < 0) throw new PdfError("invalidConfig");
      if (!externals[entry.sourceId]) throw new PdfError("invalidConfig");
      pdfIds.add(entry.sourceId);
    } else if (entry.kind === "image") {
      if (!externals[entry.sourceId]) throw new PdfError("invalidConfig");
    } else if (entry.kind === "blank") {
      if (!(entry.width > 0) || !(entry.height > 0) || !Number.isFinite(entry.width + entry.height)) {
        throw new PdfError("invalidConfig");
      }
    } else {
      throw new PdfError("invalidConfig");
    }
  }
  if (pdfIds.size > PAGE_ASSEMBLY_LIMITS.maxExternalDocuments) throw new PdfError("tooLarge");
}

type Slot = { leaf: PDFPageLeaf; ref: PDFRef; fresh: boolean };

/**
 * Aplica un plan de paginas al documento actual y devuelve el PDF resultante.
 *
 * El plan es la lista FINAL de paginas, en orden: lo que no aparece se elimina (un plan vacio es
 * un error `empty`, nunca «sin cambios»). Cada entrada que no se puede cumplir lanza un error
 * tipado en vez de saltarse en silencio.
 */
export async function applyPageAssembly(
  currentBytes: Uint8Array,
  plan: readonly PageEntry[],
  externals: Readonly<Record<string, ExternalSource>> = {},
  options: PageAssemblyOptions = {},
): Promise<PageAssemblyResult> {
  const { signal, onProgress } = options;
  const warnings = new Map<PageAssemblyWarningCode, number>();
  const warn = (code: PageAssemblyWarningCode, count: number) => {
    if (count > 0) warnings.set(code, (warnings.get(code) ?? 0) + count);
  };

  try {
    throwIfAborted(signal);
    if (plan.length === 0) throw new PdfError("empty");

    const document = await loadPdf(currentBytes);
    const context = document.context;
    const pageCount = document.getPageCount();
    if (pageCount < 1) throw new PdfError("corrupt");
    validatePlan(plan, pageCount, externals);
    onProgress?.(0.08);
    throwIfAborted(signal);

    const added = countAddedPages(plan);
    if (added > PAGE_ASSEMBLY_LIMITS.warnAddedPages) warn("largeInsert", added);

    const originalPages = document.getPages();
    const catalog = document.catalog;

    /* ---------- 1. paginas de otros PDF (una llamada a copyPages por documento) ---------- */
    const externalLeaves = new Map<string, PDFPage>();
    const pdfIds = externalPdfIds(plan);
    let externalUsed = false;
    for (let sourceNumber = 0; sourceNumber < pdfIds.length; sourceNumber += 1) {
      throwIfAborted(signal);
      const sourceId = pdfIds[sourceNumber];
      const bytes = await sourceBytes(externals[sourceId]);
      throwIfAborted(signal);
      const sourceDocument = await loadPdf(bytes);
      const sourceCount = sourceDocument.getPageCount();
      const indices: number[] = [];
      for (const entry of plan) {
        if (entry.kind !== "external" || entry.sourceId !== sourceId) continue;
        if (entry.sourceIndex >= sourceCount) throw new PdfError("invalidConfig");
        if (!indices.includes(entry.sourceIndex)) indices.push(entry.sourceIndex);
      }
      const sourcePages = sourceDocument.getPages();
      for (const index of indices) materializeInherited(sourcePages[index].node);
      const cleaned = sanitizeLeavesForCopy(
        sourceDocument.context,
        sourceDocument.catalog,
        indices.map((index) => sourcePages[index].node),
      );
      warn("linksRemoved", cleaned.linksRemoved);
      warn("signatureFieldsRemoved", cleaned.signaturesRemoved);
      const copied = await document.copyPages(sourceDocument, indices);
      copied.forEach((page, position) => {
        fixCopiedLeaf(context, page.node, page.ref);
        externalLeaves.set(`${sourceId}:${indices[position]}`, page);
      });
      externalUsed = true;
      onProgress?.(0.08 + ((sourceNumber + 1) / Math.max(1, pdfIds.length)) * 0.3);
    }

    /* ---------- 2. paginas desde imagenes ---------- */
    const imageEntries = plan.filter((entry): entry is ImageEntry => entry.kind === "image");
    const imageLeaves = new Map<ImageEntry, PDFPage>();
    if (imageEntries.length > 0) {
      const { buildPdfFromImages, DEFAULT_IMAGE_LAYOUT } = await import("@/lib/pdf/imagesToPdf");
      for (let index = 0; index < imageEntries.length; index += 1) {
        throwIfAborted(signal);
        const entry = imageEntries[index];
        const raw = externals[entry.sourceId];
        const size = raw instanceof Uint8Array ? raw.byteLength : raw.size;
        if (size > PAGE_ASSEMBLY_LIMITS.maxExternalBytes) throw new PdfError("tooLarge");
        const blob = raw instanceof Uint8Array ? new Blob([raw as unknown as BlobPart]) : raw;
        const imageDocument = await buildPdfFromImages([blob], { ...DEFAULT_IMAGE_LAYOUT, ...entry.layout });
        const [page] = await document.copyPages(imageDocument, [0]);
        imageLeaves.set(entry, page);
        onProgress?.(0.38 + ((index + 1) / imageEntries.length) * 0.12);
      }
    }
    throwIfAborted(signal);

    /* ---------- 3. una hoja por entrada del plan ---------- */
    const usedOriginals = new Set<number>();
    for (const entry of plan) if (entry.kind === "existing") usedOriginals.add(entry.sourceIndex);
    for (const index of usedOriginals) materializeInherited(originalPages[index].node);

    // La hoja ORIGINAL la reclama la primera entrada que no es copia (si todas lo son, la primera).
    const claimant = new Map<number, PageEntry>();
    for (const entry of plan) {
      if (entry.kind !== "existing" || entry.copy) continue;
      if (!claimant.has(entry.sourceIndex)) claimant.set(entry.sourceIndex, entry);
    }
    for (const entry of plan) {
      if (entry.kind === "existing" && !claimant.has(entry.sourceIndex)) claimant.set(entry.sourceIndex, entry);
    }

    const externalClaimed = new Set<string>();
    const slots: Slot[] = [];
    for (const entry of plan) {
      if (entry.kind === "existing") {
        const page = originalPages[entry.sourceIndex];
        if (claimant.get(entry.sourceIndex) === entry) {
          slots.push({ leaf: page.node, ref: page.ref, fresh: false });
        } else {
          slots.push({ ...cloneLeafInPlace(context, page.node), fresh: true });
        }
      } else if (entry.kind === "external") {
        const key = `${entry.sourceId}:${entry.sourceIndex}`;
        const page = externalLeaves.get(key);
        if (!page) throw new PdfError("unknown");
        if (!externalClaimed.has(key)) {
          externalClaimed.add(key);
          slots.push({ leaf: page.node, ref: page.ref, fresh: true });
        } else {
          slots.push({ ...cloneLeafInPlace(context, page.node), fresh: true });
        }
      } else if (entry.kind === "image") {
        const page = imageLeaves.get(entry);
        if (!page) throw new PdfError("unknown");
        slots.push({ leaf: page.node, ref: page.ref, fresh: true });
      } else {
        const page = PDFPage.create(document);
        page.setSize(entry.width, entry.height);
        slots.push({ leaf: page.node, ref: page.ref, fresh: true });
      }
    }

    /* ---------- 4. rotacion ADITIVA ---------- */
    slots.forEach((slot, index) => {
      const extra = normalizeRotation(plan[index].rotation);
      if (extra !== 0) setLeafRotation(slot.leaf, normalizeRotation(leafRotation(slot.leaf) + extra));
    });
    onProgress?.(0.6);

    /* ---------- 5. arbol de paginas aplanado, en el orden del plan ---------- */
    const pagesRoot = catalog.Pages();
    const rootRef = catalog.get(KEY.Pages);
    if (!(rootRef instanceof PDFRef)) throw new PdfError("corrupt");
    const kids = context.obj(slots.map((slot) => slot.ref));
    pagesRoot.set(KEY.Kids, kids);
    pagesRoot.set(KEY.Count, PDFNumber.of(slots.length));
    for (const slot of slots) slot.leaf.set(KEY.Parent, rootRef);

    /* ---------- 6. reparar lo que quedo colgando ---------- */
    const finalLeaves = slots.map((slot) => slot.leaf);
    const live = new Set(slots.map((slot) => refKey(slot.ref)));
    const deletedAny = usedOriginals.size < pageCount;
    const hadStructure = hasStructureTree(catalog);

    if (deletedAny) {
      const named = collectNamedDests(context, catalog);
      const isLive = (ref: PDFRef) => live.has(refKey(ref));
      const dropStructure = hadStructure;
      warn("outlinesRemoved", pruneOutline(context, catalog, named, isLive, { dropStructure }));
      warn("linksRemoved", pruneLinks(context, finalLeaves, named, isLive));
      pruneOpenAction(context, catalog, named, isLive);
      warn("namedDestinationsRemoved", pruneNamedDests(context, catalog, named, isLive));
      if (dropStructure && dropStructureTree(catalog)) warn("structureRemoved", 1);
    }

    const freshLeaves = slots.filter((slot) => slot.fresh).map((slot) => slot.leaf);
    if (freshLeaves.length > 0) {
      const registered = registerNewFields(context, catalog, freshLeaves);
      warn("fieldsRenamed", registered.renamed);
    }
    if (deletedAny || externalUsed) {
      warn("formFieldsRemoved", pruneAcroForm(context, catalog, collectPresentWidgets(context, finalLeaves)));
    }

    if (!preservesPageLabels(plan, pageCount) && dropPageLabels(catalog)) warn("pageLabelsRemoved", 1);

    if (deletedAny || externalUsed) collectGarbage(context);
    onProgress?.(0.85);
    throwIfAborted(signal);

    /* ---------- 7. guardar y comprobar ---------- */
    const bytes = await document.save({
      useObjectStreams: true,
      addDefaultPage: false,
      // Editar en sitio: no se reescriben las apariencias de los campos del documento.
      updateFieldAppearances: false,
    });
    if (options.verify !== false) {
      const check = await PDFDocument.load(bytes, { updateMetadata: false });
      // Una pagina perdida en silencio es el peor fallo posible: se comprueba contra el plan.
      if (check.getPageCount() !== plan.length) throw new PdfError("unknown", "pageCountMismatch");
    }
    onProgress?.(1);

    return {
      bytes,
      warnings: [...warnings.entries()].map(([code, count]) => ({ code, count })),
      pageCount: plan.length,
    };
  } catch (error) {
    throw toPdfError(error);
  }
}
