import { PDFDict, PDFName, PDFRef, type PDFDocument } from "@cantoo/pdf-lib";
import { PdfError, loadPdf, toPdfError } from "@/lib/pdf/core";

/**
 * Motor de metadatos del documento (Wave 7 · U5). Modulo puro (sin React).
 *
 * Lee y escribe el diccionario `/Info` (titulo, autor, asunto, palabras clave, creador, productor y las
 * dos fechas) y sabe ELIMINAR todos los metadatos, incluido el paquete XMP del catalogo y de las
 * paginas. Solo toca metadatos: paginas, contenido, formularios, marcadores y enlaces se conservan tal
 * cual (`loadPdf` abre con `updateMetadata: false`, asi que ni el productor ni la fecha de
 * modificacion cambian por el mero hecho de abrir y guardar).
 *
 * Decisiones:
 *  - `undefined` en un campo del parche = «no tocar»; `""` / `null` = «quitar ese campo».
 *  - La fecha de modificacion se actualiza al escribir (`touchModificationDate`, por defecto sí) salvo
 *    que el parche la fije explicitamente.
 *  - XMP: los visores (pdf.js entre ellos) prefieren el titulo/autor del XMP al de `/Info`. Si se
 *    cambia algun dato y el PDF trae XMP, se ELIMINA el XMP para que no contradiga lo escrito
 *    (`xmp: "remove"`, por defecto) o se conserva a proposito (`xmp: "keep"`). El resultado informa
 *    de lo que paso (`xmpRemoved`).
 *  - Eliminar el XMP borra tambien el OBJETO del contexto (no solo la referencia): pdf-lib no recolecta
 *    objetos huerfanos y el paquete seguiria dentro del archivo.
 */

const INFO_KEYS = {
  title: "Title",
  author: "Author",
  subject: "Subject",
  keywords: "Keywords",
  creator: "Creator",
  producer: "Producer",
  creationDate: "CreationDate",
  modificationDate: "ModDate",
} as const;

/** Claves estandar de `/Info` (el resto cuenta como «personalizadas»). */
const STANDARD_INFO_KEYS: ReadonlySet<string> = new Set([...Object.values(INFO_KEYS), "Trapped"]);

export type PdfMetadata = {
  title: string;
  author: string;
  subject: string;
  /** Texto tal cual (p. ej. «contrato, 2026, cliente»). */
  keywords: string;
  creator: string;
  producer: string;
  creationDate: Date | null;
  modificationDate: Date | null;
};

export type PdfMetadataInfo = PdfMetadata & {
  /** El catalogo (o alguna pagina) trae un paquete XMP. */
  hasXmp: boolean;
  /** Claves de `/Info` que no son del estandar (sin la barra inicial). */
  customKeys: string[];
};

export const EMPTY_PDF_METADATA: PdfMetadata = {
  title: "",
  author: "",
  subject: "",
  keywords: "",
  creator: "",
  producer: "",
  creationDate: null,
  modificationDate: null,
};

/** Parche de escritura: `undefined` = no tocar, `""`/`null` = quitar el campo. */
export type PdfMetadataPatch = {
  title?: string | null;
  author?: string | null;
  subject?: string | null;
  keywords?: string | null;
  creator?: string | null;
  producer?: string | null;
  creationDate?: Date | null;
  modificationDate?: Date | null;
};

export type WriteMetadataOptions = {
  /** Actualizar `ModDate` si el parche no la fija. Por defecto, sí. */
  touchModificationDate?: boolean;
  /** Que hacer con un XMP existente cuando algo cambia. Por defecto, quitarlo. */
  xmp?: "remove" | "keep";
  /** Reloj inyectable (pruebas). */
  now?: () => Date;
};

export type WriteMetadataResult = {
  bytes: Uint8Array;
  /** Se elimino un XMP que habria contradicho los datos nuevos. */
  xmpRemoved: boolean;
  /** Campos que cambiaron de verdad (sin contar `modificationDate` automatica). */
  changed: Array<keyof PdfMetadata>;
};

