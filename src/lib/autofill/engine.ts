/**
 * Motor de extraccion del autorrelleno: lee las fuentes (PDF, imagen, texto pegado), reconstruye lineas con celdas, aplica las
 * reglas y devuelve valores con confianza, nivel y evidencia. 100 % local.
 *
 *   - PDF: capa de texto con posiciones (pdf.js). Si una pagina casi no tiene texto legible Y es una imagen, se rasteriza y pasa por
 *     OCR (tesseract.js, `OcrRecognizer` de `src/lib/scan/ocr.ts`); solo cuando hace falta y solo si el modelo ya esta en el dispositivo:
 *     si no, aviso `ocr-unavailable` y se sigue (nunca bloquea ni cuelga: cada reconocimiento tiene plazo y se puede cancelar).
 *   - Imagen: se decodifica derecha (orientacion EXIF) y se reconoce con OCR.
 *   - Texto pegado: directo (un salto de pagina «\f» separa paginas).
 *
 * Las dependencias del navegador (abrir PDF, decodificar, OCR) entran por `EngineDeps`: en las pruebas se sustituyen por dobles y el
 * mismo motor corre en Node. `extract` usa las del navegador, que se importan perezosamente.
 */

import { fold } from "@/lib/autofill/text";
import { buildLines, pastedBoxes, type TextBox, type TextOrigin, type TextPage } from "@/lib/autofill/layout";
import { unverifiedNote, warningMessage } from "@/lib/autofill/reasons";
import { resolveCandidates } from "@/lib/autofill/resolve";
import { collectSource, isDeclarationPage, type Candidate } from "@/lib/autofill/rules";
import { resizeTo, type PrepKind } from "@/lib/autofill/imagePrep";
import { wrapPdfJs, type PdfSession } from "@/lib/autofill/pdfSession";
import type { AutofillSource, ExtractEngine, ExtractOptions, ExtractResult, ExtractWarning, ExtractWarningCode, ExtractedValue } from "@/lib/autofill/types";
import { IMAGE_PAGE_COVERAGE, MAX_ILLEGIBLE_RATIO, decidePageSource, type CoverageOps } from "@/lib/pdf/pageTextKind";
import type { OcrLine, OcrResult } from "@/lib/scan/ocr";
import { cropRgba, type Rgba } from "@/lib/scan/pixels";

export const DEFAULT_MAX_PAGES = 12;
/** Tope absoluto de paginas por fuente, pida lo que pida quien llama. */
const HARD_MAX_PAGES = 60;
/** Texto pegado: caracteres que se leen como mucho. */
export const PASTE_MAX_CHARS = 200_000;
/** Plazo de UN reconocimiento OCR; pasado, se abandona y se avisa. */
export const OCR_TIMEOUT_MS = 90_000;
/** Lado mayor (px) al que se decodifica una foto para el OCR. */
const OCR_MAX_SIDE = 2800;
/** Paginas sin texto ni imagen (en blanco): no se gastan en OCR. */
const BLANK_PAGE_COVERAGE = 0.05;
/**
 * Resolucion que se le dice al OCR (la imagen preparada mide ~2 900 px de lado mayor: ~260-300 dpi en una hoja Carta). Sin ella tesseract la
 * ADIVINA («Estimating resolution as 173…») y a veces escala mal el texto: medido en el banco de declaraciones, decirsela sube la lectura
 * correcta de 61 % a 69 % en fotos y de 75 % a 79 % en hojas escaneadas.
 */
export const OCR_DPI = 300;
/** Con mas paginas que esto por leer con OCR, antes se mira cada una a baja resolucion para encontrar la hoja de declaraciones. */
const OCR_TRIAGE_MIN_PAGES = 3;
/** Lado mayor (px) de la lectura rapida de una pagina para localizar las declaraciones, y resolucion que se le dice al OCR. */
const TRIAGE_SIDE = 1500;
const TRIAGE_DPI = 150;
/** Fraccion de arriba de la pagina que se lee para ver si es una hoja de declaraciones, y lo que busca (sobre texto sin tildes). */
const TRIAGE_BAND = 0.2;
const DECLARATIONS_TITLE = /\b(?:declarations?|declaraciones|policy\s+(?:summary|schedule)|resumen\s+de\s+(?:la\s+)?poliza)\b/;
/** Paginas de declaraciones que se leen a fondo como mucho en un PDF largo. */
const TRIAGE_MAX_PAGES = 5;
/** Lecturas de OCR por pagina: la normal y, si sale dudosa, un reintento con otra receta. */
const MAX_OCR_ATTEMPTS = 2;
/** Modo de segmentacion del reintento: texto disperso (un formulario con campos sueltos). */
const RETRY_PAGE_SEG_MODE = 11;
/** Lado mayor (px) del recorte que se muestra en la revision. */
export const CROP_MAX_SIDE = 760;
/** Modo de segmentacion de la segunda lectura de una zona: un bloque uniforme de texto. */
const VERIFY_PAGE_SEG_MODE = 6;
/** Paginas de un PDF largo cuya capa de texto se mira para encontrar las hojas de declaraciones. */
const TRIAGE_PAGES = 60;

export type OcrQuality = { mean: number; words: number; score: number; good: boolean };

/** Confianza media de las palabras (ponderada por su largo) y cuantas palabras utiles hay: decide si se repite la lectura. */
/** Texto plegado a letras y cifras minusculas sin tildes (para comparar lecturas). */
const flat = (text: string): string => fold(text).replace(/[^a-z0-9]/g, "");

