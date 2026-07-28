import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFRawStream,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  type PDFObject,
} from "@cantoo/pdf-lib";
import {
  PdfError,
  readFileBytes,
  throwIfAborted,
  toPdfError,
  type ProgressCallback,
} from "@/lib/pdf/core";
import { inspectProtection } from "@/lib/pdf/unlock";

/**
 * Motor de VERIFICACION PDF/A.
 *
 * ALCANCE, dicho sin adornos: esto NO convierte a PDF/A y NO certifica
 * conformidad. Inspecciona la ESTRUCTURA del documento y comprueba los
 * marcadores de los que depende la conformidad PDF/A y que se pueden
 * comprobar de forma barata y fiable en el navegador:
 *
 *  1. Cifrado           -> PDF/A lo prohibe en cualquier parte y nivel.
 *  2. Identificacion XMP -> `pdfaid:part` / `pdfaid:conformance` en el
 *     flujo `/Metadata` del catalogo. Es OBLIGATORIA: sin ella el
 *     documento no es PDF/A aunque cumpla todo lo demas.
 *  3. Fuentes incrustadas -> todas las fuentes usadas deben llevar su
 *     programa de fuente (`/FontFile`, `/FontFile2`, `/FontFile3`).
 *  4. OutputIntent PDF/A -> `/OutputIntents` con `/S /GTS_PDFA1` y un
 *     `/DestOutputProfile` real.
 *  5. Acciones JavaScript -> prohibidas.
 *  6. Archivos incrustados -> prohibidos en PDF/A-1 y PDF/A-2; PDF/A-3
 *     los permite, por eso se gradua segun lo que declare el XMP.
 *
 * Lo que NO se comprueba (y por eso el veredicto nunca dice "conforme",
 * solo "no se ha encontrado ningun incumplimiento"): transparencia,
 * espacios de color por operador de contenido, JBIG2/LZW, mapas ToUnicode
 * completos, estructura logica de PDF/A-1a/2a/3a, XMP extension schemas,
 * anotaciones y sus estados de apariencia, integridad real del perfil
 * ICC... Una certificacion de verdad exige veraPDF; esto es un
 * diagnostico previo honesto, no un sello.
 *
 * El modulo es puro: entra un `File`, sale un objeto de datos. Toda la
 * copia visible vive en `src/app/pdf-to-pdfa/strings.ts`, igual que en
 * `compare.ts`.
 */

/* ------------------------------------------------------------------ *
 * Contrato de salida
 * ------------------------------------------------------------------ */

export type PdfaCheckId =
  | "encryption"
  | "identification"
  | "fonts"
  | "outputIntent"
  | "javascript"
  | "embeddedFiles";

/**
 * - `pass`    -> el marcador esta y es correcto.
 * - `fail`    -> incumplimiento estructural comprobado.
 * - `warn`    -> algo que impide afirmar que cumple, o que solo incumple
 *                en algunas partes de la norma.
 * - `unknown` -> no se pudo comprobar (referencia rota, flujo cifrado).
 *                Nunca se traduce a "cumple".
 */
export type PdfaCheckStatus = "pass" | "fail" | "warn" | "unknown";

/** Motivo concreto; la UI lo convierte en frase segun idioma. */
export type PdfaCheckCode =
  | "encryptionNone"
  | "encryptionStandard"
  | "encryptionUnsupported"
  | "encryptionUnknown"
  | "identificationClaim"
  | "identificationNoStream"
  | "identificationNoClaim"
  | "identificationUnreadable"
  | "fontsNone"
  | "fontsAllEmbedded"
  | "fontsMissing"
  | "fontsUnreadable"
  | "outputIntentValid"
  | "outputIntentNoProfile"
  | "outputIntentForeign"
  | "outputIntentNone"
  | "outputIntentUnreadable"
  | "javascriptNone"
  | "javascriptFound"
  | "javascriptUnreadable"
  | "embeddedFilesNone"
  | "embeddedFilesFound"
  | "embeddedFilesUnreadable";

export type PdfaCheck = {
  id: PdfaCheckId;
  status: PdfaCheckStatus;
  code: PdfaCheckCode;
  /** Cantidad asociada al motivo (fuentes, acciones, adjuntos...). */
  count?: number;
  /** Nombres de apoyo (fuentes sin incrustar), ya recortados. */
  names?: string[];
  /** Dato suelto: manejador de cifrado, identificador del OutputIntent. */
  text?: string;
};

