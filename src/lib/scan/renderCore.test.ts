import { describe, expect, it } from "vitest";
import { ID_CARD_RATIO, abortIfNeeded, cropAndRotate, needsWarp, planOutputSize, renderRgba, rotateQuad, thumbnailOf, type RenderJob } from "@/lib/scan/renderCore";
import { DEFAULT_QUAD, type QuadCorners } from "@/lib/scan/perspective";
import type { Rgba } from "@/lib/scan/pixels";

/** Foto 200 x 100: fondo gris, hoja inclinada roja a la izquierda y azul a la derecha. */
function photo(): Rgba {
  const width = 200;
  const height = 100;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= 40 && x < 160 && y >= 20 && y < 80;
      const v: [number, number, number] = inside ? (x < 100 ? [220, 30, 30] : [30, 30, 220]) : [90, 90, 90];
      data.set([...v, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

const sheet: QuadCorners = { topLeft: { x: 0.2, y: 0.2 }, topRight: { x: 0.8, y: 0.2 }, bottomRight: { x: 0.8, y: 0.8 }, bottomLeft: { x: 0.2, y: 0.8 } };
const job = (patch: Partial<RenderJob> = {}): RenderJob => ({ corners: sheet, rotation: 0, filter: "color", adjust: { brightness: 0, contrast: 0 }, mode: "document", maxSide: 2000, ...patch });
const px = (image: Rgba, x: number, y: number) => Array.from(image.data.slice((y * image.width + x) * 4, (y * image.width + x) * 4 + 3));

describe("renderCore — src/lib/scan/renderCore.ts", () => {
  it("recorta la hoja: sale solo la zona roja y azul, a su tamano, sin tocar el origen", async () => {
    const src = photo();
    const before = Array.from(src.data);
    const out = await renderRgba(src, job());
    expect([out.image.width, out.image.height]).toEqual([120, 60]);
    expect(px(out.image, 5, 30)[0]).toBeGreaterThan(200);
    expect(px(out.image, 115, 30)[2]).toBeGreaterThan(200);
    expect(Array.from(src.data)).toEqual(before);
  });

  it("el giro de 90 grados es horario y se hace en el mismo remuestreo: el rojo queda ARRIBA", async () => {
    const out = await renderRgba(photo(), job({ rotation: 90 }));
    expect([out.image.width, out.image.height]).toEqual([60, 120]);
    expect(px(out.image, 30, 5)[0]).toBeGreaterThan(200);
    expect(px(out.image, 30, 115)[2]).toBeGreaterThan(200);
    const half = await renderRgba(photo(), job({ rotation: 180 }));
    expect(px(half.image, 115, 30)[0]).toBeGreaterThan(200);
    const turned = await renderRgba(photo(), job({ rotation: 270 }));
    expect(px(turned.image, 30, 115)[0]).toBeGreaterThan(200);
  });

  it("sin esquinas ni giro es una copia (o una version reducida) de la foto; con giro y sin esquinas gira la foto entera", async () => {
    const src = photo();
    const copy = await cropAndRotate(src, job({ corners: null }));
    expect(copy).not.toBe(src);
    expect(copy.data).not.toBe(src.data);
    expect(Array.from(copy.data)).toEqual(Array.from(src.data));
    const reduced = await cropAndRotate(src, job({ corners: null, maxSide: 100 }));
    expect([reduced.width, reduced.height]).toEqual([100, 50]);
    const turned = await cropAndRotate(src, job({ corners: null, rotation: 90 }));
    expect([turned.width, turned.height]).toEqual([100, 200]);
  });

  it("modo foto: ni recorte ni filtro (solo el giro si se pide)", async () => {
    const src = photo();
    const out = await renderRgba(src, job({ mode: "photo", filter: "bw", corners: sheet }));
    expect(out.resolved).toBe("original");
    expect([out.image.width, out.image.height]).toEqual([200, 100]);
    expect(Array.from(out.image.data)).toEqual(Array.from(src.data));
    expect(needsWarp(sheet, 0, "photo")).toBe(false);
    expect(needsWarp(sheet, 90, "photo")).toBe(true);
    expect(needsWarp(null, 0, "document")).toBe(false);
    expect(needsWarp(DEFAULT_QUAD, 0, "document")).toBe(false);
    expect(needsWarp(sheet, 0, "document")).toBe(true);
  });

  it("el filtro se aplica sobre el recorte y se reporta el resuelto; la calidad se mide SIN filtrar", async () => {
    const out = await renderRgba(photo(), job({ filter: "grayscale" }), {}, { measure: true });
    expect(out.resolved).toBe("grayscale");
    expect(px(out.image, 5, 30)[0]).toBe(px(out.image, 5, 30)[1]);
    expect(out.quality).not.toBeNull();
    let seenCrop: Rgba | null = null;
    await renderRgba(photo(), job({ filter: "bw" }), {}, { onCrop: (crop) => (seenCrop = { data: new Uint8ClampedArray(crop.data), width: crop.width, height: crop.height }) });
    // La copia que ve `onCrop` es la previa al filtro: sigue en color.
    expect(px(seenCrop as unknown as Rgba, 5, 30)[0]).toBeGreaterThan(px(seenCrop as unknown as Rgba, 5, 30)[1] + 100);
  });

  it("maxSide acota la salida y nunca amplia", async () => {
    const out = await renderRgba(photo(), job({ maxSide: 60 }));
    expect(Math.max(out.image.width, out.image.height)).toBe(60);
    const big = await renderRgba(photo(), job({ maxSide: 5000 }));
    expect(big.image.width).toBe(120);
  });

  it("tarjeta: la proporcion se ajusta a la de un carnet (1,586) si la medida va cerca; un rectangulo cualquiera no se toca", () => {
    const src = { width: 1000, height: 800 };
    const card: QuadCorners = { topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.8, y: 0.1 }, bottomRight: { x: 0.8, y: 0.61 }, bottomLeft: { x: 0.1, y: 0.61 } };
    const out = planOutputSize(card, src, "id-card", 4000);
    expect(out.width / out.height).toBeCloseTo(ID_CARD_RATIO, 2);
    const odd: QuadCorners = { topLeft: { x: 0.1, y: 0.1 }, topRight: { x: 0.8, y: 0.1 }, bottomRight: { x: 0.8, y: 0.9 }, bottomLeft: { x: 0.1, y: 0.9 } };
    const same = planOutputSize(odd, src, "id-card", 4000);
    expect(same.width / same.height).toBeCloseTo(700 / 640, 2);
    // En modo documento no se fuerza nada.
    const doc = planOutputSize(card, src, "document", 4000);
    expect(doc.width / doc.height).toBeCloseTo(700 / 408, 2);
  });

  it("rotateQuad: cuatro cuartos de vuelta devuelven el cuadrilatero y uno mueve BL a TL", () => {
    expect(rotateQuad(sheet, 1).topLeft).toEqual(sheet.bottomLeft);
    expect(rotateQuad(sheet, 4)).toEqual(sheet);
    expect(rotateQuad(sheet, -1).topLeft).toEqual(sheet.topRight);
    expect(rotateQuad(sheet, 2).topLeft).toEqual(sheet.bottomRight);
  });

  it("cede el hilo entre bandas y se puede cancelar a mitad (AbortError)", async () => {
    let yields = 0;
    await renderRgba(photo(), job({ maxSide: 4000, corners: { ...sheet } }), { yield: () => void (yields += 1) });
    expect(yields).toBeGreaterThanOrEqual(0);
    const controller = new AbortController();
    controller.abort();
    await expect(renderRgba(photo(), job(), { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(() => abortIfNeeded(controller.signal)).toThrow();
    expect(() => abortIfNeeded(undefined)).not.toThrow();
    const late = new AbortController();
    const big: Rgba = { data: new Uint8ClampedArray(3000 * 2000 * 4).fill(200), width: 3000, height: 2000 };
    let calls = 0;
    await expect(
      renderRgba(big, job({ maxSide: 3000, corners: { topLeft: { x: 0.05, y: 0.05 }, topRight: { x: 0.95, y: 0.06 }, bottomRight: { x: 0.94, y: 0.95 }, bottomLeft: { x: 0.06, y: 0.94 } } }), {
        signal: late.signal,
        yield: () => {
          calls += 1;
          if (calls === 2) late.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(2);
  });

  it("thumbnailOf reduce al lado largo pedido", () => {
    const t = thumbnailOf({ data: new Uint8ClampedArray(800 * 400 * 4), width: 800, height: 400 }, 360);
    expect([t.width, t.height]).toEqual([360, 180]);
  });

  it("la nitidez se mide con MAS resolucion que la miniatura de la pagina: un texto muy desenfocado se ve borroso aunque la salida sea de 640 px", async () => {
    const { decodedLikeEngine, textDocument } = await import("@/lib/scan/__fixtures__/blurDocs");
    const blurred = decodedLikeEngine(textDocument(3, 10));
    const out = await renderRgba(blurred, job({ corners: null, maxSide: 640 }), {}, { measure: true });
    expect(Math.max(out.image.width, out.image.height)).toBeLessThanOrEqual(640);
    expect(out.quality?.blurry).toBe(true);
    const sharp = await renderRgba(decodedLikeEngine(textDocument(3, 0)), job({ corners: null, maxSide: 640 }), {}, { measure: true });
    expect(sharp.quality?.blurry).toBe(false);
  }, 60_000);
});
