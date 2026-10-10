import type { FontFamilyKind, SourceFontInfo } from "@/lib/pdf/editTypes";

/**
 * Lo que se sabe de la fuente ORIGINAL de un bloque de texto, deducido del
 * objeto de fuente que pdf.js deja en `page.commonObjs` tras
 * `getOperatorList()` (antes de eso, `commonObjs.get` lanza
 * "isn't resolved yet").
 *
 * Funcion pura: recibe un objeto con forma de fuente de pdf.js (o `null`
 * cuando no se pudo resolver) y devuelve un `SourceFontInfo`. Nunca lanza:
 * con una fuente rara o ausente devuelve valores neutros (sans, regular).
 *
 * Campos de pdf.js 6.x que se usan (todos opcionales):
 *  - `name`          BaseFont ("ABCDEF+LiberationSans-Bold", "Helvetica"...)
 *  - `fallbackName`  "serif" | "sans-serif" | "monospace" (de los flags del
 *                    FontDescriptor o del nombre; es la senal mas fiable)
 *  - `bold`/`italic`/`black`  solo se rellenan en algunas fuentes (en las
 *                    embebidas suelen venir `undefined`), por eso tambien
 *                    se infieren del nombre
 *  - `missingFile`   true = la fuente NO esta embebida (estandar o sustituida)
 *  - `isType3Font`
 *  - `flags`         (solo si alguna version/opcion lo expone) flags del
 *                    FontDescriptor del PDF
 */
export type PdfJsFontLike = {
  name?: string;
  fallbackName?: string;
  bold?: boolean;
  italic?: boolean;
  black?: boolean;
  missingFile?: boolean;
  isType3Font?: boolean;
  isInvalidPDFjsFont?: boolean;
  flags?: number;
} | null;

/** Prefijo de subconjunto: seis mayusculas y un "+" (ABCDEF+Nombre). */
export const SUBSET_PREFIX = /^[A-Z]{6}\+/;

// Bits del campo /Flags de un FontDescriptor (PDF 32000-1, tabla 123).
const FLAG_FIXED_PITCH = 1 << 0;
const FLAG_SERIF = 1 << 1;
const FLAG_ITALIC = 1 << 6;
const FLAG_FORCE_BOLD = 1 << 18;

const MONO_NAME =
  /courier|consolas|menlo|monaco|lucida\s?console|monospace|typewriter|mono(?!type)|fixed|andale\s?mono|dejavusansmono|inconsolata|source\s?code|firacode|cousine/i;
const SANS_NAME =
  /sans|arial|helvet|calibri|verdana|tahoma|segoe|trebuchet|gothic|roboto|opensans|lato|noto\s?sans|ubuntu|cousine|arimo|liberationsans|myriad|frutiger|futura|gill/i;
const SERIF_NAME =
  /times|serif|georgia|garamond|cambria|palatino|bookman|minion|century|baskerville|didot|caslon|tinos|liberationserif|charter|constantia|rockwell|playfair|merriweather|cmr\d|nimbusrom/i;
const BOLD_NAME = /bold|black|heavy|semibold|demi|extrabold|ultra|\bbd\b|-bd\b/i;
const ITALIC_NAME = /italic|oblique|\bital\b|-it\b|-i\b|slanted|kursiv/i;
/** Fuentes de simbolos/ornamentos: su "texto" no es editable con letras. */
const SYMBOLIC_NAME =
  /(^|[+\-,\s])(symbol|symbolmt|zapfdingbats|dingbats|wingdings\d?|webdings|marlett|opensymbol|mtextra|cmsy\d*|cmmi\d*|cmex\d*|msam\d*|msbm\d*|fontawesome|segoeuisymbol|segoe\s?mdl2)/i;

/**
 * Las 14 fuentes estandar (y sus alias habituales) sin prefijo de
 * subconjunto: no suelen venir embebidas en el PDF.
 */