/** Lo que el XMP dice ser, que no es lo mismo que lo que es. */
export type PdfaClaim = {
  /** "1", "2", "3", "4"... tal cual lo declara el documento. */
  part: string;
  /** "A", "B", "U"... o `null` (PDF/A-4 no usa conformance). */
  conformance: string | null;
  /** `pdfaid:rev` de PDF/A-4, si esta. */
  revision: string | null;
};

/**
 * - `notCompliant` -> hay al menos un incumplimiento comprobado.
 * - `inconclusive` -> nada comprobadamente roto, pero queda algo sin
 *   verificar (aviso o lectura imposible).
 * - `noIssuesFound` -> todas las comprobaciones de este motor pasan. NO
 *   significa "certificado PDF/A".
 */
export type PdfaVerdict = "noIssuesFound" | "inconclusive" | "notCompliant";

export type PdfaReport = {
  fileName: string;
  fileSize: number;
  /** 0 si el arbol de paginas no se pudo recorrer. */
  pageCount: number;
  /** "1.4", "1.7", "2.0"... leido de la cabecera; `null` si no aparece. */
  pdfVersion: string | null;
  claim: PdfaClaim | null;
  checks: PdfaCheck[];
  verdict: PdfaVerdict;
  failed: number;
  warnings: number;
  unknowns: number;
  passed: number;
  /** ISO 8601, para el informe descargable. */
  checkedAt: string;
};

/* ------------------------------------------------------------------ *
 * Claves PDF
 * ------------------------------------------------------------------ */

const TYPE_KEY = PDFName.of("Type");
const SUBTYPE_KEY = PDFName.of("Subtype");
const RESOURCES_KEY = PDFName.of("Resources");
const FONT_KEY = PDFName.of("Font");
const XOBJECT_KEY = PDFName.of("XObject");
const PATTERN_KEY = PDFName.of("Pattern");
const BASE_FONT_KEY = PDFName.of("BaseFont");
const DESCENDANT_FONTS_KEY = PDFName.of("DescendantFonts");
const FONT_DESCRIPTOR_KEY = PDFName.of("FontDescriptor");
const FONT_FILE_KEYS = [
  PDFName.of("FontFile"),
  PDFName.of("FontFile2"),
  PDFName.of("FontFile3"),
];
const ANNOTS_KEY = PDFName.of("Annots");
const AP_KEY = PDFName.of("AP");
const N_KEY = PDFName.of("N");
const A_KEY = PDFName.of("A");
const AA_KEY = PDFName.of("AA");
const OPEN_ACTION_KEY = PDFName.of("OpenAction");
const NAMES_KEY = PDFName.of("Names");
const KIDS_KEY = PDFName.of("Kids");
const JAVASCRIPT_KEY = PDFName.of("JavaScript");
const EMBEDDED_FILES_KEY = PDFName.of("EmbeddedFiles");
const EF_KEY = PDFName.of("EF");
const S_KEY = PDFName.of("S");
const METADATA_KEY = PDFName.of("Metadata");
const OUTPUT_INTENTS_KEY = PDFName.of("OutputIntents");
const DEST_OUTPUT_PROFILE_KEY = PDFName.of("DestOutputProfile");
const OUTPUT_CONDITION_ID_KEY = PDFName.of("OutputConditionIdentifier");

/** `PDFName.asString()` incluye la barra: "/Type0". */
const TYPE0 = "/Type0";
const TYPE3 = "/Type3";
const FILESPEC_TYPE = "/Filespec";
const JAVASCRIPT_ACTION = "/JavaScript";
const FORM_XOBJECT = "/Form";
/** Todas las partes de PDF/A usan el mismo subtipo de OutputIntent. */
const PDFA_OUTPUT_INTENT_PREFIX = "/GTS_PDFA";

/** Tope de recursion en recursos anidados y arboles de nombres. */
const MAX_DEPTH = 24;
/** Nombres de fuente que se listan en el informe antes de resumir. */
const MAX_LISTED_FONTS = 12;

/* ------------------------------------------------------------------ *
 * Lecturas estrictas
 *
 * Mismo criterio que `unlock.ts`: "la clave no esta" y "la clave esta
 * pero no se pudo resolver" son cosas distintas. La segunda nunca se
 * interpreta como ausencia; sube como `unknown` al informe.
 * ------------------------------------------------------------------ */

type Resolved<T extends PDFObject> =
  | { status: "absent" }
  | { status: "value"; value: T }
  | { status: "broken" };