/**
 * ¿Se reproduce el valor en el texto de la segunda lectura? Cada clave lo dice a su manera (el valor ya esta normalizado y el texto no):
 * nombres, direcciones, aseguradora e hipotecario: todas sus palabras; telefono y fecha: las cifras; correo, poliza y reclamo: el valor entero;
 * importes y porcentajes: las cifras. Un texto con ruido alrededor no importa; una letra distinta DENTRO del valor, si.
 */
/** Palabras que siguen a un hipotecario y no son parte de su nombre. */
const LEGAL_TAIL = new Set(["isaoa", "atima", "its", "successors", "and", "or", "assigns", "the"]);

export function valueSurvives(key: string, value: string, reread: string): boolean {
  const text = flat(reread);
  const has = (token: string): boolean => token === "" || text.includes(token);
  const words = (v: string): string[] => fold(v).split(/[^a-z0-9]+/).filter((word) => word.length > 0);
  const digitsOf = (v: string): string[] => v.replace(/(?<=\d),(?=\d{3})/g, "").match(/\d+(?:\.\d+)?/g) ?? [];
  const readDigits = new Set(digitsOf(reread).map((n) => n.replace(/^0+(?=\d)/, "")));
  const readDigitRuns = reread.replace(/\D+/g, "");
  switch (key) {
    case "phone": {
      const own = value.replace(/\D/g, "").replace(/^1(?=\d{10})/, "");
      return readDigitRuns.includes(own);
    }
    case "lossDate":
    case "policyStart":
    case "policyEnd": {
      // De una fecha se exigen el ano y uno de los otros dos numeros (el mes puede ir en letras).
      const numbers = digitsOf(value);
      const year = numbers.find((n) => n.length === 4);
      const others = numbers.filter((n) => n.length <= 2).map((n) => n.replace(/^0+(?=\d)/, ""));
      return (year === undefined || readDigits.has(year)) && (others.length === 0 || others.some((n) => readDigits.has(n)));
    }
    case "deductible":
    case "windDeductible":
      return digitsOf(value).every((n) => readDigits.has(n.replace(/^0+(?=\d)/, "")));
    case "email":
    case "policyNumber":
    case "claimNumber":
      return has(flat(value));
    case "mortgagee":
    case "insurer": {
      // La zona es solo el nombre: si la segunda lectura trae palabras que el valor no tiene (una primera palabra perdida por el OCR), no es el mismo dato.
      const own = new Set(words(value));
      const extra = words(reread).filter((word) => word.length >= 3 && /[a-z]/.test(word) && !own.has(word) && !LEGAL_TAIL.has(word));
      return words(value).every(has) && extra.length === 0;
    }
    default:
      return words(value).every(has);
  }
}

export function ocrQuality(result: OcrResult): OcrQuality {
  let weight = 0;
  let sum = 0;
  let words = 0;
  for (const line of result.lines ?? []) {
    for (const word of line.words ?? []) {
      const length = word.text.replace(/\s/g, "").length;
      if (length === 0) continue;
      weight += length;
      sum += word.confidence * length;
      if (length >= 3) words += 1;
    }
  }
  const mean = weight === 0 ? 0 : sum / weight;
  return { mean, words, score: mean * Math.min(1, words / 60), good: mean >= 78 && words >= 30 };
}

/** Escala del raster de una pagina de PDF para el OCR: lado mayor ~2 900 px (una hoja Carta a ~260 dpi), sin pasar de 4x ni bajar de 0,5x. */
export const OCR_PAGE_SIDE = 2900;
export function ocrRasterScale(width: number, height: number): number {
  return Math.max(0.5, Math.min(4, OCR_PAGE_SIDE / Math.max(width, height, 1)));
}

/** `pageSegMode`: modo de segmentacion de tesseract (3 = automatico, 6 = un bloque, 11 = texto disperso); por defecto 3. */
/** Una zona de una pagina leida con OCR: sus pixeles (a la resolucion de lectura) y, para mostrarla, un JPEG pequeno en una URL `data:`. */
export type PageRegion = { pixels: Rgba; url?: string };

export type RegionBox = { x0: number; y0: number; x1: number; y1: number };

/**
 * Imagen leida con OCR, ya guardada: `regions` recorta cada zona (fracciones 0..1) y, si se pide (`url`), le saca un JPEG pequeno para mostrarla;
 * `null` si una zona no se pudo recortar.
 */
export type PageSnapshot = { regions(requests: ReadonlyArray<{ box: RegionBox; url: boolean }>): Promise<Array<PageRegion | null>> };

export type RecognizeOptions = { signal?: AbortSignal; onProgress?: (fraction: number) => void; pageSegMode?: number; dpi?: number };

