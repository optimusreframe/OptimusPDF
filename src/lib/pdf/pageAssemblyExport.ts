import { PDFDocument, type PDFRef } from "@cantoo/pdf-lib";
import {
  PdfError,
  loadPdf,
  scaleProgress,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { uniqueZipName, zipNameKey } from "@/lib/pdf/entryNames";
import {
  applyPageAssembly,
  type PageAssemblyOptions,
  type PageAssemblyResult,
  type PageAssemblyWarning,
  type PageAssemblyWarningCode,
  type PageEntry,
} from "@/lib/pdf/pageAssembly";
import { findDeadPages, neutralizeDeadReferences, resolveMarkedActions } from "@/lib/pdf/pageAssemblyDeadRefs";
import {
  compressLabels,
  labelAt,
  readPageLabels,
  sameRanges,
  writePageLabels,
} from "@/lib/pdf/pageAssemblyLabels";
import {
  addOutlineItems,
  collectGarbage,
  collectNamedDests,
  collectPresentWidgets,
  countOutlineItems,
  fixCopiedLeaf,
  hasStructureTree,
  itemTarget,
  outlineTitle,
  pruneAcroForm,
  readImportableOutline,
  readOutline,
  refKey,
  registerNewFields,
  resolveMarkedLinks,
  sanitizeLeavesForCopy,
  type OutlineNode,
} from "@/lib/pdf/pageAssemblyStructure";
import { buildSplitGroups, formatPageList, type PageRange } from "@/lib/pdf/split";

/**
 * Operaciones de EXPORTACION del motor de paginas (Wave 7 · U4): sacan paginas a un PDF nuevo o
 * dividen el documento en varios, SIN modificar el documento de trabajo. Modulo puro (sin React).
 *
 *  - `extractPages` aprovecha la edicion en sitio del motor (sobre una copia en memoria): el PDF
 *    extraido conserva titulo, autor, formulario y los marcadores de las paginas que se quedan,
 *    y no arrastra nada de las demas (se sueltan los objetos sin referencia).
 *  - `splitDocument` crea un PDF por parte: parte de un documento nuevo (rapido con cientos de
 *    partes) al que se copian los metadatos del original y las paginas con su formulario, sus
 *    etiquetas de pagina, los marcadores que apuntan a sus paginas y los enlaces entre sus paginas
 *    (reapuntados a las copias). Lo que no cabe en una parte (enlaces y marcadores hacia otras partes,
 *    firmas, estructura etiquetada) se cuenta en `warnings`.
 */

/** Maximo de partes de una division (cada parte es un archivo del ZIP). */
export const MAX_SPLIT_PARTS = 500;

/** Indices 0-based ordenados y sin repetir; fuera de rango o no enteros se descartan. */
function cleanIndices(indices: readonly number[], pageCount: number): number[] {
  return [...new Set(indices)]
    .filter((index) => Number.isInteger(index) && index >= 0 && index < pageCount)
    .sort((a, b) => a - b);
}

/** Plan que extrae las paginas indicadas (0-based) en orden ascendente. */
export function extractionPlan(indices: readonly number[]): PageEntry[] {
  return [...new Set(indices)]
    .filter((index) => Number.isInteger(index) && index >= 0)
    .sort((a, b) => a - b)
    .map((sourceIndex) => ({ kind: "existing" as const, sourceIndex, rotation: 0 }));
}

/**
 * PDF nuevo con solo las paginas indicadas (0-based). No modifica `currentBytes`. Sin paginas
 * validas, error `nothingSelected`.
 */
export async function extractPages(
  currentBytes: Uint8Array,
  indices: readonly number[],
  options: PageAssemblyOptions = {},
): Promise<PageAssemblyResult> {
  const plan = extractionPlan(indices);
  if (plan.length === 0) throw new PdfError("nothingSelected");
  return applyPageAssembly(currentBytes, plan, {}, options);
}

/* ------------------------------------------------------------------ *
 * Listas de rangos «1-3, 5, 7-9»
 * ------------------------------------------------------------------ */

/**
 * Cada elemento de la lista es UNA parte: `"1-3, 5, 7-9"` -> `[1-3], [5-5], [7-9]`.
 * `null` si algun tramo es invalido (fuera de rango, al reves, sin numero). Cadena vacia -> `[]`.
 */
export function parseRangeParts(text: string, pageCount: number): PageRange[] | null {
  const trimmed = text.trim().replace(/\s*[-–—]\s*/g, "-");
  if (trimmed.length === 0) return [];
  const ranges: PageRange[] = [];
  for (const token of trimmed.split(/[,;\s]+/)) {
    if (token.length === 0) continue;
    const bounds = token.split("-");
    if (bounds.length > 2 || bounds.some((part) => !/^\d+$/.test(part))) return null;
    const from = Number.parseInt(bounds[0], 10);
    const to = bounds.length === 2 ? Number.parseInt(bounds[1], 10) : from;
    if (from < 1 || to < from || (pageCount > 0 && to > pageCount)) return null;
    ranges.push({ from, to });
  }
  return ranges;
}

/* ------------------------------------------------------------------ *
 * Marcadores como puntos de corte
 * ------------------------------------------------------------------ */

export type BookmarkStart = { title: string; pageIndex: number; level: number };

/** Marcadores (hasta `maxLevel` niveles) que apuntan a una pagina, en orden de aparicion. */
export async function readBookmarkStarts(
  source: Uint8Array | Blob,
  maxLevel = 1,
): Promise<BookmarkStart[]> {
  const document = await loadPdf(source);
  const context = document.context;
  const tree = readOutline(context, document.catalog);
  if (!tree) return [];
  const pageIndex = new Map<string, number>();
  document.getPages().forEach((page, index) => pageIndex.set(refKey(page.ref), index));
  const named = collectNamedDests(context, document.catalog);
  const out: BookmarkStart[] = [];
  const visit = (nodes: OutlineNode[], level: number) => {
    for (const node of nodes) {
      const target = itemTarget(context, node.dict, named);
      if (target.kind === "page") {
        const index = pageIndex.get(refKey(target.ref));
        if (index !== undefined) out.push({ title: outlineTitle(context, node), pageIndex: index, level });
      }
      if (level < maxLevel) visit(node.children, level + 1);
    }
  };
  visit(tree.items, 1);
  return out;
}

/** Grupos de paginas (0-based) entre marcadores consecutivos; nunca deja paginas sin parte. */
export function bookmarkGroups(
  starts: readonly BookmarkStart[],
  pageCount: number,
  leadingTitle = "Inicio",
): { groups: number[][]; titles: string[] } {
  if (pageCount < 1) return { groups: [], titles: [] };
  const byPage = new Map<number, string>();
  for (const start of [...starts].sort((a, b) => a.pageIndex - b.pageIndex)) {
    if (!byPage.has(start.pageIndex)) byPage.set(start.pageIndex, start.title);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  const groups: number[][] = [];
  const titles: string[] = [];
  const push = (from: number, to: number, title: string) => {
    groups.push(Array.from({ length: to - from + 1 }, (_, i) => from + i));
    titles.push(title);
  };
  if (pages.length === 0) {
    push(0, pageCount - 1, leadingTitle);
    return { groups, titles };
  }
  if (pages[0] > 0) push(0, pages[0] - 1, leadingTitle);
  pages.forEach((page, index) => {
    const end = index + 1 < pages.length ? pages[index + 1] - 1 : pageCount - 1;
    push(page, end, byPage.get(page) ?? "");
  });
  return { groups, titles };
}

/* ------------------------------------------------------------------ *
 * Division
 * ------------------------------------------------------------------ */

export type SplitSpec =
  /** Cada rango es una parte. */
  | { mode: "ranges"; ranges: readonly PageRange[] }
  /** Bloques consecutivos de `size` paginas. */
  | { mode: "every"; size: number }
  /** Una parte por marcador (hasta `level` niveles). */
  | { mode: "bookmarks"; level?: number; leadingTitle?: string };

export type SplitParts = { groups: number[][]; titles: (string | undefined)[] };

/** Grupos de paginas de una division (sin ejecutarla). Nunca lanza: plan invalido -> sin grupos. */
export async function planSplit(
  source: Uint8Array | Blob,
  spec: SplitSpec,
  pageCount: number,
): Promise<SplitParts> {
  if (spec.mode === "bookmarks") {
    const starts = await readBookmarkStarts(source, spec.level ?? 1);
    return bookmarkGroups(starts, pageCount, spec.leadingTitle);
  }
  if (spec.mode === "every") {
    return { groups: buildSplitGroups({ mode: "fixed", size: spec.size }, pageCount), titles: [] };
  }
  return {
    groups: buildSplitGroups({ mode: "ranges", ranges: [...spec.ranges], merge: false }, pageCount),
    titles: [],
  };
}

export type SplitOutcome = {
  /** `pdf` si salio una sola parte; `zip` si salieron varias. */
  kind: "pdf" | "zip";
  bytes: Uint8Array;
  parts: number;
  /** Nombres de los archivos (dentro del ZIP, o el unico PDF). */
  names: string[];
  /** Lo que no se pudo llevar a las partes (marcadores o enlaces hacia otras partes, firmas, estructura). */
  warnings: PageAssemblyWarning[];
};

function safeTitle(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 80).trim();
}

function partName(base: string, group: readonly number[], title?: string): string {
  const first = group[0] + 1;
  const last = group[group.length - 1] + 1;
  const clean = title ? safeTitle(title) : "";
  if (clean) return `${base} - ${clean}.pdf`;
  return first === last ? `${base}-${first}.pdf` : `${base}-${first}-${last}.pdf`;
}

/** Copia los metadatos del documento original al de una parte. */
function copyMetadata(from: PDFDocument, to: PDFDocument): void {
  const title = from.getTitle();
  const author = from.getAuthor();
  const subject = from.getSubject();
  const keywords = from.getKeywords();
  const creator = from.getCreator();
  const producer = from.getProducer();
  const created = from.getCreationDate();
  const modified = from.getModificationDate();
  if (title !== undefined) to.setTitle(title);
  if (author !== undefined) to.setAuthor(author);
  if (subject !== undefined) to.setSubject(subject);
  if (keywords !== undefined) to.setKeywords(keywords.split(/\s*[,;]\s*/).filter(Boolean));
  if (creator !== undefined) to.setCreator(creator);
  if (producer !== undefined) to.setProducer(producer);
  if (created) to.setCreationDate(created);
  if (modified) to.setModificationDate(modified);
}

/**
 * Divide el documento en partes (un PDF por grupo). Con una sola parte devuelve un PDF; con varias,
 * un ZIP con nombres unicos. No modifica `currentBytes`. `baseName` va SIN extension.
 */
export async function splitDocument(
  currentBytes: Uint8Array,
  groups: readonly (readonly number[])[],
  baseName: string,
  options: { signal?: AbortSignal; onProgress?: ProgressCallback; titles?: readonly (string | undefined)[] } = {},
): Promise<SplitOutcome> {
  const { signal, onProgress } = options;
  try {
    throwIfAborted(signal);
    const source = await loadPdf(currentBytes);
    const pageCount = source.getPageCount();
    const clean = groups
      .map((group) => cleanIndices(group, pageCount))
      .map((group, index) => ({ group, title: options.titles?.[index] }))
      .filter((entry) => entry.group.length > 0);
    // «nothingSelected» y no «empty»: el archivo se cargo bien, lo que falta es algo que dividir.
    if (clean.length === 0) throw new PdfError("nothingSelected");
    if (clean.length > MAX_SPLIT_PARTS) throw new PdfError("tooLarge");
    onProgress?.(0.08);

    const warnings = new Map<PageAssemblyWarningCode, number>();
    const warn = (code: PageAssemblyWarningCode, count: number) => {
      if (count > 0) warnings.set(code, (warnings.get(code) ?? 0) + count);
    };

    // Una sola vez sobre el original (en memoria), solo las paginas que salen: fuera las referencias a la
    // pagina de origen y las firmas, y los enlaces internos quedan MARCADOS con la pagina a la que llevan
    // (si no, `copyPages` arrastraria el documento entero a cada parte); cada parte los reapunta a sus copias.
    const sourcePages = source.getPages();
    const usedPages = [...new Set(clean.flatMap((entry) => entry.group))].sort((a, b) => a - b);
    const pageIndexByRef = new Map<string, number>();
    sourcePages.forEach((page, position) => pageIndexByRef.set(refKey(page.ref), position));
    const cleaned = sanitizeLeavesForCopy(
      source.context,
      source.catalog,
      usedPages.map((index) => sourcePages[index].node),
      pageIndexByRef,
    );
    warn("signatureFieldsRemoved", cleaned.emptySignaturesRemoved);
    warn("signedSignaturesRemoved", cleaned.signedSignaturesRemoved);
    warn("linksRemoved", cleaned.linksRemoved);
    const labels = readPageLabels(source.context, source.catalog);
    if (labels.kind === "unreadable") warn("pageLabelsRemoved", 1);
    // Cada parte es un documento nuevo: no hereda el arbol de estructura del original.
    if (hasStructureTree(source.catalog)) warn("structureRemoved", 1);
    const outlineTotal = countOutlineItems(source.context, source.catalog);
    let outlineKept = 0;
    const sourcePageRefs = sourcePages.map((page) => page.ref);

    const buildPart = async (group: readonly number[]): Promise<Uint8Array> => {
      const part = await PDFDocument.create({ updateMetadata: false });
      copyMetadata(source, part);
      const copied = await part.copyPages(source, [...group]);
      const refOf = new Map<number, PDFRef>();
      copied.forEach((page, position) => {
        fixCopiedLeaf(part.context, page.node, page.ref);
        part.addPage(page);
        refOf.set(group[position], page.ref);
      });
      const leaves = copied.map((page) => page.node);
      warn("linksRemoved", resolveMarkedLinks(part.context, leaves, (index) => refOf.get(index)));
      warn("linksRemoved", resolveMarkedActions(part.context, leaves, (index) => refOf.get(index)));
      registerNewFields(part.context, part.catalog, leaves);
      const form = pruneAcroForm(part.context, part.catalog, collectPresentWidgets(part.context, leaves));
      if (outlineTotal > 0) {
        const imported = readImportableOutline(source.context, source.catalog, sourcePageRefs, refOf);
        outlineKept += addOutlineItems(part.context, part.catalog, imported.items);
      }
      if (labels.kind === "ranges") {
        const ranges = compressLabels(group.map((index) => labelAt(labels.ranges, index)));
        // La numeracion por defecto (1, 2, 3...) no necesita etiquetas.
        if (!sameRanges(ranges, [{ start: 0, style: "D", prefix: "", first: 1 }])) {
          writePageLabels(part.context, part.catalog, ranges);
        }
      }
      // `copyPages` sigue las referencias y arrastra, como huerfanas, las paginas a las que lleva la copiada: se cortan antes
      // de soltar los objetos sin referencia, o cada parte llevaria dentro paginas que no son suyas.
      const live = new Set(copied.map((page) => refKey(page.ref)));
      const orphans = findDeadPages(part.context, live, [], 0);
      warn(
        "linksRemoved",
        neutralizeDeadReferences(part.context, part.catalog, {
          deadPages: orphans,
          liveLeaves: leaves,
          deadFields: form.deadNodes,
          named: collectNamedDests(part.context, part.catalog),
          newObjectsFrom: 0,
        }),
      );
      collectGarbage(part.context);
      return part.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
    };
    const finish = (): PageAssemblyWarning[] => {
      warn("outlinesRemoved", Math.max(0, outlineTotal - outlineKept));
      return [...warnings.entries()].map(([code, count]) => ({ code, count }));
    };

    if (clean.length === 1) {
      const bytes = await buildPart(clean[0].group);
      onProgress?.(1);
      return {
        kind: "pdf",
        bytes,
        parts: 1,
        names: [partName(baseName, clean[0].group, clean[0].title)],
        warnings: finish(),
      };
    }

    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    const used = new Set<string>();
    const names: string[] = [];
    for (let index = 0; index < clean.length; index += 1) {
      throwIfAborted(signal);
      const { group, title } = clean[index];
      const bytes = await buildPart(group);
      const name = uniqueZipName(partName(baseName, group, title), used, { startAt: 2, key: zipNameKey });
      names.push(name);
      zip.file(name, bytes);
      onProgress?.(scaleProgress((index + 1) / clean.length, 0.08, 0.9));
    }
    throwIfAborted(signal);
    const zipped = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    onProgress?.(1);
    return { kind: "zip", bytes: zipped, parts: clean.length, names, warnings: finish() };
  } catch (error) {
    throw toPdfError(error);
  }
}

/** Texto de un grupo para mostrar (`1-3`, `5`). */
export function describeGroup(group: readonly number[]): string {
  return formatPageList(group.map((index) => index + 1));
}
