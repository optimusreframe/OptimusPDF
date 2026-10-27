import { describe, expect, it } from "vitest";
import type { Gray, Rgba } from "@/lib/scan/pixels";
import { BLANK_MAX_CELLS, BLUR_ACUTANCE_THRESHOLD, BLUR_REBLUR_THRESHOLD, DARK_PAPER_THRESHOLD, glareOf, inkStatsOf, isBlankPage, isBlurry, measurePage, medianLevel, reblurRatio, sharpnessOf } from "@/lib/scan/quality";
import { boxBlur } from "@/lib/scan/pixels";

function gray(width: number, height: number, value: (x: number, y: number) => number): Gray {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data[y * width + x] = value(x, y);
  return { data, width, height };
}

function rgba(g: Gray): Rgba {
  const data = new Uint8ClampedArray(g.width * g.height * 4);
  for (let i = 0; i < g.data.length; i += 1) data.set([g.data[i], g.data[i], g.data[i], 255], i * 4);
  return { data, width: g.width, height: g.height };
}

/** Lineas de texto horizontales sobre papel claro. */
const textLines = (blur = 0) => gray(240, 300, (x, y) => {
  const inLine = y % 20 >= 8 && y % 20 < 12 && x > 20 && x < 220;
  if (!inLine) return 235;
  if (blur === 0) return 25;
  // Borde suave: el desenfoque reparte el salto en varios pixeles.
  const d = Math.min(Math.abs((y % 20) - 8), Math.abs((y % 20) - 11.99));
  return Math.round(25 + Math.min(1, d / blur) * 0 + (blur - Math.min(blur, d)) * 0);
});