export type EngineDeps = {
  /** Abre un PDF (File/Blob). Lanza si esta danado o protegido. */
  openPdf(file: Blob, signal?: AbortSignal): Promise<PdfSession>;
  /** Decodifica una imagen ya derecha (orientacion EXIF aplicada). */
  decodeImage(file: Blob, signal?: AbortSignal): Promise<Rgba>;
  /** ¿El modelo de OCR esta en este dispositivo? (nunca descarga nada) */
  ocrAvailable(): Promise<boolean>;
  recognize(image: Rgba, options: RecognizeOptions): Promise<OcrResult>;
  /**
   * Prepara la imagen para el OCR (endereza la hoja, quita sombras, corrige el giro, escala). `attempt` 0 = receta normal, 1 = segunda
   * receta para el reintento; `null` = no hay mas recetas. Sin esta dependencia se reconoce la imagen tal cual.
   */
  prepare?(image: Rgba, options: { kind: PrepKind; attempt: number; signal?: AbortSignal }): Promise<Rgba | null>;
  /**
   * Guarda (comprimida) la imagen que se leyo con OCR para recortar de ella las zonas de la evidencia al final. Sin esta dependencia no
   * hay recortes. La imagen no se conserva en memoria: solo lo que devuelve (un JPEG pequeno por zona).
   */
  snapshot?(image: Rgba, signal?: AbortSignal): Promise<PageSnapshot | null>;
  /** Descarta el reconocedor compartido tras un fallo o un plazo vencido. */
  resetOcr?(): Promise<void>;
  /** Plazo de un reconocimiento (ms); por defecto `OCR_TIMEOUT_MS`. */
  ocrTimeoutMs?: number;
};

function abortError(): DOMException {
  return new DOMException("Autorrelleno cancelado", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted) || (typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError");
}

class OcrTimeout extends Error {
  constructor() {
    super("ocr-timeout");
    this.name = "OcrTimeout";
  }
}

function race<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => reject(new OcrTimeout()), ms);
    (timer as { unref?: () => void }).unref?.();
    const onAbort = (): void => reject(abortError());
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    promise.then(
      (value) => {
        done();
        resolve(value);
      },
      (error: unknown) => {
        done();
        reject(error);
      },
    );
  });
}

/**
 * Cede el hilo si lleva mas de ~40 ms sin hacerlo (la interfaz sigue fluida con paginas grandes). Solo cuando hace falta: un
 * `setTimeout` por pagina costaria un segundo entero por pagina en una pestana en segundo plano.
 */
function makeYielder(): () => Promise<void> {
  let last = Date.now();
  return async () => {
    if (Date.now() - last < 40) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    last = Date.now();
  };
}

/** Espera `promise`, pero rechaza con AbortError en cuanto se cancela (lo que `promise` termine despues lo recoge `onLate`). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, onLate: (value: T) => void): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      settled = true;
      reject(abortError());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (settled) onLate(value);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (!settled) reject(error);
      },
    );
  });
}

/** Resultado del OCR -> cajas de texto (palabras con su confianza; si no hay palabras, lineas; si no, el texto plano). */
export function ocrToBoxes(result: OcrResult): TextBox[] {
  const boxes: TextBox[] = [];
  for (const line of dropOverlappingLines(result.lines ?? [])) {
    if (line.words && line.words.length > 0) {
      const texts = fixOcrWords(line.words.map((word) => word.text));
      line.words.forEach((word, index) => {
        if (texts[index].trim() === "") return;
        boxes.push({ text: texts[index], x0: word.bbox.x0, x1: word.bbox.x1, y0: word.bbox.y0, y1: word.bbox.y1, confidence: word.confidence });
      });
    } else if (line.text.trim() !== "") {
      boxes.push({ text: line.text, x0: line.bbox.x0, x1: line.bbox.x1, y0: line.bbox.y0, y1: line.bbox.y1, confidence: line.confidence });
    }
  }
  if (boxes.length === 0 && result.text.trim() !== "") return pastedBoxes(result.text);
  return dropOverlapping(boxes);
}

/**
 * Confusiones tipicas del OCR que rompen una etiqueta: una «I» mayuscula entre dos palabras sale como «|» («Section | Deductible») y el
 * «#» tras «Policy»/«Claim» sale como «4», «H» o «8» («Policy 4:»). Solo se corrigen estos dos casos, con las palabras de al lado como contexto.
 */
export function fixOcrWords(words: readonly string[]): string[] {
  return words.map((word, index) => {
    const before = words[index - 1] ?? "";
    const after = words[index + 1] ?? "";
    if (/^[|¦]$/.test(word) && /^\p{L}/u.test(before) && /^\p{L}/u.test(after)) return "I";
    if (/^[4hH8A]:?$/.test(word) && /^(?:policy|poliza|póliza|pol\.?|claim|reclamo|loan)$/i.test(before)) return `#${word.endsWith(":") ? ":" : ""}`;
    return word;
  });
}

/**
 * Dos LINEAS de OCR que se tapan casi del todo son el mismo texto leido dos veces (el analisis de la pagina de tesseract a veces las
 * duplica, una con palabras partidas): se conserva la mas fiable (mas caracteres legibles x confianza) y se descarta la otra entera.
 */
export function dropOverlappingLines(lines: readonly OcrLine[]): OcrLine[] {
  if (lines.length < 2) return [...lines];
  const quality = (line: OcrLine): number => line.text.replace(/\s/g, "").length * Math.max(1, line.confidence);
  const order = lines.map((_, index) => index).sort((a, b) => quality(lines[b]) - quality(lines[a]) || a - b);
  const kept: OcrLine[] = [];
  const dropped = new Set<number>();
  for (const index of order) {
    const line = lines[index];
    const area = Math.max(1, (line.bbox.x1 - line.bbox.x0) * (line.bbox.y1 - line.bbox.y0));
    let duplicate = false;
    for (const other of kept) {
      const w = Math.min(line.bbox.x1, other.bbox.x1) - Math.max(line.bbox.x0, other.bbox.x0);
      const h = Math.min(line.bbox.y1, other.bbox.y1) - Math.max(line.bbox.y0, other.bbox.y0);
      if (w <= 0 || h <= 0) continue;
      const smaller = Math.min(area, Math.max(1, (other.bbox.x1 - other.bbox.x0) * (other.bbox.y1 - other.bbox.y0)));
      if ((w * h) / smaller > 0.6) {
        duplicate = true;
        break;
      }
    }
    if (duplicate) dropped.add(index);
    else kept.push(line);
  }
  return lines.filter((_, index) => !dropped.has(index));
}