export type StripMetadataResult = {
  bytes: Uint8Array;
  /** Entradas de `/Info` eliminadas. */
  removedInfoKeys: number;
  xmpRemoved: boolean;
};

/* ------------------------------------------------------------------ *
 * Lectura
 * ------------------------------------------------------------------ */

const METADATA_KEY = PDFName.of("Metadata");
const PIECE_INFO_KEY = PDFName.of("PieceInfo");

function infoDictOf(document: PDFDocument): PDFDict | undefined {
  const entry = document.context.trailerInfo.Info;
  if (!entry) return undefined;
  const value = document.context.lookup(entry);
  return value instanceof PDFDict ? value : undefined;
}

function safe<T>(read: () => T | undefined): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function pageHasMetadata(document: PDFDocument): boolean {
  return document.getPages().some((page) => page.node.has(METADATA_KEY));
}

function documentHasXmp(document: PDFDocument): boolean {
  return document.catalog.has(METADATA_KEY) || pageHasMetadata(document);
}

function readFrom(document: PDFDocument): PdfMetadataInfo {
  const info = infoDictOf(document);
  const customKeys: string[] = [];
  if (info) {
    for (const key of info.keys()) {
      const name = key.decodeText();
      if (!STANDARD_INFO_KEYS.has(name)) customKeys.push(name);
    }
  }
  const validDate = (value: Date | undefined): Date | null =>
    value instanceof Date && !Number.isNaN(value.getTime()) ? value : null;
  return {
    title: safe(() => document.getTitle()) ?? "",
    author: safe(() => document.getAuthor()) ?? "",
    subject: safe(() => document.getSubject()) ?? "",
    keywords: safe(() => document.getKeywords()) ?? "",
    creator: safe(() => document.getCreator()) ?? "",
    producer: safe(() => document.getProducer()) ?? "",
    creationDate: validDate(safe(() => document.getCreationDate())),
    modificationDate: validDate(safe(() => document.getModificationDate())),
    hasXmp: documentHasXmp(document),
    customKeys,
  };
}

/** Lee los metadatos de unos bytes (PDF sin cifrar). */
export async function readMetadata(source: Uint8Array | Blob): Promise<PdfMetadataInfo> {
  try {
    const document = await loadPdf(source);
    return readFrom(document);
  } catch (error) {
    throw toPdfError(error);
  }
}

/* ------------------------------------------------------------------ *
 * Escritura
 * ------------------------------------------------------------------ */

const TEXT_FIELDS = ["title", "author", "subject", "keywords", "creator", "producer"] as const;
const DATE_FIELDS = ["creationDate", "modificationDate"] as const;

function setText(document: PDFDocument, field: (typeof TEXT_FIELDS)[number], value: string): void {
  switch (field) {
    case "title":
      document.setTitle(value);
      break;
    case "author":
      document.setAuthor(value);
      break;
    case "subject":
      document.setSubject(value);
      break;
    case "keywords":
      // pdf-lib une el arreglo con espacios: un unico elemento conserva las comas del usuario.
      document.setKeywords([value]);
      break;
    case "creator":
      document.setCreator(value);
      break;
    case "producer":
      document.setProducer(value);
      break;
  }
}

function sameDate(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000);
}

/** Quita el XMP del catalogo y de las paginas, BORRANDO los objetos. Devuelve si habia alguno. */
function dropXmp(document: PDFDocument): boolean {
  let removed = false;
  const drop = (owner: PDFDict): void => {
    const entry = owner.get(METADATA_KEY);
    if (entry === undefined) return;
    owner.delete(METADATA_KEY);
    if (entry instanceof PDFRef) document.context.delete(entry);
    removed = true;
  };
  drop(document.catalog);
  for (const page of document.getPages()) drop(page.node);
  return removed;
}

