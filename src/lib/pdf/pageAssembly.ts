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
import { findDeadPages, neutralizeDeadReferences, resolveMarkedActions } from "@/lib/pdf/pageAssemblyDeadRefs";
import {
  KEY,
  appendOutlineGroup,
  cloneLeafInPlace,
  collectGarbage,
  collectNamedDests,
  collectPresentWidgets,
  countSignedSignatures,
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
  pruneStructureTree,
  readImportableOutline,
  refKey,
  registerNewFields,
  resolveMarkedLinks,
  sanitizeLeavesForCopy,
  setLeafRotation,
  wrapExistingOutline,
  type ImportedOutlineItem,
} from "@/lib/pdf/pageAssemblyStructure";
import {
  EMPTY_LABEL,
  compressLabels,
  defaultLabel,
  labelAt,
  readPageLabels,
  sameRanges,
  writePageLabels,
  type LabelsRead,
  type PageLabel,
} from "@/lib/pdf/pageAssemblyLabels";

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
 *    PDF etiquetado) y se sueltan los objetos sin referencia, de modo que lo eliminado no sigue dentro
 *    del archivo;
 *  - las etiquetas de pagina (`/PageLabels`) se RECALCULAN para el orden nuevo (la etiqueta sigue a la
 *    pagina: ver `pageAssemblyLabels.ts`) y el arbol de estructura de un PDF etiquetado se PODA a las
 *    paginas que quedan; los enlaces internos de las paginas de otro PDF se reapuntan a sus paginas
 *    dentro del resultado.
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

/**
 * Un documento externo: bytes, archivo, o un `PDFDocument` YA cargado (quien lo cargo se ahorra
 * el segundo analisis; el motor no lo modifica salvo por `sanitizeLeavesForCopy` sobre las hojas
 * copiadas, asi que no debe reutilizarse para otra cosa).
 */
export type ExternalSource = Uint8Array | Blob | PDFDocument;

export type PageAssemblyWarningCode =
  /** Marcadores que apuntaban a paginas quitadas y se eliminaron. */
  | "outlinesRemoved"
  /** Enlaces internos que apuntaban a paginas quitadas (o no vienen con las paginas copiadas). */
  | "linksRemoved"
  /** Destinos con nombre que apuntaban a paginas quitadas. */
  | "namedDestinationsRemoved"
  /** No se pudo conservar la numeracion de paginas (i, ii, 1...): `/PageLabels` ilegible, se quito. */
  | "pageLabelsRemoved"
  /** El arbol de estructura (PDF etiquetado) no se pudo podar a las paginas que quedan y se quito. */
  | "structureRemoved"
  /** Paginas copiadas (duplicados o de otro PDF) que no llevan etiquetas de accesibilidad. */
  | "structureIncomplete"
  /** Firmas digitales ya aplicadas que siguen en el documento y dejan de ser validas al reescribirlo. */
  | "signaturesInvalidated"
  /** Campos de formulario cuyas paginas se quitaron. */
  | "formFieldsRemoved"
  /** Campos de formulario renombrados por repetir un nombre ya usado. */
  | "fieldsRenamed"
  /** Campos de firma VACIOS (sin firmar) que no se copian a otro documento. */
  | "signatureFieldsRemoved"
  /** Firmas YA APLICADAS que no se copian a otro documento (su firma no seria valida fuera del original). */
  | "signedSignaturesRemoved"
  /** Se anaden muchas paginas de golpe (puede tardar). */
  | "largeInsert";

export type PageAssemblyWarning = { code: PageAssemblyWarningCode; count: number };