/**
 * tesseract a veces entrega el MISMO texto dos veces (dos bloques que se solapan, uno con palabras partidas): al agruparlas por altura se
 * mezclarian en una linea con trozos repetidos. De dos cajas que se tapan en mas de la mitad de la mas pequena se conserva la de mayor
 * confianza (y, a igual confianza, la de texto mas largo).
 */
export function dropOverlapping(boxes: TextBox[]): TextBox[] {
  if (boxes.length < 2) return boxes;
  const order = boxes.map((_, index) => index).sort((a, b) => (boxes[b].confidence ?? 100) - (boxes[a].confidence ?? 100) || boxes[b].text.length - boxes[a].text.length || a - b);
  const kept: number[] = [];
  const bands = new Map<number, number[]>();
  const bandOf = (box: TextBox): number => Math.floor((box.y0 + box.y1) / 2 / Math.max(4, box.y1 - box.y0));
  const dropped = new Set<number>();
  for (const index of order) {
    const box = boxes[index];
    const height = Math.max(1, box.y1 - box.y0);
    const band = bandOf(box);
    let overlapped = false;
    for (let b = band - 2; b <= band + 2 && !overlapped; b += 1) {
      for (const other of bands.get(b) ?? []) {
        const o = boxes[other];
        const w = Math.min(box.x1, o.x1) - Math.max(box.x0, o.x0);
        const h = Math.min(box.y1, o.y1) - Math.max(box.y0, o.y0);
        if (w <= 0 || h <= 0) continue;
        const smaller = Math.min((box.x1 - box.x0) * height, (o.x1 - o.x0) * Math.max(1, o.y1 - o.y0));
        if (smaller > 0 && (w * h) / smaller > 0.5) {
          overlapped = true;
          break;
        }
      }
    }
    if (overlapped) {
      dropped.add(index);
      continue;
    }
    kept.push(index);
    const list = bands.get(band);
    if (list) list.push(index);
    else bands.set(band, [index]);
  }
  return boxes.filter((_, index) => !dropped.has(index));
}

type RunState = {
  warnings: ExtractWarning[];
  pagesRead: number;
  usedOcr: boolean;
  ocr: { checked: boolean; available: boolean; broken: boolean };
  warned: Set<string>;
};

