import v8 from "node:v8";
import vm from "node:vm";
import { createCanvas, ImageData as NapiImageData } from "@napi-rs/canvas";
import { makeRng } from "@/lib/scan/__fixtures__/rng";
import type { CorpusItem } from "@/lib/scan/__fixtures__/corpus";
import { inverseHomography, warpImageData, type QuadCorners } from "@/lib/scan/perspective";
import { quadOutputSize } from "@/lib/scan/perspective";
import type { OcrLine, OcrResult } from "@/lib/scan/ocr";
import type { Rgba } from "@/lib/scan/pixels";

/**
 * Utilidades SOLO para pruebas del Escaner (Node): enderezar un elemento del corpus con su verdad o con otro cuadrilatero,
 * un OCR de MENTIRA que lee las lineas de la verdad (con ruido reproducible) y el entorno minimo que scanic necesita en Node.
 */

/** Endereza la hoja de un elemento (con la verdad o con `quad`) a un ancho dado, conservando la proporcion de la HOJA en la foto. */
export function rectify(item: CorpusItem, width = 560, quad: QuadCorners | null = item.truth.quad): Rgba {
  const image = item.image;
  if (!quad) return image;
  const natural = quadOutputSize(quad, image.width, image.height);
  const scale = width / Math.max(natural.width, natural.height);
  const size = { width: Math.max(1, Math.round(natural.width * scale)), height: Math.max(1, Math.round(natural.height * scale)) };
  return warpImageData(image, quad, size) as Rgba;
}

/** Lienzos que scanic pidio con `document.createElement('canvas')` desde la ultima liberacion. */
const scanicCanvases: Array<{ width: number; height: number }> = [];

/**
 * Libera la memoria nativa de los lienzos que scanic creo (Skia: el recolector de basura de V8 no la ve y, sin esto, cientos de
 * escenas sumaban GB de memoria residente). Llamar cuando scanic ya termino con la imagen.
 */
export function releaseScanicCanvases(): void {
  for (const canvas of scanicCanvases.splice(0)) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

let forceGc: (() => void) | null | undefined;

/** Fuerza una recoleccion de basura sin necesitar `node --expose-gc`. Sin efecto si el motor no la ofrece. */
export function collectGarbage(): void {
  if (forceGc === undefined) {
    try {
      v8.setFlagsFromString("--expose-gc");
      forceGc = vm.runInNewContext("gc") as () => void;
    } catch {
      forceGc = null;
    }
  }
  forceGc?.();
}

/**
 * Deja que se libere la memoria nativa de lo que ya no se usa (buffers de `getImageData`, lienzos de Skia, copias de pixeles). Un bucle
 * de escenas que solo espera microtareas (`await` de promesas ya resueltas) NUNCA cede el turno al bucle de eventos, y ahi es donde se
 * ejecutan los finalizadores de los buffers nativos: sin esto la memoria residente subia ~5 MB por escena (1,2-2,6 GB en el fuzz y las
 * metricas; en un runner de 7 GB el proceso recibia la senal de apagado). El heap de JS casi no cuenta (~40 MB) y V8 no dispara la
 * recoleccion por si solo. Medido: con esto la memoria no crece con el numero de escenas.
 */
export async function settleMemory(): Promise<void> {
  collectGarbage();
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Instala lo que scanic necesita en Node (`document.createElement('canvas')` y `ImageData`). Devuelve la funcion de limpieza. */
export function installScanicEnvironment(): () => void {
  const scope = globalThis as Record<string, unknown>;
  const before = { document: scope.document, ImageData: scope.ImageData };
  scope.document = {
    createElement: () => {
      const canvas = createCanvas(1, 1);
      scanicCanvases.push(canvas);
      return canvas;
    },
  };
  scope.ImageData = NapiImageData;
  return () => {
    scope.document = before.document;
    scope.ImageData = before.ImageData;
  };
}

/** `Rgba` -> `ImageData` de @napi-rs/canvas (lo que scanic acepta en Node). */
export function toNapiImageData(image: Rgba): ImageData {
  return new NapiImageData(new Uint8ClampedArray(image.data), image.width, image.height) as unknown as ImageData;
}

export type FakeOcrOptions = { seed: number; /** Probabilidad de leer mal cada letra. */ charError?: number; /** Probabilidad de perder cada palabra. */ dropWord?: number };

/**
 * OCR de mentira: «lee» las lineas de la verdad (en coordenadas de la pagina impresa) escaladas al tamano de la imagen. Las
 * cajas de cada palabra se reparten por numero de letras. Con `charError` confunde letras (ruido de lectura).
 */
export function fakeOcr(item: CorpusItem, image: { width: number; height: number }, options: FakeOcrOptions): OcrResult {
  const rng = makeRng(options.seed);
  const k = image.width / item.truth.pageWidth;
  const lines: OcrLine[] = [];
  for (const truth of item.truth.lines) {
    const words: OcrLine["words"] = [];
    const tokens = truth.text.split(/\s+/).filter(Boolean);
    const totalChars = tokens.reduce((s, t) => s + t.length + 1, 0);
    let cursor = truth.left;
    for (const token of tokens) {
      const share = ((token.length + 1) / totalChars) * truth.width;
      let text = token;
      const charError = options.charError ?? 0;
      if (charError > 0) {
        text = [...token].map((c) => (/\p{L}/u.test(c) && rng.chance(charError) ? String.fromCharCode(97 + rng.int(0, 25)) : c)).join("");
      }
      if (!rng.chance(options.dropWord ?? 0)) {
        words.push({
          text,
          confidence: rng.range(72, 96),
          bbox: { x0: cursor * k, x1: (cursor + share * 0.9) * k, y0: truth.top * k, y1: (truth.top + truth.size * 1.05) * k },
        });
      }
      cursor += share;
    }
    if (words.length === 0) continue;
    lines.push({
      text: words.map((w) => w.text).join(" "),
      confidence: 85,
      bbox: { x0: words[0].bbox.x0, x1: words[words.length - 1].bbox.x1, y0: truth.top * k, y1: (truth.top + truth.size * 1.05) * k },
      words,
    });
  }
  lines.sort((a, b) => a.bbox.y0 - b.bbox.y0);
  return { text: lines.map((l) => l.text).join("\n"), lines, width: image.width, height: image.height };
}

export { inverseHomography };
