/**
 * Hoja SINTETICA para el OCR: dibuja lineas de texto en una imagen con `@napi-rs/canvas` (fuente Liberation del repositorio, igual en
 * cualquier maquina) y devuelve la imagen mas las cajas de cada palabra. `simulatedRecognizer` hace de tesseract: comprueba que la
 * imagen que recibe tiene tinta y devuelve las palabras de la verdad, opcionalmente con ruido (letras cambiadas con baja confianza,
 * como haria un OCR dudoso). Nada de red ni de modelo.
 */

import path from "node:path";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import type { RecognizeOptions } from "@/lib/autofill/engine";
import type { OcrLine, OcrResult, OcrWord } from "@/lib/scan/ocr";
import type { Rgba } from "@/lib/scan/pixels";

let fontReady = false;
function ensureFont(): void {
  if (fontReady) return;
  GlobalFonts.registerFromPath(path.join(process.cwd(), "public", "fonts", "LiberationSans-Regular.ttf"), "AutofillSans");
  fontReady = true;
}

export type SheetLine = { text: string; x?: number; y: number; size?: number };

export type Sheet = {
  png: Uint8Array;
  width: number;
  height: number;
  /** Lineas con sus palabras y cajas, en pixeles de la imagen. */
  lines: Array<{ text: string; words: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }> }>;
};

export function renderSheet(lines: readonly SheetLine[], options: { width?: number; height?: number } = {}): Sheet {
  ensureFont();
  const width = options.width ?? 1000;
  const height = options.height ?? 1300;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#101010";
  ctx.textBaseline = "alphabetic";
  const out: Sheet["lines"] = [];
  for (const line of lines) {
    const size = line.size ?? 30;
    ctx.font = `${size}px AutofillSans`;
    const x = line.x ?? 60;
    const space = ctx.measureText(" ").width;
    let cursor = x;
    const words: Sheet["lines"][number]["words"] = [];
    for (const word of line.text.split(" ")) {
      if (word === "") {
        cursor += space;
        continue;
      }
      const w = ctx.measureText(word).width;
      ctx.fillText(word, cursor, line.y);
      words.push({ text: word, x0: cursor, y0: line.y - size * 0.8, x1: cursor + w, y1: line.y + size * 0.22 });
      cursor += w + space;
    }
    out.push({ text: line.text, words });
  }
  return { png: new Uint8Array(canvas.toBuffer("image/png")), width, height, lines: out };
}

export type SimulatedOptions = {
  /** Sustituye letras de las palabras que cumplen el predicado por otras parecidas y les baja la confianza. */
  noisy?: (word: string) => boolean;
  /** Confianza de las palabras limpias (0..100). */
  confidence?: number;
  /** Demora de cada reconocimiento (ms) para probar cancelacion y plazos. */
  delayMs?: number;
  /** No responde nunca (OCR colgado). */
  hang?: boolean;
  onCall?: (image: Rgba) => void;
};

const CONFUSIONS: Record<string, string> = { O: "0", "0": "O", l: "1", "1": "l", S: "5", "5": "S", B: "8", "8": "B", e: "c", a: "o" };

function corrupt(word: string): string {
  return word.replace(/[A-Za-z0-9]/, (char) => CONFUSIONS[char] ?? char);
}

/** Cuantos pixeles oscuros tiene la imagen (la comprobacion de que el motor paso pixeles de verdad). */
export function inkPixels(image: Rgba): number {
  let ink = 0;
  for (let i = 0; i < image.data.length; i += 16) if (image.data[i] < 100) ink += 1;
  return ink;
}

/** Reconocedor de mentira: devuelve las palabras de la hoja, escaladas al tamano de la imagen recibida. */
export function simulatedRecognizer(sheet: Sheet, options: SimulatedOptions = {}): (image: Rgba, o: RecognizeOptions) => Promise<OcrResult> {
  return async (image, o) => {
    options.onCall?.(image);
    if (options.hang) return new Promise<OcrResult>(() => undefined);
    if (options.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.delayMs);
        o.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    }
    if (inkPixels(image) < 50) return { text: "", lines: [], width: image.width, height: image.height };
    const sx = image.width / sheet.width;
    const sy = image.height / sheet.height;
    const lines: OcrLine[] = sheet.lines.map((line) => {
      const words: OcrWord[] = line.words.map((word) => {
        const bad = options.noisy?.(word.text) ?? false;
        return {
          text: bad ? corrupt(word.text) : word.text,
          confidence: bad ? 42 : (options.confidence ?? 93),
          bbox: { x0: word.x0 * sx, y0: word.y0 * sy, x1: word.x1 * sx, y1: word.y1 * sy },
        };
      });
      const first = words[0];
      const last = words[words.length - 1];
      return {
        text: words.map((w) => w.text).join(" "),
        confidence: Math.min(...words.map((w) => w.confidence)),
        bbox: { x0: first?.bbox.x0 ?? 0, y0: Math.min(...words.map((w) => w.bbox.y0)), x1: last?.bbox.x1 ?? 0, y1: Math.max(...words.map((w) => w.bbox.y1)) },
        words,
      };
    });
    o.onProgress?.(1);
    return { text: lines.map((l) => l.text).join("\n"), lines, width: image.width, height: image.height };
  };
}