export function createExtract(deps: EngineDeps): ExtractEngine {
  return async function extract(sources: readonly AutofillSource[], options: ExtractOptions): Promise<ExtractResult> {
    const locale: "es" | "en" = options.locale === "en" ? "en" : "es";
    const signal = options.signal;
    const maxPages = Math.max(1, Math.min(HARD_MAX_PAGES, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES) || DEFAULT_MAX_PAGES));
    const timeoutMs = deps.ocrTimeoutMs ?? OCR_TIMEOUT_MS;
    throwIfAborted(signal);

    let lastProgress = 0;
    const report = (fraction: number): void => {
      const value = Math.max(lastProgress, Math.min(1, Math.max(0, fraction)));
      if (value === lastProgress && value !== 1) return;
      lastProgress = value;
      options.onProgress?.(value);
    };

    const state: RunState = { warnings: [], pagesRead: 0, usedOcr: false, ocr: { checked: false, available: false, broken: false }, warned: new Set() };
    const warn = (code: ExtractWarningCode, sourceIndex?: number, detail?: number | string): void => {
      // Un mismo aviso por fuente y codigo (no una linea por pagina).
      const id = `${code}:${sourceIndex ?? "-"}`;
      if (code !== "page-skipped" && state.warned.has(id)) return;
      state.warned.add(id);
      state.warnings.push({ code, sourceIndex, message: warningMessage(code, locale, detail) });
    };

    /** ¿Se puede usar el OCR? Se comprueba una vez; nunca descarga nada. */
    const ocrReady = async (sourceIndex: number): Promise<boolean> => {
      if (!state.ocr.checked) {
        state.ocr.checked = true;
        state.ocr.available = await deps.ocrAvailable().catch(() => false);
      }
      if (!state.ocr.available || state.ocr.broken) {
        warn("ocr-unavailable", sourceIndex);
        return false;
      }
      return true;
    };

    const recognize = async (image: Rgba, sourceIndex: number, onFraction: (f: number) => void, pageSegMode?: number, dpi: number = OCR_DPI): Promise<OcrResult | null> => {
      try {
        const result = await race(deps.recognize(image, { signal, onProgress: onFraction, pageSegMode, dpi }), timeoutMs, signal);
        state.usedOcr = true;
        return result;
      } catch (error) {
        if (isAbort(error, signal)) throw abortError();
        // Plazo vencido o fallo del motor: no se insiste en el resto de la corrida.
        state.ocr.broken = true;
        warn("ocr-unavailable", sourceIndex);
        await deps.resetOcr?.().catch(() => undefined);
        return null;
      }
    };

    /**
     * Lee una imagen con OCR: la prepara (`deps.prepare`: endereza, quita sombras, escala) y la reconoce; si la lectura sale dudosa (poca
     * confianza o pocas palabras) la repite con la segunda receta y otro modo de segmentacion y se queda con la mejor. Nunca elige en
     * silencio entre dos lecturas distintas de un MISMO dato: las dos lecturas no se mezclan, gana una pagina entera.
     */
    const readWithOcr = async (source: Rgba, kind: PrepKind, sourceIndex: number, onFraction: (f: number) => void): Promise<{ result: OcrResult; image: Rgba; mean: number } | null> => {
      let best: { result: OcrResult; quality: OcrQuality; image: Rgba } | null = null;
      for (let attempt = 0; attempt < MAX_OCR_ATTEMPTS; attempt += 1) {
        throwIfAborted(signal);
        let image: Rgba | null = source;
        if (deps.prepare) {
          try {
            image = await deps.prepare(source, { kind, attempt, signal });
          } catch (error) {
            if (isAbort(error, signal)) throw abortError();
            // La preparacion fallo: la primera vez se lee la imagen tal cual; el reintento se omite.
            image = attempt === 0 ? source : null;
          }
        } else if (attempt > 0) image = null;
        if (!image) break;
        const result = await recognize(image, sourceIndex, (f) => onFraction((attempt + f) / MAX_OCR_ATTEMPTS), attempt === 0 ? undefined : RETRY_PAGE_SEG_MODE);
        if (!result) break;
        const quality = ocrQuality(result);
        if (!best || quality.score > best.quality.score + 2) best = { result, quality, image };
        if (quality.good || state.ocr.broken) break;
      }
      return best ? { result: best.result, image: best.image, mean: best.quality.mean } : null;
    };

    /** Imagenes leidas con OCR, ya comprimidas, para recortar la evidencia al final (clave `fuente:pagina`). */
    const snapshots = new Map<string, PageSnapshot>();
    const keep = async (sourceIndex: number, pageIndex: number, image: Rgba): Promise<void> => {
      if (!deps.snapshot) return;
      try {
        const snapshot = await deps.snapshot(image, signal);
        if (snapshot) snapshots.set(`${sourceIndex}:${pageIndex}`, snapshot);
      } catch (error) {
        if (isAbort(error, signal)) throw abortError();
      }
    };

    const maybeYield = makeYielder();
    const sourcePages: TextPage[][] = sources.map(() => []);
    const count = Math.max(1, sources.length);

    for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
      throwIfAborted(signal);
      const source = sources[sourceIndex];
      const at = (fraction: number): void => report(((sourceIndex + Math.min(1, fraction)) / count) * 0.97);
      const pages = sourcePages[sourceIndex];
      try {
        if (source.kind === "text") {
          const text = source.text.slice(0, PASTE_MAX_CHARS);
          const chunks = text.split("\f").slice(0, maxPages);
          if (source.text.length > PASTE_MAX_CHARS || text.split("\f").length > maxPages) warn("too-many-pages", sourceIndex, maxPages);
          chunks.forEach((chunk, index) => {
            const lines = buildLines(pastedBoxes(chunk));
            if (lines.length === 0) return;
            const last = lines[lines.length - 1];
            pages.push({ index, width: Math.max(...lines.map((line) => line.x1), 1), height: last.y1 + 2, lines, origin: "pasted" });
            state.pagesRead += 1;
          });
        } else if (source.kind === "image") {
          if (await ocrReady(sourceIndex)) {
            at(0.05);
            const image = await deps.decodeImage(source.file, signal);
            at(0.15);
            const read = await readWithOcr(image, "photo", sourceIndex, (f) => at(0.15 + 0.8 * f));
            if (read) {
              const { result } = read;
              const lines = buildLines(ocrToBoxes(result));
              if (lines.length > 0) {
                pages.push({ index: 0, width: result.width || read.image.width, height: result.height || read.image.height, lines, origin: "ocr", ocrMean: read.mean });
                state.pagesRead += 1;
                await keep(sourceIndex, 0, read.image);
              }
            }
          }
        } else {
          await readPdf(source.file, sourceIndex, pages, at);
        }
      } catch (error) {
        if (isAbort(error, signal)) throw abortError();
        warn("unreadable-source", sourceIndex);
      }
      at(1);
    }

    /**
     * Paginas que se leen de un PDF con mas paginas que el limite: las primeras dos (membrete, datos del asegurado) y las que parecen
     * hojas de declaraciones segun su capa de texto (barata de leer: hasta 60 paginas), y luego las primeras que falten. Una pagina sin
     * capa de texto no se puede puntuar sin OCR: entra por orden.
     */
    async function pickPages(session: PdfSession, total: number, limit: number): Promise<number[]> {
      if (total <= limit) return Array.from({ length: total }, (_, index) => index);
      const scan = Math.min(total, TRIAGE_PAGES);
      const chosen = new Set<number>([0, 1].filter((index) => index < total));
      const markers: number[] = [];
      for (let index = 0; index < scan; index += 1) {
        throwIfAborted(signal);
        try {
          const text = await session.readPage(index);
          const lines = buildLines(text.boxes);
          if (lines.length > 0 && isDeclarationPage({ index, width: text.width, height: text.height, lines, origin: "text-layer" })) markers.push(index);
          await session.release(index);
        } catch (error) {
          if (isAbort(error, signal)) throw abortError();
        }
        await maybeYield();
      }
      for (const index of markers) {
        for (const candidate of [index, index + 1]) if (candidate < total && chosen.size < limit) chosen.add(candidate);
      }
      for (let index = 0; chosen.size < limit && index < total; index += 1) chosen.add(index);
      return [...chosen].sort((a, b) => a - b);
    }

    /**
     * Cierra los valores leidos con OCR: les pone el recorte de su zona (para que la persona lo compruebe) y confirma cada valor `high` con
     * una SEGUNDA lectura independiente de su zona (recortada y ampliada: otra escala, otro modo de segmentacion). Si el valor no se
     * reproduce, baja a revision: dos lecturas que no coinciden no son una lectura fiable. Una pagina se abre una sola vez.
     */
    async function finishOcrValues(values: ExtractedValue[]): Promise<void> {
      const byPage = new Map<string, ExtractedValue[]>();
      for (const value of values) {
        if (value.evidence.origin !== "ocr" || !value.evidence.box) continue;
        const key = `${value.evidence.sourceIndex}:${value.evidence.pageIndex}`;
        const list = byPage.get(key);
        if (list) list.push(value);
        else byPage.set(key, [value]);
      }
      for (const [key, list] of byPage) {
        throwIfAborted(signal);
        const snapshot = snapshots.get(key);
        if (!snapshot) continue;
        const display = (value: ExtractedValue): RegionBox => value.evidence.box as RegionBox;
        const inner = (value: ExtractedValue): RegionBox => value.evidence.valueBox ?? (value.evidence.box as RegionBox);
        const id = (box: RegionBox): string => `${box.x0},${box.y0},${box.x1},${box.y1}`;
        const requests: Array<{ box: RegionBox; url: boolean }> = [];
        const slot = new Map<string, number>();
        const want = (box: RegionBox, url: boolean): number => {
          const keyed = `${url ? "u" : "p"}|${id(box)}`;
          const found = slot.get(keyed);
          if (found !== undefined) return found;
          slot.set(keyed, requests.length);
          requests.push({ box, url });
          return requests.length - 1;
        };
        for (const value of list) {
          want(display(value), true);
          if (value.tier === "high") want(inner(value), false);
        }
        let regions: Array<PageRegion | null> = [];
        try {
          regions = await snapshot.regions(requests);
        } catch (error) {
          if (isAbort(error, signal)) throw abortError();
          continue;
        }
        const reads = new Map<number, string | null>();
        for (const value of list) {
          const shown = regions[want(display(value), true)];
          if (shown?.url) value.evidence.crop = shown.url;
          if (value.tier !== "high" || state.ocr.broken) continue;
          const index = want(inner(value), false);
          const region = regions[index];
          if (!region) continue;
          if (!reads.has(index)) reads.set(index, await rereadRegion(region.pixels));
          const text = reads.get(index);
          if (text === null || text === undefined) continue;
          const agreed = valueSurvives(value.key, value.value, text);
          value.evidence.verified = agreed;
          if (!agreed) {
            value.tier = "review";
            value.confidence = Math.min(value.confidence, 0.8);
            value.reason = `${value.reason} · ${unverifiedNote(locale)}`;
          }
        }
      }
    }

    /** Segunda lectura de una zona: ampliada x2 y con el modo «bloque uniforme». `null` si no se pudo (no se baja ningun valor por eso). */
    async function rereadRegion(pixels: Rgba): Promise<string | null> {
      try {
        const k = Math.max(1, Math.min(2, 2600 / Math.max(pixels.width, 1)));
        const big = k > 1.05 ? await resizeTo(pixels, Math.round(pixels.width * k), Math.round(pixels.height * k)) : pixels;
        const result = await race(deps.recognize(big, { signal, pageSegMode: VERIFY_PAGE_SEG_MODE }), timeoutMs, signal);
        return (result.lines ?? []).flatMap((line) => (line.words ?? []).map((word) => word.text)).join(" ");
      } catch (error) {
        if (isAbort(error, signal)) throw abortError();
        return null;
      }
    }

    /**
     * Un PDF escaneado de muchas paginas (una poliza completa: portada, hoja de declaraciones, clausulado…) no se lee entero con OCR: cada
     * pagina que lo necesita se mira ANTES a baja resolucion (rapido; los titulos y etiquetas grandes se leen) y solo se leen a fondo la
     * primera (membrete) y las que parecen declaraciones (titulo corto con «Declarations»). Devuelve las paginas que se saltan. Si ninguna parece
     * declaraciones, no se salta nada (se lee como siempre, hasta el limite).
     */
    async function triageScanned(session: PdfSession, sourceIndex: number, order: readonly number[], at: (fraction: number) => void): Promise<Set<number>> {
      const skip = new Set<number>();
      const needOcr: number[] = [];
      for (const index of order) {
        throwIfAborted(signal);
        try {
          const text = await session.readPage(index);
          let decision = decidePageSource({ chars: text.chars, legibleChars: text.legible, illegibleChars: text.illegible, ocrFallback: true });
          if (decision === "checkImage") decision = (await text.imageCoverage().catch(() => 1)) >= IMAGE_PAGE_COVERAGE ? "ocr" : "text";
          if (decision === "ocr" && text.chars === 0 && (await text.imageCoverage().catch(() => 1)) < BLANK_PAGE_COVERAGE) decision = "empty";
          await session.release(index);
          if (decision === "ocr") needOcr.push(index);
        } catch (error) {
          if (isAbort(error, signal)) throw abortError();
        }
      }
      if (needOcr.length <= OCR_TRIAGE_MIN_PAGES || !(await ocrReady(sourceIndex))) return skip;
      const declarations: number[] = [];
      for (const [position, index] of needOcr.entries()) {
        throwIfAborted(signal);
        at((position / needOcr.length) * 0.15);
        let image: Rgba | null = null;
        try {
          image = await session.rasterize(index, TRIAGE_SIDE);
        } catch (error) {
          if (isAbort(error, signal)) throw abortError();
        }
        if (!image) continue;
        // Solo la franja de arriba (membrete y titulo): una pagina de prosa densa tarda mucho en leerse aunque sea pequena; un titulo, no.
        const band = cropRgba(image, 0, 0, image.width, Math.max(40, Math.round(image.height * TRIAGE_BAND)));
        const result = await recognize(band, sourceIndex, () => undefined, 6, TRIAGE_DPI);
        if (!result) return new Set<number>();
        // El titulo es una linea CORTA («HOMEOWNERS POLICY DECLARATIONS»); una frase del clausulado que nombra las declaraciones es una linea larga.
        if ((result.lines ?? []).some((line) => line.text.length <= 60 && line.text.split(/\s+/).length <= 8 && DECLARATIONS_TITLE.test(fold(line.text)))) declarations.push(index);
        await maybeYield();
      }
      if (declarations.length === 0) return skip;
      const keepPages = new Set<number>([needOcr[0]]);
      // Una continuacion de las declaraciones lleva el mismo titulo («Declarations (continued)»), asi que tambien entra por aqui.
      for (const index of declarations) if (keepPages.size < TRIAGE_MAX_PAGES + 1) keepPages.add(index);
      for (const index of needOcr) if (!keepPages.has(index)) skip.add(index);
      return skip;
    }

    async function readPdf(file: Blob, sourceIndex: number, pages: TextPage[], at: (fraction: number) => void): Promise<void> {
      // Abrir un PDF grande no se puede interrumpir: se deja de esperar y, si llega tarde, se cierra.
      const session = await abortable(deps.openPdf(file, signal), signal, (late) => void late.close().catch(() => undefined));
      try {
        const total = session.numPages;
        if (!(total > 0)) throw new Error("empty-pdf");
        const limit = Math.min(total, maxPages);
        if (total > limit) warn("too-many-pages", sourceIndex, limit);
        const order = await pickPages(session, total, limit);
        const skipOcr = await triageScanned(session, sourceIndex, order, at);
        // Una hoja de declaraciones leida por OCR ya trae lo que se busca: al llegar a una pagina que no lo es (y ya hubo una), se deja de gastar OCR.
        let declarationsRead = false;
        let ocrDone = false;
        for (const [position, index] of order.entries()) {
          throwIfAborted(signal);
          at(position / order.length);
          let text;
          try {
            text = await session.readPage(index);
          } catch (error) {
            if (isAbort(error, signal)) throw abortError();
            warn("page-skipped", sourceIndex, index + 1);
            continue;
          }
          let decision = decidePageSource({ chars: text.chars, legibleChars: text.legible, illegibleChars: text.illegible, ocrFallback: true });
          if (decision === "checkImage") decision = (await text.imageCoverage().catch(() => 1)) >= IMAGE_PAGE_COVERAGE ? "ocr" : "text";
          // Mucho texto pero casi todo ilegible (fuente sin mapa de caracteres): la capa de texto no sirve, se lee la imagen.
          if (decision === "text" && text.illegible + text.legible > 0 && text.illegible / (text.illegible + text.legible) > MAX_ILLEGIBLE_RATIO) decision = "ocr";
          if (decision === "ocr" && text.chars === 0 && (await text.imageCoverage().catch(() => 1)) < BLANK_PAGE_COVERAGE) decision = "empty";
          if (decision === "ocr" && (ocrDone || skipOcr.has(index))) decision = "empty";

          let origin: TextOrigin = "text-layer";
          let boxes: TextBox[] = [];
          let width = text.width;
          let height = text.height;
          let recognizedImage: Rgba | null = null;
          let recognizedMean: number | undefined;
          if (decision === "text") {
            boxes = text.boxes;
          } else if (decision === "ocr") {
            let recognized: OcrResult | null = null;
            if (await ocrReady(sourceIndex)) {
              let image: Rgba | null = null;
              try {
                image = await session.rasterize(index);
              } catch (error) {
                // Una pagina que no se puede dibujar se omite; las demas paginas siguen.
                if (isAbort(error, signal)) throw abortError();
                warn("page-skipped", sourceIndex, index + 1);
              }
              if (image) {
                const read = await readWithOcr(image, "page", sourceIndex, (f) => at((position + 0.2 + 0.75 * f) / order.length));
                recognized = read?.result ?? null;
                recognizedImage = read?.image ?? null;
                recognizedMean = read?.mean;
              }
            }
            if (recognized) {
              origin = "ocr";
              boxes = ocrToBoxes(recognized);
              width = recognized.width || width;
              height = recognized.height || height;
            } else if (text.legible > 0) {
              // Sin OCR, la poca capa de texto legible se conserva (como hace la conversion a Markdown).
              boxes = text.boxes;
            }
          }
          await session.release(index);
          const lines = buildLines(boxes);
          if (lines.length > 0) {
            const page: TextPage = { index, width, height, lines, origin, ...(origin === "ocr" && recognizedMean !== undefined ? { ocrMean: recognizedMean } : {}) };
            pages.push(page);
            state.pagesRead += 1;
            if (origin === "ocr") {
              if (isDeclarationPage(page)) declarationsRead = true;
              else if (declarationsRead) ocrDone = true;
              if (recognizedImage) await keep(sourceIndex, index, recognizedImage);
            }
          }
          await maybeYield();
        }
      } finally {
        await session.close();
      }
    }

    // Reglas por fuente: el membrete y el pie que se repiten se detectan entre las paginas de ESA fuente.
    const candidates: Candidate[] = [];
    sourcePages.forEach((pages, sourceIndex) => {
      candidates.push(...collectSource(pages, { sourceIndex, locale }));
    });
    throwIfAborted(signal);
    const values = resolveCandidates(candidates, locale);
    await finishOcrValues(values);
    snapshots.clear();
    // «Nada que rellenar»: se leyo algo y no habia datos, o no se leyo nada porque estaba en blanco (no por un fallo ya avisado).
    const blocked = state.warnings.some((warning) => warning.code === "ocr-unavailable" || warning.code === "unreadable-source");
    if (values.length === 0 && sources.length > 0 && (state.pagesRead > 0 || !blocked)) warn("no-data");
    report(1);
    return { values, warnings: state.warnings, pagesRead: state.pagesRead, usedOcr: state.usedOcr };
  };
}