const STANDARD_14_NAME =
  /^(helvetica|arial|arialmt|times|timesnewroman|timesnewromanps|timesnewromanpsmt|courier|couriernew|couriernewps|couriernewpsmt|symbol|symbolmt|zapfdingbats)([-,\s]|$)/i;

/** Quita el prefijo de subconjunto si lo tiene. */
export function stripSubsetPrefix(name: string): string {
  return name.replace(SUBSET_PREFIX, "");
}

/** Deduce la familia (sans/serif/mono) de la fuente. */
export function inferFamily(
  name: string,
  fallbackName?: string,
  flags?: number,
): FontFamilyKind {
  const bare = stripSubsetPrefix(name);
  // 1) El nombre manda cuando es inequivoco: "Courier New" con flags rotos
  //    sigue siendo monoespaciada.
  if (MONO_NAME.test(bare)) return "mono";
  const sansByName = SANS_NAME.test(bare);
  const serifByName = SERIF_NAME.test(bare) && !sansByName;
  if (serifByName) return "serif";
  if (sansByName) return "sans";
  // 2) Sin pista en el nombre: lo que haya deducido pdf.js.
  if (fallbackName === "monospace") return "mono";
  if (fallbackName === "serif") return "serif";
  if (fallbackName === "sans-serif") return "sans";
  // 3) Ultimo recurso: flags del descriptor, si existen.
  if (typeof flags === "number") {
    if (flags & FLAG_FIXED_PITCH) return "mono";
    if (flags & FLAG_SERIF) return "serif";
  }
  return "sans";
}

/**
 * Construye el `SourceFontInfo` de un objeto de fuente de pdf.js.
 * `fallbackPdfName` se usa si el objeto no trae `name` (p. ej. no se pudo
 * resolver en `commonObjs`): suele ser el `fontName` interno de pdf.js.
 */
export function sourceFontInfoFrom(
  font: PdfJsFontLike | undefined,
  fallbackPdfName = "",
  styleFallback?: string,
): SourceFontInfo {
  const pdfName =
    typeof font?.name === "string" && font.name.length > 0
      ? font.name
      : fallbackPdfName;
  const bare = stripSubsetPrefix(pdfName);
  const flags = typeof font?.flags === "number" ? font.flags : undefined;
  const type3 = font?.isType3Font === true;

  const bold =
    font?.bold === true ||
    font?.black === true ||
    BOLD_NAME.test(bare) ||
    (flags !== undefined && (flags & FLAG_FORCE_BOLD) !== 0);
  const italic =
    font?.italic === true ||
    ITALIC_NAME.test(bare) ||
    (flags !== undefined && (flags & FLAG_ITALIC) !== 0);

  return {
    pdfName,
    family: inferFamily(pdfName, font?.fallbackName ?? styleFallback, flags),
    bold,
    italic,
    subset: SUBSET_PREFIX.test(pdfName),
    // Con `standardFontDataUrl` pdf.js carga una fuente propia y deja
    // `missingFile: false` incluso para Helvetica/Times/Courier sin embeber,
    // asi que una fuente estandar SIN prefijo de subconjunto se da por no
    // embebida. Sin objeto resuelto no sabemos: se asume embebida.
    embedded: type3
      ? true
      : font
        ? font.missingFile !== true &&
          (SUBSET_PREFIX.test(pdfName) ||
            !STANDARD_14_NAME.test(pdfName.replace(/_/g, "")))
        : true,
    // Solo por nombre: los flags "Symbolic" de Word/Chrome se marcan tambien
    // en texto latino normal y darian falsos positivos (ver textBlocks.ts).
    symbolic: SYMBOLIC_NAME.test(pdfName),
    type3,
  };
}

/** Nombre sin prefijo de subconjunto, para comparar fuentes entre bloques. */
export function fontIdentity(info: SourceFontInfo): string {
  return `${stripSubsetPrefix(info.pdfName)}|${info.bold ? "b" : ""}${
    info.italic ? "i" : ""
  }`;
}