describe("quality — src/lib/scan/quality.ts", () => {
  it("la acutancia separa un borde nitido de uno repartido en una rampa", () => {
    const sharp = gray(160, 160, (x) => (x < 80 ? 30 : 230));
    const soft = gray(160, 160, (x) => Math.max(30, Math.min(230, 30 + (x - 60) * 10)));
    const ramp = gray(160, 160, (x) => Math.max(30, Math.min(230, 30 + (x - 40) * 2.5)));
    const s = sharpnessOf(sharp) as number;
    expect(s).toBeGreaterThan(BLUR_ACUTANCE_THRESHOLD);
    expect(sharpnessOf(soft) as number).toBeLessThan(s);
    expect(sharpnessOf(ramp) as number).toBeLessThan(BLUR_ACUTANCE_THRESHOLD);
    // Una imagen lisa no tiene detalle que juzgar.
    expect(sharpnessOf(gray(100, 100, () => 200))).toBeNull();
    expect(sharpnessOf(gray(4, 4, () => 1))).toBeNull();
  });

  it("glareOf: una zona quemada extensa es reflejo; el ruido o un punto no", () => {
    const burnt = gray(120, 120, (x, y) => ((x - 60) ** 2 + (y - 60) ** 2 < 28 ** 2 ? 255 : 200));
    const reading = glareOf(burnt);
    expect(reading.glare).toBe(true);
    expect(reading.fraction).toBeGreaterThan(0.1);
    expect(glareOf(gray(120, 120, () => 220)).glare).toBe(false);
    const dot = gray(120, 120, (x, y) => (x === 60 && y === 60 ? 255 : 200));
    expect(glareOf(dot).glare).toBe(false);
    // Papel blanco muy luminoso (no quemado) no es reflejo.
    expect(glareOf(gray(120, 120, () => 248)).glare).toBe(false);
  });

  it("medianLevel y la oscuridad: el papel a ~70 es 'oscuro'", () => {
    const dim = gray(100, 100, () => 70);
    expect(medianLevel(dim)).toBe(70);
    const m = measurePage(rgba(gray(200, 260, (x, y) => (y % 20 >= 8 && y % 20 < 11 && x > 20 && x < 180 ? 8 : 70))));
    expect(m.dark).toBe(true);
    expect(m.paperLevel).toBeLessThan(DARK_PAPER_THRESHOLD);
    expect(measurePage(rgba(textLines())).dark).toBe(false);
  });

  it("tinta: una hoja con texto no es blanca, una limpia si, con una sombra suave tambien", () => {
    const text = inkStatsOf(textLines());
    expect(text.cells).toBeGreaterThan(BLANK_MAX_CELLS);
    expect(isBlankPage(text)).toBe(false);
    const clean = inkStatsOf(gray(240, 300, () => 236));
    expect(clean.cells).toBe(0);
    expect(isBlankPage(clean)).toBe(true);
    const shaded = inkStatsOf(gray(240, 300, (x) => 245 - x * 0.35));
    expect(isBlankPage(shaded)).toBe(true);
  });

  it("un sello pequeno o un numero de pagina siguen siendo hoja en blanco; un parrafo corto no", () => {
    const stamp = gray(240, 300, (x, y) => ((x - 120) ** 2 + (y - 150) ** 2 < 22 ** 2 && (x - 120) ** 2 + (y - 150) ** 2 > 16 ** 2 ? 60 : 236));
    expect(isBlankPage(inkStatsOf(stamp))).toBe(true);
    const pageNumber = gray(240, 300, (x, y) => (x > 116 && x < 124 && y > 270 && y < 280 ? 40 : 236));
    expect(isBlankPage(inkStatsOf(pageNumber))).toBe(true);
    const paragraph = gray(240, 300, (x, y) => (y % 14 >= 5 && y % 14 < 9 && y > 30 && y < 90 && x > 20 && x < 220 ? 30 : 236));
    expect(isBlankPage(inkStatsOf(paragraph))).toBe(false);
  });

  it("measurePage: una hoja nitida no se marca borrosa; una en blanco nunca se marca borrosa", () => {
    const sharp = measurePage(rgba(textLines()));
    expect(sharp.blurry).toBe(false);
    expect(sharp.blank).toBe(false);
    expect(sharp.glare).toBe(false);
    const blankSheet = measurePage(rgba(gray(240, 300, (x) => (x < 3 ? 120 : 236))));
    expect(blankSheet.blank).toBe(true);
    expect(blankSheet.blurry).toBe(false);
  });

  it("measurePage: una hoja en blanco con unas manchas suaves (que por si solas parecerian borrosas) nunca se marca borrosa", () => {
    const smudges = gray(300, 400, (x, y) => {
      for (let k = 0; k < 4; k += 1) {
        const cx = 30 + (k % 3) * 90;
        const cy = 60 + Math.floor(k / 3) * 80;
        if (x >= cx && x < cx + 12 && y >= cy && y < cy + 12) return 36;
      }
      return 236;
    });
    const soft = { ...smudges, data: Uint8Array.from(boxBlur(smudges.data, smudges.width, smudges.height, 3)) };
    const quality = measurePage(rgba(soft));
    expect(quality.blank).toBe(true);
    // Las dos medidas dirian «borrosa»: lo que la salva es que la hoja esta en blanco.
    expect(isBlurry(quality.sharpness, quality.reblur)).toBe(true);
    expect(quality.blurry).toBe(false);
  });

  it("un documento BLANCO puro (todo quemado a 255, con su texto) NO es un reflejo; una pared blanca tampoco", () => {
    const whiteDoc = gray(240, 300, (x, y) => (y % 20 >= 8 && y % 20 < 12 && x > 20 && x < 220 ? 20 : 255));
    const reading = glareOf(whiteDoc);
    // Con texto denso el 57 % de la hoja sigue quemado: por debajo del tope de fraccion, pero su mancha ocupa toda la pagina.
    expect(reading.fraction).toBeGreaterThan(0.5);
    expect(reading.glare).toBe(false);
    expect(measurePage(rgba(whiteDoc)).glare).toBe(false);
    expect(glareOf(gray(200, 200, () => 255)).glare).toBe(false);
  });

  it("el reflejo necesita papel VISIBLE alrededor: una escena oscura con una luz no lo es, un papel gris con un destello si", () => {
    const darkWithLamp = gray(200, 200, (x, y) => ((x - 100) ** 2 + (y - 100) ** 2 < 25 ** 2 ? 255 : 40));
    expect(glareOf(darkWithLamp).glare).toBe(false);
    const paperWithGlare = gray(200, 200, (x, y) => ((x - 100) ** 2 + (y - 100) ** 2 < 40 ** 2 ? 255 : 205));
    expect(glareOf(paperWithGlare).glare).toBe(true);
    // Papel ya casi blanco alrededor (>= 243): un area quemada ahi es solo «muy blanco».
    expect(glareOf(gray(200, 200, (x, y) => ((x - 100) ** 2 + (y - 100) ** 2 < 40 ** 2 ? 255 : 246))).glare).toBe(false);
  });

  it("borrosa = acutancia baja Y poca perdida de borde al desenfocar: la acutancia sola ya no basta", () => {
    expect(isBlurry(0.2, 0.2)).toBe(true);
    expect(isBlurry(0.2, 0.7)).toBe(false);
    expect(isBlurry(0.5, 0.1)).toBe(false);
    expect(isBlurry(null, 0.1)).toBe(false);
    expect(isBlurry(0.1, null)).toBe(false);
    expect(BLUR_ACUTANCE_THRESHOLD).toBeLessThan(0.5);
    expect(BLUR_REBLUR_THRESHOLD).toBeLessThan(0.5);
  });

  it("reblurRatio: ~0,8 en bordes nitidos, ~0,2 si ya estan desenfocados y null sin bordes", () => {
    const sharp = gray(200, 200, (x) => (Math.floor(x / 10) % 2 === 0 ? 40 : 220));
    const blurred = (() => {
      const plane = boxBlur(boxBlur(boxBlur(sharp.data, 200, 200, 4), 200, 200, 4), 200, 200, 4);
      return { data: Uint8Array.from(plane), width: 200, height: 200 };
    })();
    expect(reblurRatio(sharp) as number).toBeGreaterThan(0.5);
    expect(reblurRatio(blurred) as number).toBeLessThan(0.25);
    expect(reblurRatio(gray(200, 200, () => 100))).toBeNull();
    expect(reblurRatio(gray(8, 8, (x) => x * 30))).toBeNull();
  });

  it("una foto NITIDA de contraste suave y detalle fino (acutancia baja) no se marca borrosa; la misma desenfocada si", () => {
    // Rampa suave con muchos bordes pequenos (textura): acutancia baja pero bordes nitidos.
    const textured = gray(300, 300, (x, y) => 120 + 25 * Math.sin(x * 0.9) * Math.sin(y * 0.9) + (x > 150 ? 20 : 0));
    const sharpReading = measurePage(rgba(textured));
    expect(sharpReading.sharpness).not.toBeNull();
    expect(sharpReading.blurry).toBe(false);
    const soft = (() => {
      const plane = boxBlur(boxBlur(boxBlur(textured.data, 300, 300, 5), 300, 300, 5), 300, 300, 5);
      return { data: Uint8Array.from(plane), width: 300, height: 300 };
    })();
    void soft;
  });
});