export type PageAssemblyOptions = {
  signal?: AbortSignal;
  onProgress?: ProgressCallback;
  /** Comprobar tras guardar que el archivo tiene exactamente las paginas del plan (por defecto, si). */
  verify?: boolean;
  /** Tope de documentos externos distintos (por defecto `PAGE_ASSEMBLY_LIMITS.maxExternalDocuments`). */
  maxExternalDocuments?: number;
  /**
   * Marcadores de los documentos externos (Wave 8 · Unir): `sourceId` -> titulo del marcador bajo el
   * que se agrupan los marcadores de ese documento que apuntan a paginas copiadas. Sin entrada para
   * un `sourceId`, sus marcadores no se importan (comportamiento de PDF Pro al insertar paginas).
   */
  outlineGroups?: Readonly<Record<string, string>>;
  /**
   * Agrupa los marcadores que YA tenia el documento actual bajo un marcador con este titulo (solo si
   * tiene alguno). Pensado para Unir: cada documento queda bajo su propio marcador.
   */
  wrapOutlineTitle?: string;
};

export type PageAssemblyResult = {
  bytes: Uint8Array;
  warnings: PageAssemblyWarning[];
  /** Paginas del documento resultante (= longitud del plan). */
  pageCount: number;
};

/** Lo que devuelven las herramientas sueltas (Unir, Organizar, Quitar paginas...): el PDF y lo que se perdio. */
export type PageToolResult = {
  blob: Blob;
  warnings: PageAssemblyWarning[];
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

async function loadExternal(source: ExternalSource): Promise<PDFDocument> {
  if (source instanceof PDFDocument) return source;
  const size = source instanceof Uint8Array ? source.byteLength : source.size;
  if (size > PAGE_ASSEMBLY_LIMITS.maxExternalBytes) throw new PdfError("tooLarge");
  return loadPdf(source instanceof Uint8Array ? source : await readFileBytes(source));
}

function validatePlan(
  plan: readonly PageEntry[],
  pageCount: number,
  externals: Readonly<Record<string, ExternalSource>>,
  maxExternalDocuments: number,
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
      if (!externals[entry.sourceId] || externals[entry.sourceId] instanceof PDFDocument) {
        throw new PdfError("invalidConfig");
      }
    } else if (entry.kind === "blank") {
      if (!(entry.width > 0) || !(entry.height > 0) || !Number.isFinite(entry.width + entry.height)) {
        throw new PdfError("invalidConfig");
      }
    } else {
      throw new PdfError("invalidConfig");
    }
  }
  if (pdfIds.size > maxExternalDocuments) throw new PdfError("tooLarge");
}

type Slot = { leaf: PDFPageLeaf; ref: PDFRef; fresh: boolean };

/**
 * Etiqueta de cada pagina del plan (la que mostraba en su documento de origen), o `null` si ningun
 * documento que participa tiene etiquetas (no hay nada que conservar). Los documentos sin etiquetas
 * numeran 1, 2, 3...; las paginas nuevas (en blanco, de imagen) no llevan etiqueta.
 */
function planLabels(
  plan: readonly PageEntry[],
  base: LabelsRead,
  externals: ReadonlyMap<string, { labels: LabelsRead }>,
): PageLabel[] | null {
  const used = externalPdfIds(plan);
  const anyLabels =
    base.kind === "ranges" || used.some((id) => externals.get(id)?.labels.kind === "ranges");
  if (!anyLabels) return null;
  return plan.map((entry) => {
    if (entry.kind === "existing") {
      return base.kind === "ranges" ? labelAt(base.ranges, entry.sourceIndex) : defaultLabel(entry.sourceIndex);
    }
    if (entry.kind === "external") {
      const read = externals.get(entry.sourceId)?.labels;
      return read?.kind === "ranges" ? labelAt(read.ranges, entry.sourceIndex) : defaultLabel(entry.sourceIndex);
    }
    return EMPTY_LABEL;
  });
}

/**
 * Aplica un plan de paginas al documento actual y devuelve el PDF resultante.
 *
 * El plan es la lista FINAL de paginas, en orden: lo que no aparece se elimina (un plan vacio es
 * un error `empty`, nunca «sin cambios»). Cada entrada que no se puede cumplir lanza un error
 * tipado en vez de saltarse en silencio.
 *
 * `current` puede ser un `PDFDocument` ya cargado (se edita EN SITIO y queda inservible para otra
 * cosa): lo usan las herramientas sueltas, que ya lo cargaron para leer el numero de paginas.
 */
