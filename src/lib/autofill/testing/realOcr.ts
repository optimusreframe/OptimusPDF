/**
 * OCR REAL para la MEDICION en Node: tesseract.js con el mismo modelo que usa la aplicacion (spa+eng, LSTM, `4.0.0_best_int`) y el
 * mismo filtrado de palabras que `createTesseractRecognizer` de `src/lib/scan/ocr.ts`. Descarga el modelo UNA vez a `cachePath`
 * (de la CDN que usa la aplicacion) y despues trabaja sin red. Solo lo importan el script de medicion y pruebas manuales.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { OEM, createWorker } from "tesseract.js";
import type { RecognizeOptions } from "@/lib/autofill/engine";
import type { OcrLine, OcrResult, OcrWord } from "@/lib/scan/ocr";
import type { Rgba } from "@/lib/scan/pixels";

const MIN_WORD_CONFIDENCE = 30;

type Blocks = Array<{ paragraphs: Array<{ lines: Array<{ text: string; confidence: number; bbox: OcrWord["bbox"]; words: Array<{ text: string; confidence: number; bbox: OcrWord["bbox"] }> }> }> }> | null;

export type RealOcr = {
  recognize: (image: Rgba, options: RecognizeOptions) => Promise<OcrResult>;
  close: () => Promise<void>;
  calls: () => number;
  /** Lecturas por modo de segmentacion (para ver cuantas veces se repite una pagina). */
  modes: Record<string, number>;
};

/**
 * `resultCache`: carpeta donde se guarda cada lectura (clave = hash de los pixeles + modo + idiomas): una segunda medicion con la misma
 * imagen no vuelve a reconocer (el OCR es lo que mas tarda). Solo para la medicion: la aplicacion no guarda lecturas.
 */
export async function createRealOcr(cachePath: string, languages = "spa+eng", resultCache?: string): Promise<RealOcr> {
  if (resultCache) mkdirSync(resultCache, { recursive: true });
  mkdirSync(cachePath, { recursive: true });
  const worker = await createWorker(languages, OEM.LSTM_ONLY, { cachePath, logger: () => undefined });
  let calls = 0;
  const modes: Record<string, number> = {};
  let mode: string | null = null;
  let dpi: string | null = null;
  return {
    calls: () => calls,
    modes,
    async recognize(image, options) {
      calls += 1;
      const wanted = String((options as { pageSegMode?: number }).pageSegMode ?? 3);
      const wantedDpi = String((options as { dpi?: number }).dpi ?? 0);
      modes[wanted] = (modes[wanted] ?? 0) + 1;
      let cacheFile: string | null = null;
      if (resultCache) {
        const hash = createHash("sha1").update(image.data).update(`${image.width}x${image.height}|psm${wanted}|dpi${wantedDpi}|${languages}`).digest("hex");
        cacheFile = path.join(resultCache, `${hash}.json`);
        if (existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, "utf8")) as OcrResult;
      }
      if (wantedDpi !== dpi) {
        await worker.setParameters({ user_defined_dpi: wantedDpi } as never);
        dpi = wantedDpi;
      }
      if (wanted !== mode) {
        await worker.setParameters({ tessedit_pageseg_mode: wanted as never });
        mode = wanted;
      }
      const canvas = createCanvas(image.width, image.height);
      const ctx = canvas.getContext("2d");
      const data = ctx.createImageData(image.width, image.height);
      data.data.set(image.data);
      ctx.putImageData(data, 0, 0);
      const result = await worker.recognize(canvas.toBuffer("image/png"), {}, { text: true, blocks: true });
      const lines: OcrLine[] = [];
      for (const block of (result.data.blocks as Blocks) ?? []) {
        for (const paragraph of block.paragraphs) {
          for (const line of paragraph.lines) {
            const words = line.words.filter((word) => word.confidence >= MIN_WORD_CONFIDENCE && word.text.trim().length > 0);
            if (words.length === 0) continue;
            lines.push({ text: words.map((w) => w.text).join(" "), confidence: line.confidence, bbox: line.bbox, words });
          }
        }
      }
      const out: OcrResult = { text: lines.map((l) => l.text).join("\n"), lines, width: image.width, height: image.height };
      if (cacheFile) writeFileSync(cacheFile, JSON.stringify(out));
      return out;
    },
    async close() {
      await worker.terminate().catch(() => undefined);
    },
  };
}
