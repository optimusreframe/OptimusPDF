/**
 * Lecturas con pdf-lib que pdf.js no da (o no da de forma fiable) sobre las anotaciones de cada pagina: si un campo de
 * firma `/Sig` trae valor `/V` (firma digital), la anotacion `/Subtype /Watermark` y que contiene la apariencia `/AP /N`
 * (texto, trazos, imagen o nada). Todo es lectura: no se escribe nada y los errores se tragan (un PDF raro no rompe el resto).
 *
 * Las anotaciones se enlazan con las de pdf.js por el numero de objeto (`id` «13R» de pdf.js = objeto 13 generacion 0).
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFNull,
  PDFRawStream,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
  type PDFObject,
} from "@cantoo/pdf-lib";

export type AppearanceInfo = {
  /** Hay `/AP /N` con flujo. */
  present: boolean;
  /** El flujo no pinta nada (solo `q Q`, vacio o sin operadores de pintura). */
  empty: boolean;
  /** Usa operadores de texto (`BT … Tj/TJ`). */
  hasText: boolean;
  /** Dibuja trazos o rellenos (`l`, `c`, `S`, `f`…). */
  hasPaths: boolean;
  /** Numero aproximado de segmentos de curva y recta (distingue un garabato de una caja). */
  pathSegments: number;
  /** Pinta una imagen (XObject Image), tambien dentro de un Form anidado. */
  hasImage: boolean;
};

export type PdfLibAnnotation = {
  pageIndex: number;
  objectNumber: number;
  subtype: string;
  /** `FT` del campo (heredado), p. ej. `Sig`. */
  fieldType?: string;
  fieldName?: string;
  /** `/Name` de un sello (icono estandar: «Approved», «Draft»…). */
  stampName?: string;
  /** `/Contents` (recortado a 120 caracteres). */
  contents?: string;
  /** El campo (heredado) tiene `/V` que no es nulo. */
  hasValue: boolean;
  appearance: AppearanceInfo;
};

/** Por encima de este tamano no se carga pdf-lib solo para leer anotaciones (memoria en moviles). */
export const MAX_PDFLIB_BYTES = 60 * 1024 * 1024;

const EMPTY_APPEARANCE: AppearanceInfo = { present: false, empty: true, hasText: false, hasPaths: false, pathSegments: 0, hasImage: false };
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_FORM_DEPTH = 3;

function name(value: string): PDFName {
  return PDFName.of(value);
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return out;
}

function streamText(stream: PDFStream): string | null {
  try {
    if (stream instanceof PDFRawStream) {
      const decoded = decodePDFRawStream(stream).decode();
      return latin1(decoded.length > MAX_STREAM_BYTES ? decoded.subarray(0, MAX_STREAM_BYTES) : decoded);
    }
    const contents = (stream as unknown as { getContents?: () => Uint8Array }).getContents?.();
    return contents ? latin1(contents.length > MAX_STREAM_BYTES ? contents.subarray(0, MAX_STREAM_BYTES) : contents) : null;
  } catch {
    return null;
  }
}