/** Quita `/PieceInfo` (datos privados de aplicaciones) del catalogo y de las paginas. */
function dropPieceInfo(document: PDFDocument): void {
  const drop = (owner: PDFDict): void => {
    const entry = owner.get(PIECE_INFO_KEY);
    if (entry === undefined) return;
    owner.delete(PIECE_INFO_KEY);
    if (entry instanceof PDFRef) document.context.delete(entry);
  };
  drop(document.catalog);
  for (const page of document.getPages()) drop(page.node);
}

function describeChange(before: PdfMetadata, patch: PdfMetadataPatch): Array<keyof PdfMetadata> {
  const changed: Array<keyof PdfMetadata> = [];
  for (const field of TEXT_FIELDS) {
    const next = patch[field];
    if (next === undefined) continue;
    if ((next ?? "") !== before[field]) changed.push(field);
  }
  for (const field of DATE_FIELDS) {
    const next = patch[field];
    if (next === undefined) continue;
    if (!sameDate(next, before[field])) changed.push(field);
  }
  return changed;
}

/**
 * Escribe los campos del parche y devuelve los bytes nuevos. Los campos no mencionados se conservan.
 */
export async function writeMetadata(
  source: Uint8Array | Blob,
  patch: PdfMetadataPatch,
  options: WriteMetadataOptions = {},
): Promise<WriteMetadataResult> {
  try {
    const document = await loadPdf(source);
    if (document.getPageCount() === 0) throw new PdfError("corrupt");
    const before = readFrom(document);
    const changed = describeChange(before, patch);

    const info = infoDictOf(document);
    for (const field of TEXT_FIELDS) {
      const next = patch[field];
      if (next === undefined) continue;
      const value = next ?? "";
      if (value.length === 0) info?.delete(PDFName.of(INFO_KEYS[field]));
      else setText(document, field, value);
    }
    for (const field of DATE_FIELDS) {
      const next = patch[field];
      if (next === undefined) continue;
      if (next === null) info?.delete(PDFName.of(INFO_KEYS[field]));
      else if (field === "creationDate") document.setCreationDate(next);
      else document.setModificationDate(next);
    }

    const touch = (options.touchModificationDate ?? true) && patch.modificationDate === undefined;
    if (touch && changed.length > 0) document.setModificationDate((options.now ?? (() => new Date()))());

    let xmpRemoved = false;
    if (changed.length > 0 && (options.xmp ?? "remove") === "remove") xmpRemoved = dropXmp(document);

    const bytes = await document.save({ useObjectStreams: true });
    return { bytes, xmpRemoved, changed };
  } catch (error) {
    throw toPdfError(error);
  }
}

/**
 * Elimina TODOS los metadatos: cada entrada de `/Info` (estandar y personalizada), el XMP del catalogo
 * y de las paginas (borrando los objetos) y `/PieceInfo`. El contenido del documento no se toca.
 */
export async function stripMetadata(source: Uint8Array | Blob): Promise<StripMetadataResult> {
  try {
    const document = await loadPdf(source);
    if (document.getPageCount() === 0) throw new PdfError("corrupt");

    let removedInfoKeys = 0;
    const info = infoDictOf(document);
    if (info) {
      for (const key of [...info.keys()]) {
        info.delete(key);
        removedInfoKeys += 1;
      }
    }
    const xmpRemoved = dropXmp(document);
    dropPieceInfo(document);

    const bytes = await document.save({ useObjectStreams: true });
    return { bytes, removedInfoKeys, xmpRemoved };
  } catch (error) {
    throw toPdfError(error);
  }
}

/** ¿Hay algun metadato que mostrar o quitar? (Para habilitar «Eliminar todos».) */
export function hasAnyMetadata(info: PdfMetadataInfo): boolean {
  return (
    TEXT_FIELDS.some((field) => info[field].length > 0) ||
    info.creationDate !== null ||
    info.modificationDate !== null ||
    info.hasXmp ||
    info.customKeys.length > 0
  );
}