function resolveStrict<T extends PDFObject>(
  dict: PDFDict,
  key: PDFName,
  isType: (object: PDFObject) => object is T,
): Resolved<T> {
  if (!dict.has(key)) return { status: "absent" };

  let resolved: PDFObject | undefined;
  try {
    resolved = dict.context.lookup(dict.get(key));
  } catch {
    return { status: "broken" };
  }

  if (resolved === undefined) return { status: "broken" };
  if (resolved === PDFNull) return { status: "absent" };
  return isType(resolved)
    ? { status: "value", value: resolved }
    : { status: "broken" };
}

const isPDFDict = (object: PDFObject): object is PDFDict =>
  object instanceof PDFDict;
const isPDFArray = (object: PDFObject): object is PDFArray =>
  object instanceof PDFArray;
const isPDFStream = (object: PDFObject): object is PDFStream =>
  object instanceof PDFStream;

function dictAt(dict: PDFDict, key: PDFName): Resolved<PDFDict> {
  return resolveStrict(dict, key, isPDFDict);
}

function arrayAt(dict: PDFDict, key: PDFName): Resolved<PDFArray> {
  return resolveStrict(dict, key, isPDFArray);
}

function streamAt(dict: PDFDict, key: PDFName): Resolved<PDFStream> {
  return resolveStrict(dict, key, isPDFStream);
}

/** Nombre tolerante: su ausencia ya tiene un valor por defecto seguro. */
function nameAt(dict: PDFDict, key: PDFName): string | undefined {
  try {
    return dict.lookupMaybe(key, PDFName)?.asString();
  } catch {
    return undefined;
  }
}

/** Texto tolerante (`/OutputConditionIdentifier`), solo informativo. */
function textAt(dict: PDFDict, key: PDFName): string | undefined {
  try {
    const value = dict.lookupMaybe(key, PDFString, PDFHexString);
    return value?.decodeText();
  } catch {
    return undefined;
  }
}

