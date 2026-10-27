import { describe, expect, it } from "vitest";
import { detectTextOrientation, findLineBands, flipEvidence, inkProfiles, ocrOrientation, ocrReadingScore, periodicity } from "@/lib/scan/orientation";
import type { OcrResult } from "@/lib/scan/ocr";
import type { Rgba } from "@/lib/scan/pixels";
import { rotateRgba } from "@/lib/scan/pixels";

/** Texto sintetico: lineas con altura de x, ascendentes (arriba) y descendentes (abajo, menos) y borde izquierdo alineado. */
function textPage(width = 360, height = 480, upright = true): Rgba {
  const data = new Uint8ClampedArray(width * height * 4).fill(240);
  const set = (x: number, y: number, v: number) => data.set([v, v, v, 255], (y * width + x) * 4);
  let seed = 11;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let top = 40; top < height - 50; top += 26) {
    const right = 200 + Math.floor(rand() * 110);
    for (let x = 30; x < right; x += 1) {
      const glyph = Math.floor((x - 30) / 7);
      const gap = (x - 30) % 7 > 5;
      if (gap) continue;
      // x-height 7 filas
      for (let y = 0; y < 7; y += 1) set(x, top + 8 + y, 20);
      // ascendente en 1 de cada 3 letras (14 % de la masa), descendente en 1 de cada 9
      if (glyph % 3 === 0) for (let y = 0; y < 8; y += 1) set(x, top + y, 20);
      if (glyph % 9 === 4) for (let y = 0; y < 5; y += 1) set(x, top + 15 + y, 20);
    }
  }
  const image: Rgba = { data, width, height };
  return upright ? image : rotateRgba(image, 2);
}

describe("orientacion sin OCR — src/lib/scan/orientation.ts", () => {
  it("perfiles y periodicidad: las lineas dan un perfil por filas muy periodico; el perfil por columnas no", () => {
    const g = { data: new Uint8Array(0), width: 0, height: 0 };
    void g;
    const page = textPage();
    const mask = new Uint8Array(page.width * page.height);
    for (let i = 0; i < mask.length; i += 1) mask[i] = page.data[i * 4] < 100 ? 1 : 0;
    const { rows, cols } = inkProfiles(mask, page.width, page.height);
    expect(periodicity(rows)).toBeGreaterThan(0.4);
    expect(periodicity(rows)).toBeGreaterThan(periodicity(cols) + 0.2);
    expect(periodicity(new Float32Array(10))).toBe(0);
    expect(periodicity(new Float32Array(200).fill(5))).toBe(0);
  });

  it("findLineBands encuentra cada linea (con sus ascendentes y descendentes dentro)", () => {
    const rows = new Float32Array(120);
    for (const top of [10, 40, 70]) for (let y = 0; y < 8; y += 1) rows[top + y] = 100;
    rows[8] = 12;
    rows[18] = 6;
    const bands = findLineBands(rows);
    expect(bands).toHaveLength(3);
    expect(bands[0].from).toBeLessThanOrEqual(8);
    expect(bands[0].to).toBeGreaterThanOrEqual(18);
    expect(findLineBands(new Float32Array(50))).toEqual([]);
  });

  it("flipEvidence: positiva con el texto derecho y negativa cabeza abajo", () => {
    const mask = (img: Rgba) => {
      const m = new Uint8Array(img.width * img.height);
      for (let i = 0; i < m.length; i += 1) m[i] = img.data[i * 4] < 100 ? 1 : 0;
      return m;
    };
    const up = textPage();
    const down = textPage(360, 480, false);
    expect(flipEvidence(mask(up), up.width, up.height).score).toBeGreaterThan(0.16);
    expect(flipEvidence(mask(down), down.width, down.height).score).toBeLessThan(-0.16);
  });

  it("detecta 0, 90, 180 y 270 (giro horario que lo deja derecho) y no opina de una hoja lisa o ruidosa", () => {
    const page = textPage();
    expect(detectTextOrientation(page)?.rotation).toBe(0);
    expect(detectTextOrientation(rotateRgba(page, 2))?.rotation).toBe(180);
    // La foto esta girada 90 horario: hay que girarla 270 para enderezarla.
    expect(detectTextOrientation(rotateRgba(page, 1))?.rotation).toBe(270);
    expect(detectTextOrientation(rotateRgba(page, 3))?.rotation).toBe(90);
    expect(detectTextOrientation({ data: new Uint8ClampedArray(200 * 200 * 4).fill(235), width: 200, height: 200 })).toBeNull();
    const noise = new Uint8ClampedArray(200 * 200 * 4);
    let s = 3;
    for (let i = 0; i < 200 * 200; i += 1) {
      s = (s * 16807) % 2147483647;
      const v = s % 256;
      noise.set([v, v, v, 255], i * 4);
    }
    expect(detectTextOrientation({ data: noise, width: 200, height: 200 })).toBeNull();
  });

  it("sin evidencia arriba/abajo (ascendentes = descendentes y lineas centradas) NO opina, aunque vea que son lineas", () => {
    const width = 360;
    const height = 480;
    const data = new Uint8ClampedArray(width * height * 4).fill(240);
    const set = (x: number, y: number) => data.set([20, 20, 20, 255], (y * width + x) * 4);
    for (let top = 40; top < height - 50; top += 26) {
      // Lineas CENTRADAS de longitud variable; ascendente y descendente de igual tamano y frecuencia (simetria total).
      const half = 60 + ((top * 7) % 90);
      for (let x = width / 2 - half; x < width / 2 + half; x += 1) {
        const glyph = Math.floor((x - 30) / 7);
        if ((x - 30) % 7 > 5) continue;
        for (let y = 0; y < 7; y += 1) set(x, top + 8 + y);
        if (glyph % 3 === 0) for (let y = 0; y < 8; y += 1) set(x, top + y);
        if (glyph % 3 === 1) for (let y = 0; y < 8; y += 1) set(x, top + 15 + y);
      }
    }
    expect(detectTextOrientation({ data, width, height })).toBeNull();
  });

  it("la confianza esta entre 0 y 1", () => {
    const read = detectTextOrientation(textPage());
    expect(read?.confidence).toBeGreaterThan(0);
    expect(read?.confidence).toBeLessThanOrEqual(1);
  });
});