/** Mira el contenido de un flujo de apariencia (y, hasta cierta profundidad, de los Form XObjects que dibuja). */
function inspectStream(stream: PDFStream, depth: number): AppearanceInfo {
  const text = streamText(stream);
  if (text === null) return { ...EMPTY_APPEARANCE, present: true, empty: false };
  const hasText = /(?:^|\s)BT(?:\s|$)/.test(text) && /(?:Tj|TJ|['"])(?:\s|$)/.test(text);
  const segments = (text.match(/(?:^|\s)(?:l|c|v|y|re)(?=\s|$)/g) ?? []).length;
  const painting = /(?:^|\s)(?:S|s|f|F|f\*|B|b|B\*|b\*|sh|BI)(?=\s|$)/.test(text);
  let hasImage = false;
  let nested: AppearanceInfo | null = null;
  const draws = text.match(/\/[^\s/[\]()<>]+\s+Do(?=\s|$)/g) ?? [];
  if (draws.length > 0 && depth < MAX_FORM_DEPTH) {
    const resources = stream.dict.lookup(name("Resources"));
    const xobjects = resources instanceof PDFDict ? resources.lookup(name("XObject")) : undefined;
    if (xobjects instanceof PDFDict) {
      for (const draw of draws) {
        const key = draw.replace(/\s+Do$/, "").slice(1);
        const target = xobjects.lookup(PDFName.of(key));
        if (!(target instanceof PDFStream)) continue;
        const subtype = target.dict.lookup(name("Subtype"));
        if (subtype instanceof PDFName && subtype.decodeText() === "Image") {
          hasImage = true;
        } else {
          const inner = inspectStream(target, depth + 1);
          nested = nested
            ? {
                present: true,
                empty: nested.empty && inner.empty,
                hasText: nested.hasText || inner.hasText,
                hasPaths: nested.hasPaths || inner.hasPaths,
                pathSegments: nested.pathSegments + inner.pathSegments,
                hasImage: nested.hasImage || inner.hasImage,
              }
            : inner;
        }
      }
    }
  }
  const own: AppearanceInfo = {
    present: true,
    empty: !hasText && !painting && !hasImage && draws.length === 0,
    hasText,
    hasPaths: painting && segments > 0,
    pathSegments: segments,
    hasImage,
  };
  if (!nested) return own;
  return {
    present: true,
    empty: own.empty && nested.empty,
    hasText: own.hasText || nested.hasText,
    hasPaths: own.hasPaths || nested.hasPaths,
    pathSegments: own.pathSegments + nested.pathSegments,
    hasImage: own.hasImage || nested.hasImage,
  };
}

/** Informacion de la apariencia normal `/AP /N` de una anotacion (con `/AS` si `N` es un diccionario de estados). */
export function inspectAppearance(annotation: PDFDict): AppearanceInfo {
  try {
    const ap = annotation.lookup(name("AP"));
    if (!(ap instanceof PDFDict)) return EMPTY_APPEARANCE;
    const normal = ap.lookup(name("N"));
    if (normal instanceof PDFStream) return inspectStream(normal, 0);
    if (normal instanceof PDFDict) {
      const state = annotation.lookup(name("AS"));
      const wanted = state instanceof PDFName ? normal.lookup(state) : undefined;
      const candidate = wanted instanceof PDFStream ? wanted : normal.values().map((value) => normal.context.lookup(value)).find((value) => value instanceof PDFStream);
      if (candidate instanceof PDFStream) return inspectStream(candidate, 0);
    }
  } catch {
    // Apariencia danada: se trata como ausente.
  }
  return EMPTY_APPEARANCE;
}

function inherited(dict: PDFDict, key: PDFName): PDFObject | undefined {
  let current: PDFDict | undefined = dict;
  for (let depth = 0; current && depth < 10; depth += 1) {
    const value = current.lookup(key);
    if (value !== undefined && value !== PDFNull) return value;
    const parent: PDFObject | undefined = current.lookup(name("Parent"));
    current = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

function textOf(value: PDFObject | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value as unknown as { decodeText?: () => string };
  try {
    return typeof candidate.decodeText === "function" ? candidate.decodeText() : undefined;
  } catch {
    return undefined;
  }
}

/** Resultado de `indexPdfLibAnnotations`: por pagina (0-based) y numero de objeto. */
export type PdfLibAnnotationIndex = {
  find(pageIndex: number, objectNumber: number): PdfLibAnnotation | undefined;
  /** Todas las anotaciones de la pagina, en orden del arreglo `/Annots`. */
  forPage(pageIndex: number): PdfLibAnnotation[];
  readonly loaded: boolean;
};

export const EMPTY_INDEX: PdfLibAnnotationIndex = {
  find: () => undefined,
  forPage: () => [],
  loaded: false,
};

/**
 * Recorre `/Annots` de las paginas pedidas. Si el PDF no se puede abrir con pdf-lib (cifrado, danado, demasiado grande) devuelve un
 * indice vacio con `loaded: false`: el motor sigue con lo que de pdf.js.
 */
export async function indexPdfLibAnnotations(bytes: Uint8Array | undefined, pageIndices: readonly number[]): Promise<PdfLibAnnotationIndex> {
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > MAX_PDFLIB_BYTES) return EMPTY_INDEX;
  let document: PDFDocument;
  try {
    document = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return EMPTY_INDEX;
  }
  const byPage = new Map<number, PdfLibAnnotation[]>();
  const pages = document.getPages();
  for (const pageIndex of pageIndices) {
    const page = pages[pageIndex];
    if (!page) continue;
    const list: PdfLibAnnotation[] = [];
    byPage.set(pageIndex, list);
    try {
      const annots = page.node.lookup(name("Annots"));
      if (!(annots instanceof PDFArray)) continue;
      for (let i = 0; i < annots.size(); i += 1) {
        try {
          const raw = annots.get(i);
          if (!(raw instanceof PDFRef)) continue;
          const dict = annots.lookup(i);
          if (!(dict instanceof PDFDict)) continue;
          const subtypeObject = dict.lookup(name("Subtype"));
          const subtype = subtypeObject instanceof PDFName ? subtypeObject.decodeText() : "";
          const ft = subtype === "Widget" ? inherited(dict, name("FT")) : undefined;
          const value = subtype === "Widget" ? inherited(dict, name("V")) : undefined;
          list.push({
            pageIndex,
            objectNumber: raw.objectNumber,
            subtype,
            fieldType: ft instanceof PDFName ? ft.decodeText() : undefined,
            fieldName: textOf(inherited(dict, name("T"))),
            stampName: textOf(dict.lookup(name("Name"))),
            contents: textOf(dict.lookup(name("Contents")))?.slice(0, 120),
            hasValue: value !== undefined && value !== PDFNull,
            appearance: inspectAppearance(dict),
          });
        } catch {
          // Una anotacion mal formada no impide leer las demas.
        }
      }
    } catch {
      // Pagina con `/Annots` ilegible: sin anotaciones para pdf-lib.
    }
  }
  return {
    loaded: true,
    find: (pageIndex, objectNumber) => byPage.get(pageIndex)?.find((item) => item.objectNumber === objectNumber),
    forPage: (pageIndex) => byPage.get(pageIndex) ?? [],
  };
}

/** Numero de objeto de un `id` de anotacion de pdf.js («13R» -> 13); `null` si es sintetico. */
export function objectNumberOfAnnotationId(id: string | undefined): number | null {
  if (!id) return null;
  const match = /^(\d+)R$/.exec(id);
  return match ? Number(match[1]) : null;
}