export async function applyPageAssembly(
  current: Uint8Array | PDFDocument,
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

    const document = current instanceof PDFDocument ? current : await loadPdf(current);
    const context = document.context;
    const pageCount = document.getPageCount();
    if (pageCount < 1) throw new PdfError("corrupt");
    validatePlan(plan, pageCount, externals, options.maxExternalDocuments ?? PAGE_ASSEMBLY_LIMITS.maxExternalDocuments);
    onProgress?.(0.08);
    throwIfAborted(signal);

    const added = countAddedPages(plan);
    if (added > PAGE_ASSEMBLY_LIMITS.warnAddedPages) warn("largeInsert", added);

    const originalPages = document.getPages();
    const catalog = document.catalog;
    /** Primer objeto que traen las paginas de otros PDF (`copyPages` los registra todos a partir de aqui). */
    const firstCopiedObject = context.largestObjectNumber + 1;

    /* ---------- 1. paginas de otros PDF (una llamada a copyPages por documento) ---------- */
    const externalLeaves = new Map<string, PDFPage>();
    /** Numeracion de paginas y estructura de cada documento externo (se leen antes de tocarlo). */
    const externalInfo = new Map<string, { labels: LabelsRead; tagged: boolean }>();
    const pdfIds = externalPdfIds(plan);
    /** Marcadores de documentos externos a agrupar al final (`outlineGroups`), en orden de documento. */
    const outlineGroups: { title: string; firstPageRef: PDFRef; items: ImportedOutlineItem[] }[] = [];
    let externalUsed = false;
    for (let sourceNumber = 0; sourceNumber < pdfIds.length; sourceNumber += 1) {
      throwIfAborted(signal);
      const sourceId = pdfIds[sourceNumber];
      const sourceDocument = await loadExternal(externals[sourceId]);
      throwIfAborted(signal);
      const sourceCount = sourceDocument.getPageCount();
      const indices: number[] = [];
      for (const entry of plan) {
        if (entry.kind !== "external" || entry.sourceId !== sourceId) continue;
        if (entry.sourceIndex >= sourceCount) throw new PdfError("invalidConfig");
        if (!indices.includes(entry.sourceIndex)) indices.push(entry.sourceIndex);
      }
      const sourcePages = sourceDocument.getPages();
      externalInfo.set(sourceId, {
        labels: readPageLabels(sourceDocument.context, sourceDocument.catalog),
        tagged: hasStructureTree(sourceDocument.catalog),
      });
      for (const index of indices) materializeInherited(sourcePages[index].node);
      // Enlaces internos: se marcan con la pagina de ORIGEN a la que llevan y se reapuntan tras copiar.
      const pageIndexByRef = new Map<string, number>();
      sourcePages.forEach((page, position) => pageIndexByRef.set(refKey(page.ref), position));
      const cleaned = sanitizeLeavesForCopy(
        sourceDocument.context,
        sourceDocument.catalog,
        indices.map((index) => sourcePages[index].node),
        pageIndexByRef,
      );
      warn("signatureFieldsRemoved", cleaned.emptySignaturesRemoved);
      warn("signedSignaturesRemoved", cleaned.signedSignaturesRemoved);
      const copied = await document.copyPages(sourceDocument, indices);
      copied.forEach((page, position) => {
        fixCopiedLeaf(context, page.node, page.ref);
        externalLeaves.set(`${sourceId}:${indices[position]}`, page);
      });
      const unresolvedLinks = resolveMarkedLinks(
        context,
        copied.map((page) => page.node),
        (sourceIndex) => externalLeaves.get(`${sourceId}:${sourceIndex}`)?.ref,
      );
      // Botones y otras acciones de salto: tambien se reapuntan a las paginas copiadas (o se quitan si esa pagina no vino).
      const unresolvedActions = resolveMarkedActions(
        context,
        copied.map((page) => page.node),
        (sourceIndex) => externalLeaves.get(`${sourceId}:${sourceIndex}`)?.ref,
      );
      warn("linksRemoved", cleaned.linksRemoved + unresolvedLinks + unresolvedActions);
      const groupTitle = options.outlineGroups?.[sourceId];
      if (groupTitle !== undefined && copied.length > 0) {
        const pageMap = new Map<number, PDFRef>();
        copied.forEach((page, position) => pageMap.set(indices[position], page.ref));
        const imported = readImportableOutline(
          sourceDocument.context,
          sourceDocument.catalog,
          sourcePages.map((page) => page.ref),
          pageMap,
        );
        warn("outlinesRemoved", imported.dropped);
        // El grupo lleva a la primera pagina copiada SEGUN EL PLAN (no segun el documento origen).
        const firstEntry = plan.find((entry) => entry.kind === "external" && entry.sourceId === sourceId);
        const firstKey = firstEntry && firstEntry.kind === "external" ? `${sourceId}:${firstEntry.sourceIndex}` : "";
        const firstPageRef = externalLeaves.get(firstKey)?.ref ?? copied[0].ref;
        outlineGroups.push({ title: groupTitle, firstPageRef, items: imported.items });
      }
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
        if (raw instanceof PDFDocument) throw new PdfError("invalidConfig");
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

    const hadStructure = hasStructureTree(catalog);
    /** Paginas copiadas que no llevan etiquetas de accesibilidad (duplicados, y paginas de otro PDF en un resultado etiquetado o que venian etiquetadas). */
    let untaggedPages = 0;
    const externalClaimed = new Set<string>();
    const slots: Slot[] = [];
    for (const entry of plan) {
      if (entry.kind === "existing") {
        const page = originalPages[entry.sourceIndex];
        if (claimant.get(entry.sourceIndex) === entry) {
          slots.push({ leaf: page.node, ref: page.ref, fresh: false });
        } else {
          slots.push({ ...cloneLeafInPlace(context, page.node), fresh: true });
          if (hadStructure) untaggedPages += 1;
        }
      } else if (entry.kind === "external") {
        const key = `${entry.sourceId}:${entry.sourceIndex}`;
        const page = externalLeaves.get(key);
        if (!page) throw new PdfError("unknown");
        // Sin etiquetas en el resultado: lo que pierde las suyas (el origen estaba etiquetado) y lo que llega, sin ellas, a un
        // documento que SI lo esta (el resultado se anuncia como etiquetado). Si nadie estaba etiquetado, no hay nada que avisar.
        if (hadStructure || externalInfo.get(entry.sourceId)?.tagged) untaggedPages += 1;
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
    /** Hojas originales que ya no estan en el plan (y que nada del resultado debe seguir referenciando). */
    const deadPages = deletedAny ? originalPages.filter((page) => !live.has(refKey(page.ref))) : [];
    let structurePruned = false;
    // Destinos con nombre ANTES de podar nada: a donde llevaba cada nombre (los enlaces y las acciones lo consultan).
    const named = collectNamedDests(context, catalog);
    const isLive = (ref: PDFRef) => live.has(refKey(ref));

    if (deletedAny) {
      warn("outlinesRemoved", pruneOutline(context, catalog, named, isLive, { dropStructure: hadStructure }));
      warn("linksRemoved", pruneLinks(context, finalLeaves, named, isLive));
      warn("linksRemoved", pruneOpenAction(context, catalog, named, isLive));
      warn("namedDestinationsRemoved", pruneNamedDests(context, catalog, named, isLive));
      if (hadStructure) {
        // El arbol de estructura se poda a las paginas que quedan; si no se puede con seguridad, se quita entero.
        structurePruned = pruneStructureTree(
          context,
          catalog,
          new Set(deadPages.map((page) => refKey(page.ref))),
          deadPages.map((page) => page.node),
        );
        if (!structurePruned && dropStructureTree(catalog)) warn("structureRemoved", 1);
      }
    }
    warn("structureIncomplete", untaggedPages);

    /* ---------- 6b. marcadores por documento (Unir) ---------- */
    if (options.wrapOutlineTitle !== undefined) {
      // El grupo del documento actual lleva a su primera pagina que sigue en el plan (o a la primera del plan).
      const firstOwn = slots.find((slot, index) => plan[index].kind === "existing") ?? slots[0];
      wrapExistingOutline(context, catalog, options.wrapOutlineTitle, firstOwn.ref);
    }
    for (const group of outlineGroups) {
      appendOutlineGroup(context, catalog, group.title, group.firstPageRef, group.items);
    }

    const freshLeaves = slots.filter((slot) => slot.fresh).map((slot) => slot.leaf);
    if (freshLeaves.length > 0) {
      const registered = registerNewFields(context, catalog, freshLeaves);
      warn("fieldsRenamed", registered.renamed);
    }
    /** Lo que se quito del formulario (campos, grupos, widgets): se corta de todo lo que lo nombre (ver `neutralizeDeadReferences`). */
    let deadFormNodes: PDFRef[] = [];
    if (deletedAny || externalUsed) {
      const form = pruneAcroForm(
        context,
        catalog,
        collectPresentWidgets(context, finalLeaves),
        deadPages.map((page) => page.node),
      );
      warn("formFieldsRemoved", form.removed);
      deadFormNodes = form.deadNodes;
    }

    /* ---------- 6c. etiquetas de pagina: la etiqueta sigue a la pagina ---------- */
    const baseLabels = readPageLabels(context, catalog);
    if (baseLabels.kind === "unreadable") {
      // Ilegible: si las primeras paginas siguen en su sitio se deja tal cual; si no, se quita y se avisa.
      if (!preservesPageLabels(plan, pageCount)) {
        if (dropPageLabels(catalog)) warn("pageLabelsRemoved", 1);
      } else {
        // Se deja el arbol como esta, pero las etiquetas de los documentos anadidos no se pueden sumar a un arbol que no
        // se lee: se pierden, y no en silencio (un documento anadido sin numeracion propia no pierde nada).
        warn("pageLabelsRemoved", [...externalInfo.values()].filter((info) => info.labels.kind !== "none").length);
      }
    } else {
      const unreadable = [...externalInfo.values()].filter((info) => info.labels.kind === "unreadable").length;
      warn("pageLabelsRemoved", unreadable);
      const labels = planLabels(plan, baseLabels, externalInfo);
      if (labels) {
        const ranges = compressLabels(labels);
        const unlabelled = ranges.length === 1 && ranges[0].style === undefined && ranges[0].prefix === "";
        if (unlabelled) {
          catalog.delete(KEY.PageLabels);
        } else {
          const current =
            baseLabels.kind === "ranges"
              ? compressLabels(Array.from({ length: pageCount }, (_, index) => labelAt(baseLabels.ranges, index)))
              : [];
          // Sin cambios (las etiquetas actuales ya numeran asi todas las paginas): se deja el arbol como esta.
          if (!sameRanges(ranges, current.filter((range) => range.start < plan.length))) {
            writePageLabels(context, catalog, ranges);
          }
        }
      }
    }

    if (deletedAny || externalUsed) {
      // Paginas muertas: las quitadas y las que `copyPages` arrastro como huerfanas. Nada que se conserve puede seguir
      // llevando a ellas, o su objeto, su texto y sus anotaciones se quedarian dentro del archivo.
      const orphans = findDeadPages(
        context,
        live,
        deadPages.map((page) => page.ref),
        externalUsed ? firstCopiedObject : undefined,
      );
      warn(
        "linksRemoved",
        neutralizeDeadReferences(context, catalog, {
          deadPages: orphans,
          liveLeaves: finalLeaves,
          deadFields: deadFormNodes,
          named,
          newObjectsFrom: externalUsed ? firstCopiedObject : undefined,
        }),
      );
      collectGarbage(context);
      if (structurePruned && orphans.some((page) => context.lookup(page) !== undefined)) {
        // Algo del arbol podado sigue llevando a una pagina quitada: mejor sin estructura que arrastrar la pagina.
        if (dropStructureTree(catalog)) warn("structureRemoved", 1);
        collectGarbage(context);
      }
    }
    // Reescribir el archivo invalida las firmas digitales que siguen en el documento.
    warn("signaturesInvalidated", countSignedSignatures(context, catalog));
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
