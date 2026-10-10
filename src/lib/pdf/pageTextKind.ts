/**
 * Cuando una pagina cuenta como «texto» y cuando como imagen que hay que reconocer con OCR.
 *
 * Antes, toda pagina con menos de 24 caracteres se descartaba y se lanzaba el OCR: se perdia texto
 * real corto («Fin», una portada, un titulo), el OCR lo releia peor y, sin red, la conversion no
 * terminaba. Ahora el texto real manda; el OCR solo es para paginas sin texto o que son una imagen.
 */

/** Caracteres utiles por debajo de los cuales una pagina SIN señales de imagen podria ser un escaneo. */
export const MIN_CHARS_FOR_TEXT_PAGE = 24;

/** Parte del area de la pagina que han de cubrir las imagenes para tratarla como una imagen escaneada. */
export const IMAGE_PAGE_COVERAGE = 0.5;

/**
 * Caracteres de un texto que NO son blancos, separados en legibles (letras, cifras, signos,
 * simbolos: «&», «—», «é», «.») e ilegibles (control, formato, sustitutos, uso privado, sin asignar
 * y el U+FFFD de «no se pudo decodificar»): lo que sale de una fuente sin mapa de caracteres.
 */
export function countLegibleChars(text: string): { legible: number; illegible: number } {
  let legible = 0;
  let illegible = 0;
  for (const char of text) {
    if (/\s/u.test(char)) continue;
    if (/[\p{C}\uFFFD]/u.test(char)) illegible += 1;
    else legible += 1;
  }
  return { legible, illegible };
}

/** Proporcion de caracteres ilegibles a partir de la cual la capa de texto no merece confianza. */
export const MAX_ILLEGIBLE_RATIO = 0.5;

export type PageSourceInput = {
  /** Caracteres no blancos de la capa de texto. */
  chars: number;
  /** Caracteres legibles e ilegibles, sin contar blancos (ver `countLegibleChars`). */
  legibleChars: number;
  illegibleChars: number;
  ocrFallback: boolean;
};

/**
 * `"text"`: se usa la capa de texto. `"ocr"`: se reconoce la pagina. `"empty"`: no hay nada.
 * `"checkImage"`: hay poco texto legible; hay que mirar si la pagina es una imagen (ver `IMAGE_PAGE_COVERAGE`).
 */
export type PageSourceDecision = "text" | "ocr" | "empty" | "checkImage";

export function decidePageSource({ chars, legibleChars, illegibleChars, ocrFallback }: PageSourceInput): PageSourceDecision {
  if (chars >= MIN_CHARS_FOR_TEXT_PAGE) return "text";
  // Nada legible (sin capa de texto, o solo basura): lo unico que puede dar contenido es el OCR.
  if (legibleChars === 0) {
    if (ocrFallback) return "ocr";
    return chars > 0 ? "text" : "empty";
  }
  // Mayoria de basura entre lo poco que hay: no se fia de la capa de texto.
  if (illegibleChars / (legibleChars + illegibleChars) > MAX_ILLEGIBLE_RATIO) return ocrFallback ? "ocr" : "text";
  // Texto legible, aunque sea un solo «&» o un «—»: se conserva salvo que la pagina sea una imagen.
  return ocrFallback ? "checkImage" : "text";
}

/** Subconjunto de `OPS` de pdf.js que usa el calculo de cobertura. */
export type CoverageOps = {
  save: number;
  restore: number;
  transform: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject?: number;
};

type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `a x b` con matrices de pdf.js (fila por columnas: [a, b, c, d, e, f]). */
function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/**
 * Fraccion (0..1) del area de la pagina cubierta por imagenes, a partir de la lista de operadores de
 * pdf.js: cada imagen ocupa el cuadrado unidad transformado por la matriz vigente (`cm`), cuya area es
 * |a·d − b·c|. Se suma sin descontar solapes y se recorta a 1. Una pagina escaneada es, tipicamente, una
 * sola imagen a pagina completa.
 */
export function imageCoverage(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  OPS: CoverageOps,
  pageArea: number,
): number {
  if (!(pageArea > 0)) return 0;
  const stack: Matrix[] = [];
  let ctm: Matrix = IDENTITY;
  let covered = 0;
  const imageOps = new Set<number>([OPS.paintImageXObject, OPS.paintInlineImageXObject]);
  if (OPS.paintImageMaskXObject !== undefined) imageOps.add(OPS.paintImageMaskXObject);

  for (let index = 0; index < fnArray.length; index += 1) {
    const op = fnArray[index];
    if (op === OPS.save) {
      stack.push(ctm);
    } else if (op === OPS.restore) {
      ctm = stack.pop() ?? IDENTITY;
    } else if (op === OPS.transform) {
      const args = argsArray[index];
      if (Array.isArray(args) && args.length >= 6 && args.every((value) => Number.isFinite(value))) {
        ctm = multiply(ctm, args.slice(0, 6) as Matrix);
      }
    } else if (imageOps.has(op)) {
      covered += Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
    }
  }
  return Math.min(1, covered / pageArea);
}