describe("orientacion con OCR (lector de mentira)", () => {
  const result = (words: Array<[string, number]>): OcrResult => ({ text: "", width: 10, height: 10, lines: [{ text: "", confidence: 90, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 }, words: words.map(([text, confidence]) => ({ text, confidence, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } })) }] });
  const readable = result(Array.from({ length: 20 }, () => ["contrato", 90] as [string, number]));
  const garbage = result(Array.from({ length: 20 }, () => ["xq", 20] as [string, number]));

  it("puntua solo palabras de >= 3 letras y buena confianza", () => {
    expect(ocrReadingScore(readable)).toBeCloseTo(20 * 0.9 * 8, 5);
    expect(ocrReadingScore(garbage)).toBe(0);
    expect(ocrReadingScore(result([["ab", 99], ["bien", 59]]))).toBe(0);
  });

  it("elige el giro que MAS lee, solo si gana con claridad; nunca gira a ciegas", async () => {
    const image: Rgba = { data: new Uint8ClampedArray(4 * 8 * 4), width: 4, height: 8 };
    // El lector «lee» cuando la imagen llega girada 180 (ancho 4, alto 8).
    let calls = 0;
    const reads180 = async (img: Rgba) => {
      calls += 1;
      return img.width === 4 && img.data[0] === 1 ? readable : garbage;
    };
    const marked: Rgba = { data: new Uint8ClampedArray(image.data), width: 4, height: 8 };
    marked.data[(8 * 4 - 1) * 4] = 1; // ultimo pixel: tras 180 pasa a ser el primero
    const got = await ocrOrientation(marked, reads180);
    expect(got?.rotation).toBe(180);
    expect(calls).toBe(4);
    expect(await ocrOrientation(image, async () => garbage)).toBeNull();
    expect(await ocrOrientation(image, async () => readable)).toBeNull();
  });
});