/* ------------------------------------------------------------------ *
 * Dependencias del navegador (importaciones perezosas: el motor no carga pdf.js ni el OCR hasta que hace falta)
 * ------------------------------------------------------------------ */

export function browserDeps(): EngineDeps {
  return {
    async openPdf(file) {
      const core = await import("@/lib/pdf/core");
      if (file.size > core.MAX_SAFE_FILE_SIZE) throw new Error("file-too-large");
      const pdf = await core.openPdfDocument(file);
      const pdfjs = await core.getPdfJs();
      return wrapPdfJs(pdf, {
        ops: pdfjs.OPS as unknown as CoverageOps,
        rasterize: async (page, side) => {
          const base = page.getViewport({ scale: 1 });
          const scale = side ? Math.min(4, side / Math.max(base.width, base.height, 1)) : ocrRasterScale(base.width, base.height);
          const canvas = await core.renderPageToCanvas(page, { scale, intent: "print" });
          try {
            const context = canvas.getContext("2d");
            if (!context) return null;
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            return { data: image.data as Uint8ClampedArray<ArrayBuffer>, width: canvas.width, height: canvas.height };
          } finally {
            canvas.width = 0;
            canvas.height = 0;
          }
        },
        close: () => core.closePdfDocument(pdf),
      });
    },
    async decodeImage(file, signal) {
      const { decodeToRgba } = await import("@/lib/scan/renderIO");
      return decodeToRgba(file, OCR_MAX_SIDE, signal);
    },
    async ocrAvailable() {
      const { ocrModelAvailable } = await import("@/lib/scan/ocr");
      return ocrModelAvailable();
    },
    async recognize(image, options) {
      const { withRecognizer } = await import("@/lib/scan/ocr");
      return withRecognizer((recognizer) => recognizer.recognize(image, options), options.signal);
    },
    async resetOcr() {
      const { disposeSharedRecognizer } = await import("@/lib/scan/ocr");
      await disposeSharedRecognizer();
    },
    async prepare(image, options) {
      if (options.attempt > 1) return null;
      // En un Web Worker (con respaldo en el hilo principal cediendo el hilo): la foto no congela la pantalla.
      const { prepareOffThread } = await import("@/lib/autofill/prepClient");
      return prepareOffThread(image, options);
    },
    async snapshot(image, signal) {
      const io = await import("@/lib/scan/renderIO");
      const px = await import("@/lib/scan/pixels");
      // La pagina se guarda como un JPEG (≈1 MB) en vez de sus pixeles (≈26 MB): solo se abre al final, una vez, para recortar las zonas.
      const blob = await io.encodeRgba(image, "image/jpeg", 0.9);
      return {
        async regions(requests) {
          const full = await io.decodeToRgba(blob, 4096, signal);
          const out: Array<PageRegion | null> = [];
          for (const { box, url: wantUrl } of requests) {
            const pixels = px.cropRgba(full, box.x0 * full.width, box.y0 * full.height, (box.x1 - box.x0) * full.width, (box.y1 - box.y0) * full.height);
            let url: string | undefined;
            if (wantUrl) {
              try {
                const small = px.downscaleRgba(pixels, CROP_MAX_SIDE);
                const jpeg = await io.encodeRgba(small, "image/jpeg", 0.8);
                url = await new Promise<string | undefined>((resolve) => {
                  const reader = new FileReader();
                  reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : undefined);
                  reader.onerror = () => resolve(undefined);
                  reader.readAsDataURL(jpeg);
                });
              } catch {
                url = undefined;
              }
            }
            out.push({ pixels, url });
          }
          return out;
        },
      };
    },
  };
}

/** Motor real (navegador). */
export const extract: ExtractEngine = (sources, options) => createExtract(browserDeps())(sources, options);