/** Resuelve un elemento de array como diccionario, sin lanzar. */
function dictAtIndex(array: PDFArray, index: number): PDFDict | undefined {
  try {
    const value = array.lookup(index);
    return value instanceof PDFDict ? value : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 1. Cifrado
 *
 * Se reutiliza `inspectProtection` de `unlock.ts`, que es la unica
 * autoridad del repo sobre "esto esta cifrado y con que manejador". No
 * se vuelve a implementar aqui la lectura de `/Encrypt`.
 * ------------------------------------------------------------------ */

type EncryptionOutcome = { check: PdfaCheck; encrypted: boolean };

async function checkEncryption(file: File): Promise<EncryptionOutcome> {
  let inspection: Awaited<ReturnType<typeof inspectProtection>>;
  try {
    inspection = await inspectProtection(file);
  } catch {
    // `inspectProtection` falla cerrado ante estructuras que no puede
    // comprobar. Aqui eso no es un error del flujo: es una casilla que
    // se queda sin verificar.
    return {
      check: { id: "encryption", status: "unknown", code: "encryptionUnknown" },
      encrypted: false,
    };
  }

  if (inspection.kind === "unsupported") {
    return {
      check: {
        id: "encryption",
        status: "fail",
        code: "encryptionUnsupported",
        text: inspection.encryption.securityHandler ?? undefined,
      },
      encrypted: true,
    };
  }

  if (inspection.kind === "passwordRequired") {
    return {
      check: {
        id: "encryption",
        status: "fail",
        code: "encryptionStandard",
        text: inspection.encryption.securityHandler ?? undefined,
      },
      encrypted: true,
    };
  }

  // kind === "ready": puede seguir estando cifrado con contrasena vacia,
  // que para PDF/A es exactamente igual de prohibido.
  if (inspection.profile.encrypted) {
    return {
      check: {
        id: "encryption",
        status: "fail",
        code: "encryptionStandard",
        text: inspection.profile.securityHandler ?? undefined,
      },
      encrypted: true,
    };
  }

  return {
    check: { id: "encryption", status: "pass", code: "encryptionNone" },
    encrypted: false,
  };
}

/* ------------------------------------------------------------------ *
 * 2. Identificacion PDF/A en el XMP
 * ------------------------------------------------------------------ */

const PDFA_ID_NAMESPACE = "http://www.aiim.org/pdfa/ns/id/";

/**
 * Extrae `part`, `conformance` y `rev` del XMP. Acepta las dos formas
 * validas de RDF (atributo y elemento) y no da por hecho el prefijo
 * `pdfaid`: primero busca que prefijo esta ligado al namespace oficial.
 */
export function parsePdfaClaim(xmp: string): PdfaClaim | null {
  const bound = new RegExp(
    `xmlns:([A-Za-z_][\\w.-]*)\\s*=\\s*["']${PDFA_ID_NAMESPACE.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    )}["']`,
  ).exec(xmp);
  const prefix = bound?.[1] ?? "pdfaid";

  const read = (field: string): string | null => {
    const asAttribute = new RegExp(
      `${prefix}:${field}\\s*=\\s*["']([^"']+)["']`,
    ).exec(xmp);
    if (asAttribute) return asAttribute[1].trim();
    const asElement = new RegExp(
      `<${prefix}:${field}[^>]*>([\\s\\S]*?)</${prefix}:${field}>`,
    ).exec(xmp);
    if (asElement) {
      const inner = asElement[1].replace(/<[^>]*>/g, "").trim();
      if (inner.length > 0) return inner;
    }
    return null;
  };

  const part = read("part");
  if (!part) return null;
  return {
    part,
    conformance: read("conformance"),
    revision: read("rev"),
  };
}

type IdentificationOutcome = { check: PdfaCheck; claim: PdfaClaim | null };

function decodeMetadataStream(stream: PDFStream): string | null {
  try {
    const bytes =
      stream instanceof PDFRawStream
        ? decodePDFRawStream(stream).decode()
        : stream.getContents();
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return null;
  }
}

function checkIdentification(
  catalog: PDFDict,
  encrypted: boolean,
): IdentificationOutcome {
  const metadata = streamAt(catalog, METADATA_KEY);

  if (metadata.status === "broken") {
    return {
      check: {
        id: "identification",
        status: "unknown",
        code: "identificationUnreadable",
      },
      claim: null,
    };
  }

  if (metadata.status === "absent") {
    return {
      check: {
        id: "identification",
        status: "fail",
        code: "identificationNoStream",
      },
      claim: null,
    };
  }

  if (encrypted) {
    // El flujo existe, pero sus bytes siguen cifrados en esta lectura:
    // afirmar "no declara PDF/A" seria inventarselo.
    return {
      check: {
        id: "identification",
        status: "unknown",
        code: "identificationUnreadable",
      },
      claim: null,
    };
  }

  const xmp = decodeMetadataStream(metadata.value);
  if (xmp === null) {
    return {
      check: {
        id: "identification",
        status: "unknown",
        code: "identificationUnreadable",
      },
      claim: null,
    };
  }

  const claim = parsePdfaClaim(xmp);
  if (!claim) {
    return {
      check: {
        id: "identification",
        status: "fail",
        code: "identificationNoClaim",
      },
      claim: null,
    };
  }

  return {
    check: {
      id: "identification",
      status: "pass",
      code: "identificationClaim",
      text: formatClaim(claim),
    },
    claim,
  };
}

/** "1B" -> "PDF/A-1b"; "4" + rev -> "PDF/A-4". */
export function formatClaim(claim: PdfaClaim): string {
  const level = claim.conformance ? claim.conformance.toLowerCase() : "";
  return `PDF/A-${claim.part}${level}`;
}

/* ------------------------------------------------------------------ *
 * 3. Fuentes incrustadas
 * ------------------------------------------------------------------ */

type FontScan = {
  /** Fuentes distintas encontradas en los recursos recorridos. */
  total: number;
  /** Nombres (sin barra) de las que no llevan programa de fuente. */
  missing: string[];
  /** Alguna referencia no resolvio: no se puede afirmar nada. */
  incomplete: boolean;
};

function baseFontName(font: PDFDict): string {
  const base = nameAt(font, BASE_FONT_KEY);
  if (base) return base.replace(/^\//, "");
  const subtype = nameAt(font, SUBTYPE_KEY);
  return subtype ? subtype.replace(/^\//, "") : "";
}

/** `true` si el descriptor lleva `/FontFile`, `/FontFile2` o `/FontFile3`. */
function descriptorHasProgram(
  descriptor: PDFDict,
  scan: FontScan,
): boolean {
  for (const key of FONT_FILE_KEYS) {
    const file = streamAt(descriptor, key);
    if (file.status === "value") return true;
    if (file.status === "broken") scan.incomplete = true;
  }
  return false;
}

function fontIsEmbedded(font: PDFDict, scan: FontScan): boolean {
  const subtype = nameAt(font, SUBTYPE_KEY);

  // Las Type3 definen sus glifos con flujos de contenido dentro del
  // propio documento: no hay nada externo que incrustar y PDF/A las
  // admite. No se cuentan como fuente sin incrustar.
  if (subtype === TYPE3) return true;

  if (subtype === TYPE0) {
    const descendants = arrayAt(font, DESCENDANT_FONTS_KEY);
    if (descendants.status !== "value") {
      scan.incomplete = descendants.status === "broken";
      return false;
    }
    for (let index = 0; index < descendants.value.size(); index += 1) {
      const cid = dictAtIndex(descendants.value, index);
      if (!cid) {
        scan.incomplete = true;
        continue;
      }
      const descriptor = dictAt(cid, FONT_DESCRIPTOR_KEY);
      if (descriptor.status === "broken") {
        scan.incomplete = true;
        return false;
      }
      if (descriptor.status === "absent") return false;
      if (!descriptorHasProgram(descriptor.value, scan)) return false;
    }
    return descendants.value.size() > 0;
  }

  const descriptor = dictAt(font, FONT_DESCRIPTOR_KEY);
  if (descriptor.status === "broken") {
    scan.incomplete = true;
    return false;
  }
  // Sin `/FontDescriptor` es una de las 14 fuentes estandar: el lector
  // la toma de su propio sistema. PDF/A no lo permite.
  if (descriptor.status === "absent") return false;
  return descriptorHasProgram(descriptor.value, scan);
}

type ResourceWalker = {
  scan: FontScan;
  seenResources: Set<PDFDict>;
  seenFonts: Set<PDFDict>;
  missing: Set<string>;
};

function walkFontDictionary(fonts: PDFDict, walker: ResourceWalker): void {
  for (const key of fonts.keys()) {
    const font = dictAt(fonts, key);
    if (font.status === "broken") {
      walker.scan.incomplete = true;
      continue;
    }
    if (font.status === "absent") continue;
    if (walker.seenFonts.has(font.value)) continue;
    walker.seenFonts.add(font.value);
    walker.scan.total += 1;
    if (!fontIsEmbedded(font.value, walker.scan)) {
      walker.missing.add(baseFontName(font.value));
    }
  }
}

/** Recursos anidados: XObjects de formulario y patrones de mosaico. */
function walkNestedStreams(
  container: PDFDict,
  walker: ResourceWalker,
  depth: number,
  onlyForms: boolean,
): void {
  for (const key of container.keys()) {
    const entry = resolveStrict(
      container,
      key,
      (object): object is PDFStream | PDFDict =>
        object instanceof PDFStream || object instanceof PDFDict,
    );
    if (entry.status === "broken") {
      walker.scan.incomplete = true;
      continue;
    }
    if (entry.status === "absent") continue;

    const dict =
      entry.value instanceof PDFStream ? entry.value.dict : entry.value;
    if (onlyForms && nameAt(dict, SUBTYPE_KEY) !== FORM_XOBJECT) continue;

    const nested = dictAt(dict, RESOURCES_KEY);
    if (nested.status === "broken") {
      walker.scan.incomplete = true;
      continue;
    }
    if (nested.status === "value") {
      walkResources(nested.value, walker, depth + 1);
    }
  }
}

function walkResources(
  resources: PDFDict,
  walker: ResourceWalker,
  depth: number,
): void {
  if (depth > MAX_DEPTH) {
    walker.scan.incomplete = true;
    return;
  }
  if (walker.seenResources.has(resources)) return;
  walker.seenResources.add(resources);

  const fonts = dictAt(resources, FONT_KEY);
  if (fonts.status === "broken") walker.scan.incomplete = true;
  if (fonts.status === "value") walkFontDictionary(fonts.value, walker);

  const xobjects = dictAt(resources, XOBJECT_KEY);
  if (xobjects.status === "broken") walker.scan.incomplete = true;
  if (xobjects.status === "value") {
    walkNestedStreams(xobjects.value, walker, depth, true);
  }

  const patterns = dictAt(resources, PATTERN_KEY);
  if (patterns.status === "broken") walker.scan.incomplete = true;
  if (patterns.status === "value") {
    walkNestedStreams(patterns.value, walker, depth, false);
  }
}

/** Apariencias de anotacion: tambien pintan texto y tambien cuentan. */
function walkAnnotationAppearances(
  page: PDFDict,
  walker: ResourceWalker,
): void {
  const annots = arrayAt(page, ANNOTS_KEY);
  if (annots.status === "broken") {
    walker.scan.incomplete = true;
    return;
  }
  if (annots.status === "absent") return;

  for (let index = 0; index < annots.value.size(); index += 1) {
    const annot = dictAtIndex(annots.value, index);
    if (!annot) {
      walker.scan.incomplete = true;
      continue;
    }
    const ap = dictAt(annot, AP_KEY);
    if (ap.status === "broken") {
      walker.scan.incomplete = true;
      continue;
    }
    if (ap.status === "absent") continue;

    const normal = resolveStrict(
      ap.value,
      N_KEY,
      (object): object is PDFStream | PDFDict =>
        object instanceof PDFStream || object instanceof PDFDict,
    );
    if (normal.status === "broken") {
      walker.scan.incomplete = true;
      continue;
    }
    if (normal.status === "absent") continue;

    if (normal.value instanceof PDFStream) {
      const nested = dictAt(normal.value.dict, RESOURCES_KEY);
      if (nested.status === "broken") walker.scan.incomplete = true;
      if (nested.status === "value") walkResources(nested.value, walker, 1);
      continue;
    }
    // Diccionario de estados ("/Off", "/On"...): cada uno es un flujo.
    walkNestedStreams(normal.value, walker, 1, false);
  }
}

async function checkFonts(
  document: PDFDocument,
  onProgress: ProgressCallback | undefined,
  signal: AbortSignal | undefined,
  from: number,
  to: number,
): Promise<{ check: PdfaCheck; pageCount: number }> {
  const scan: FontScan = { total: 0, missing: [], incomplete: false };
  const walker: ResourceWalker = {
    scan,
    seenResources: new Set(),
    seenFonts: new Set(),
    missing: new Set(),
  };

  let pages: ReturnType<PDFDocument["getPages"]>;
  try {
    pages = document.getPages();
  } catch {
    return {
      check: { id: "fonts", status: "unknown", code: "fontsUnreadable" },
      pageCount: 0,
    };
  }

  for (let index = 0; index < pages.length; index += 1) {
    throwIfAborted(signal);
    const node = pages[index].node;
    let resources: PDFDict | undefined;
    try {
      resources = node.Resources();
    } catch {
      scan.incomplete = true;
    }
    if (resources) walkResources(resources, walker, 0);
    walkAnnotationAppearances(node, walker);
    onProgress?.(from + ((index + 1) / pages.length) * (to - from));
    // Un respiro cada 25 paginas para no congelar la pestana.
    if (index % 25 === 24) await Promise.resolve();
  }

  scan.missing = [...walker.missing];

  if (scan.incomplete) {
    return {
      check: { id: "fonts", status: "unknown", code: "fontsUnreadable" },
      pageCount: pages.length,
    };
  }
  if (scan.total === 0) {
    return {
      check: { id: "fonts", status: "pass", code: "fontsNone" },
      pageCount: pages.length,
    };
  }
  if (scan.missing.length > 0) {
    return {
      check: {
        id: "fonts",
        status: "fail",
        code: "fontsMissing",
        count: scan.missing.length,
        names: scan.missing.slice(0, MAX_LISTED_FONTS),
      },
      pageCount: pages.length,
    };
  }
  return {
    check: {
      id: "fonts",
      status: "pass",
      code: "fontsAllEmbedded",
      count: scan.total,
    },
    pageCount: pages.length,
  };
}

/* ------------------------------------------------------------------ *
 * 4. OutputIntent
 * ------------------------------------------------------------------ */

function checkOutputIntent(catalog: PDFDict, claim: PdfaClaim | null): PdfaCheck {
  const intents = arrayAt(catalog, OUTPUT_INTENTS_KEY);
  if (intents.status === "broken") {
    return {
      id: "outputIntent",
      status: "unknown",
      code: "outputIntentUnreadable",
    };
  }

  // Sin OutputIntent el documento solo puede ser PDF/A si todo su color
  // es independiente del dispositivo, cosa que este motor no comprueba.
  // Si el propio documento dice ser PDF/A, la ausencia si es un fallo.
  const noneStatus: PdfaCheckStatus = claim ? "fail" : "warn";

  if (intents.status === "absent" || intents.value.size() === 0) {
    return { id: "outputIntent", status: noneStatus, code: "outputIntentNone" };
  }

  let foreign = 0;
  let unreadable = false;

  for (let index = 0; index < intents.value.size(); index += 1) {
    const intent = dictAtIndex(intents.value, index);
    if (!intent) {
      unreadable = true;
      continue;
    }
    const subtype = nameAt(intent, S_KEY) ?? "";
    if (!subtype.startsWith(PDFA_OUTPUT_INTENT_PREFIX)) {
      foreign += 1;
      continue;
    }
    const profile = streamAt(intent, DEST_OUTPUT_PROFILE_KEY);
    if (profile.status === "broken") {
      unreadable = true;
      continue;
    }
    if (profile.status === "absent") {
      return {
        id: "outputIntent",
        status: "fail",
        code: "outputIntentNoProfile",
      };
    }
    return {
      id: "outputIntent",
      status: "pass",
      code: "outputIntentValid",
      text: textAt(intent, OUTPUT_CONDITION_ID_KEY) ?? subtype.replace(/^\//, ""),
    };
  }

  if (unreadable) {
    return {
      id: "outputIntent",
      status: "unknown",
      code: "outputIntentUnreadable",
    };
  }
  return {
    id: "outputIntent",
    status: noneStatus,
    code: "outputIntentForeign",
    count: foreign,
  };
}

/* ------------------------------------------------------------------ *
 * 5 y 6. Acciones JavaScript y archivos incrustados
 *
 * Doble barrido con un mismo conjunto de vistos: el arbol de nombres y
 * los puntos de enganche habituales (que pueden llevar diccionarios en
 * linea, invisibles para la enumeracion), mas un recorrido de todos los
 * objetos indirectos (que atrapa lo que cuelga de sitios que este motor
 * no visita). Compartir `seen` evita contar dos veces lo mismo.
 * ------------------------------------------------------------------ */

type ActionScan = {
  javascript: Set<PDFDict>;
  attachments: Set<PDFDict>;
  /**
   * Si el barrido de refuerzo (todos los objetos indirectos) fallo, un
   * conteo en 0 solo refleja los puntos de enganche explicitos ya
   * recorridos, no el documento completo: no alcanza para decir "pass".
   */
  complete: boolean;
};

function isJavaScriptAction(dict: PDFDict): boolean {
  return nameAt(dict, S_KEY) === JAVASCRIPT_ACTION;
}

function isFileSpecification(dict: PDFDict): boolean {
  if (!dict.has(EF_KEY)) return false;
  const type = nameAt(dict, TYPE_KEY);
  return type === undefined || type === FILESPEC_TYPE;
}

function classify(dict: PDFDict, scan: ActionScan): void {
  if (isJavaScriptAction(dict)) scan.javascript.add(dict);
  if (isFileSpecification(dict)) scan.attachments.add(dict);
}

/** Recorre un arbol de nombres (`/Names` + `/Kids`) clasificando hojas. */
function walkNameTree(node: PDFDict, scan: ActionScan, depth: number): void {
  if (depth > MAX_DEPTH) return;

  const names = arrayAt(node, NAMES_KEY);
  if (names.status === "value") {
    // El array alterna clave (cadena) y valor.
    for (let index = 1; index < names.value.size(); index += 2) {
      const value = dictAtIndex(names.value, index);
      if (value) classify(value, scan);
    }
  }

  const kids = arrayAt(node, KIDS_KEY);
  if (kids.status === "value") {
    for (let index = 0; index < kids.value.size(); index += 1) {
      const kid = dictAtIndex(kids.value, index);
      if (kid) walkNameTree(kid, scan, depth + 1);
    }
  }
}

function scanActions(document: PDFDocument, catalog: PDFDict): ActionScan {
  const scan: ActionScan = {
    javascript: new Set(),
    attachments: new Set(),
    complete: true,
  };

  const names = dictAt(catalog, NAMES_KEY);
  if (names.status === "value") {
    const js = dictAt(names.value, JAVASCRIPT_KEY);
    if (js.status === "value") walkNameTree(js.value, scan, 0);
    const files = dictAt(names.value, EMBEDDED_FILES_KEY);
    if (files.status === "value") walkNameTree(files.value, scan, 0);
  }

  for (const key of [OPEN_ACTION_KEY, AA_KEY, A_KEY]) {
    const entry = dictAt(catalog, key);
    if (entry.status === "value") {
      classify(entry.value, scan);
      // `/AA` es un diccionario de disparadores; cada valor es la accion.
      for (const trigger of entry.value.keys()) {
        const action = dictAt(entry.value, trigger);
        if (action.status === "value") classify(action.value, scan);
      }
    }
  }

  try {
    for (const [, object] of document.context.enumerateIndirectObjects()) {
      if (object instanceof PDFDict) {
        classify(object, scan);
      } else if (object instanceof PDFStream) {
        classify(object.dict, scan);
      }
    }
  } catch {
    // La enumeracion es el barrido de refuerzo: si falla, un conteo en 0
    // ya no significa "no hay" -- significa "no se pudo mirar el resto
    // del documento". Marcarlo incompleto evita un "pass" de confianza
    // sobre datos parciales.
    scan.complete = false;
  }

  return scan;
}

function checkJavaScript(scan: ActionScan): PdfaCheck {
  const count = scan.javascript.size;
  if (count > 0) {
    return { id: "javascript", status: "fail", code: "javascriptFound", count };
  }
  if (!scan.complete) {
    return { id: "javascript", status: "unknown", code: "javascriptUnreadable" };
  }
  return { id: "javascript", status: "pass", code: "javascriptNone" };
}

function checkEmbeddedFiles(scan: ActionScan, claim: PdfaClaim | null): PdfaCheck {
  const count = scan.attachments.size;
  if (count === 0) {
    if (!scan.complete) {
      return {
        id: "embeddedFiles",
        status: "unknown",
        code: "embeddedFilesUnreadable",
      };
    }
    return { id: "embeddedFiles", status: "pass", code: "embeddedFilesNone" };
  }
  // PDF/A-3 y PDF/A-4 admiten adjuntos; PDF/A-1 y PDF/A-2 no. Sin
  // declaracion no se sabe contra que parte medirlo: aviso.
  const forbidden = claim?.part === "1" || claim?.part === "2";
  return {
    id: "embeddedFiles",
    status: forbidden ? "fail" : "warn",
    code: "embeddedFilesFound",
    count,
  };
}

/* ------------------------------------------------------------------ *
 * Version de la cabecera
 * ------------------------------------------------------------------ */

export function readPdfVersion(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
  const match = /%PDF-(\d+\.\d+)/.exec(head);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ *
 * API publica
 * ------------------------------------------------------------------ */

/** Orden fijo del informe, de lo mas eliminatorio a lo mas matizable. */
const CHECK_ORDER: PdfaCheckId[] = [
  "identification",
  "fonts",
  "outputIntent",
  "encryption",
  "javascript",
  "embeddedFiles",
];

export function summarize(checks: PdfaCheck[]): {
  verdict: PdfaVerdict;
  failed: number;
  warnings: number;
  unknowns: number;
  passed: number;
} {
  const failed = checks.filter((check) => check.status === "fail").length;
  const warnings = checks.filter((check) => check.status === "warn").length;
  const unknowns = checks.filter((check) => check.status === "unknown").length;
  const passed = checks.filter((check) => check.status === "pass").length;
  const verdict: PdfaVerdict =
    failed > 0
      ? "notCompliant"
      : unknowns > 0 || warnings > 0
        ? "inconclusive"
        : "noIssuesFound";
  return { verdict, failed, warnings, unknowns, passed };
}

/**
 * Inspecciona un PDF y devuelve el informe de marcadores PDF/A.
 *
 * No modifica ni produce ningun archivo. Lanza `PdfError` solo cuando el
 * documento no se puede ni abrir (vacio, corrupto) o cuando el usuario
 * cancela; todo lo demas se cuenta como resultado de una casilla.
 */
export async function checkPdfaCompliance(
  file: File,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<PdfaReport> {
  throwIfAborted(signal);
  const bytes = await readFileBytes(file);
  if (bytes.byteLength === 0) throw new PdfError("corrupt");
  onProgress?.(0.05);

  let document: PDFDocument;
  try {
    // `ignoreEncryption` permite leer la estructura de un documento
    // cifrado: su cifrado ya se evalua aparte y es motivo de fallo.
    document = await PDFDocument.load(new Uint8Array(bytes), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch (error) {
    throw toPdfError(error);
  }
  throwIfAborted(signal);
  onProgress?.(0.2);

  const catalog = document.catalog;
  const encryption = await checkEncryption(file);
  throwIfAborted(signal);
  onProgress?.(0.35);

  const identification = checkIdentification(catalog, encryption.encrypted);
  onProgress?.(0.45);

  const fonts = await checkFonts(document, onProgress, signal, 0.45, 0.8);
  throwIfAborted(signal);

  const outputIntent = checkOutputIntent(catalog, identification.claim);
  onProgress?.(0.85);

  const actions = scanActions(document, catalog);
  throwIfAborted(signal);
  const javascript = checkJavaScript(actions);
  const embeddedFiles = checkEmbeddedFiles(actions, identification.claim);
  onProgress?.(0.98);

  const byId = new Map<PdfaCheckId, PdfaCheck>([
    [encryption.check.id, encryption.check],
    [identification.check.id, identification.check],
    [fonts.check.id, fonts.check],
    [outputIntent.id, outputIntent],
    [javascript.id, javascript],
    [embeddedFiles.id, embeddedFiles],
  ]);
  const checks = CHECK_ORDER.map((id) => byId.get(id)).filter(
    (check): check is PdfaCheck => check !== undefined,
  );

  const totals = summarize(checks);
  onProgress?.(1);

  return {
    fileName: file.name,
    fileSize: file.size,
    pageCount: fonts.pageCount,
    pdfVersion: readPdfVersion(bytes),
    claim: identification.claim,
    checks,
    checkedAt: new Date().toISOString(),
    ...totals,
  };
}
