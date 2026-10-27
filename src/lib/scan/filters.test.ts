import { describe, expect, it } from "vitest";
import { adjustLookup, applyAdjust, applyFilterTo, backgroundMapsFor, decideAutoFilter, enhanceDocument, enhanceWhiteboard, resolveFilter, toBlackAndWhite, toEnhanced, toGrayscale } from "@/lib/scan/filters";
import type { Rgba } from "@/lib/scan/pixels";

function make(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      data.set([r, g, b, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

/** Papel con un degradado de sombra de izquierda (claro) a derecha (oscuro) y lineas de texto. */
function shadowedPaper(width = 120, height = 160, shade = 0.55): Rgba {
  return make(width, height, (x, y) => {
    const light = 250 * (1 - (1 - shade) * (x / width));
    const text = y % 16 >= 6 && y % 16 < 9 && x > 12 && x < width - 12;
    const v = text ? light * 0.18 : light;
    return [v, v, v];
  });
}

describe("filtros clasicos (movidos de scanToPdf.ts) — src/lib/scan/filters.ts", () => {
  it("grayscale deja R=G=B con la luminancia y no toca el alfa", () => {
    const img = make(2, 1, (x) => (x === 0 ? [255, 0, 0] : [0, 0, 255]));
    toGrayscale(img.data);
    expect(img.data[0]).toBe(img.data[1]);
    expect(img.data[1]).toBe(img.data[2]);
    expect(img.data[0]).toBeCloseTo(255 * 0.299, 0);
    expect(img.data[4]).toBeCloseTo(255 * 0.114, 0);
    expect(img.data[3]).toBe(255);
  });

  it("blanco y negro aplica la curva fija (contraste 1,35 + brillo 8)", () => {
    const img = make(3, 1, (x) => [[40, 40, 40], [128, 128, 128], [220, 220, 220]][x] as [number, number, number]);
    toBlackAndWhite(img.data);
    expect(img.data[0]).toBe(Math.round((40 - 128) * 1.35 + 128 + 8 > 0 ? (40 - 128) * 1.35 + 128 + 8 : 0));
    expect(img.data[4]).toBe(136);
    expect(img.data[8]).toBe(255);
  });

  it("enhance estira el histograma y deja intacta una imagen plana o ya a rango completo", () => {
    const low = make(4, 1, (x) => [100 + x * 10, 100 + x * 10, 100 + x * 10]);
    toEnhanced(low.data);
    expect(low.data[0]).toBe(0);
    expect(low.data[12]).toBe(255);
    const flat = make(4, 1, () => [90, 90, 90]);
    toEnhanced(flat.data);
    expect(flat.data[0]).toBe(90);
    const full = make(2, 1, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
    const before = Array.from(full.data);
    toEnhanced(full.data);
    expect(Array.from(full.data)).toEqual(before);
  });
});

describe("brillo y contraste", () => {
  it("(0, 0) no cambia nada y los extremos suben o bajan la luz", () => {
    expect(adjustLookup({ brightness: 0, contrast: 0 })).toBeNull();
    const base = make(1, 1, () => [128, 128, 128]);
    const up = { ...base, data: new Uint8ClampedArray(base.data) };
    applyAdjust(up.data, { brightness: 1, contrast: 0 });
    expect(up.data[0]).toBe(192);
    const down = { ...base, data: new Uint8ClampedArray(base.data) };
    applyAdjust(down.data, { brightness: -1, contrast: 0 });
    expect(down.data[0]).toBe(64);
    expect(up.data[3]).toBe(255);
  });

  it("el contraste aleja los tonos del gris medio y se acota a -1..1", () => {
    const px = make(2, 1, (x) => (x === 0 ? [100, 100, 100] : [160, 160, 160]));
    applyAdjust(px.data, { brightness: 0, contrast: 5 });
    // Se acota a 1: factor 1,8.
    expect(px.data[0]).toBe(Math.round((100 - 128) * 1.8 + 128));
    expect(px.data[4]).toBe(Math.round((160 - 128) * 1.8 + 128));
  });
});

describe("documento mejorado: correccion de fondo y sombras", () => {
  it("aplana el degradado: el papel de la zona en sombra queda tan blanco como el de la zona clara y el texto sigue oscuro", async () => {
    const img = shadowedPaper();
    const lightBefore = img.data[(3 * 120 + 5) * 4];
    const darkBefore = img.data[(3 * 120 + 114) * 4];
    expect(lightBefore - darkBefore).toBeGreaterThan(80);
    await enhanceDocument(img);
    const paperLeft = img.data[(3 * 120 + 5) * 4];
    const paperRight = img.data[(3 * 120 + 114) * 4];
    expect(paperLeft).toBeGreaterThan(245);
    expect(paperRight).toBeGreaterThan(245);
    // Un pixel de texto (fila 6-8 de cada 16, en la zona de sombra) queda oscuro.
    expect(img.data[(7 * 120 + 100) * 4]).toBeLessThan(80);
  });

  it("quita el tinte del papel (amarillento -> blanco) y conserva la tinta azul", async () => {
    const img = make(120, 120, (x, y) => (y % 20 >= 8 && y % 20 < 11 && x > 10 && x < 110 ? [30, 50, 150] : [245, 238, 205]));
    await enhanceDocument(img);
    const paper = img.data.slice((2 * 120 + 5) * 4, (2 * 120 + 5) * 4 + 3);
    expect(Math.min(...paper)).toBeGreaterThan(240);
    const ink = img.data.slice((9 * 120 + 60) * 4, (9 * 120 + 60) * 4 + 3);
    expect(ink[2]).toBeGreaterThan(ink[0] + 30);
  });

  it("cede el hilo entre bandas y puede mutar solo su propia copia", async () => {
    const img = shadowedPaper(60, 200);
    let yields = 0;
    await enhanceDocument(img, { band: 32, onBand: () => void (yields += 1) });
    expect(yields).toBeGreaterThanOrEqual(5);
  });

  it("pizarra: el fondo gris pasa a blanco y el rotulador conserva su color", async () => {
    const img = make(120, 80, (x, y) => (y > 30 && y < 36 && x > 10 && x < 100 ? [190, 40, 40] : [196, 200, 202]));
    await enhanceWhiteboard(img);
    expect(img.data[(5 * 120 + 5) * 4]).toBeGreaterThan(245);
    const ink = img.data.slice((33 * 120 + 50) * 4, (33 * 120 + 50) * 4 + 3);
    expect(ink[0]).toBeGreaterThan(ink[1] + 40);
  });
});

describe("filtro automatico", () => {
  it("un documento de texto sobre papel -> document; una foto de colores variados -> photo", () => {
    const doc = shadowedPaper(120, 160, 0.8);
    expect(decideAutoFilter(doc).kind).toBe("document");
    const photo = make(120, 90, (x, y) => [(x * 7 + y * 3) % 256, (x * 5) % 256, (y * 11) % 256]);
    expect(decideAutoFilter(photo).kind).toBe("photo");
    // Un papel oscuro (poca luz) sigue siendo un documento.
    const dim = make(120, 160, (x, y) => (y % 16 >= 6 && y % 16 < 9 && x > 12 && x < 108 ? [10, 10, 10] : [80, 80, 80]));
    expect(decideAutoFilter(dim).kind).toBe("document");
  });

  it("resolveFilter: modo foto = original; auto en pizarra = pizarra; en tarjeta = color; los demas pasan tal cual", () => {
    const doc = shadowedPaper();
    expect(resolveFilter("bw", "photo", doc)).toBe("original");
    expect(resolveFilter("auto", "whiteboard", doc)).toBe("whiteboard");
    expect(resolveFilter("auto", "id-card", doc)).toBe("color");
    expect(resolveFilter("auto", "document", doc)).toBe("enhance");
    expect(resolveFilter("grayscale", "receipt", doc)).toBe("grayscale");
    expect(resolveFilter("original", "document", doc)).toBe("original");
  });

  it("applyFilterTo: `original` no toca ni el ajuste; `color` solo aplica el ajuste", async () => {
    const a = make(4, 4, () => [100, 120, 140]);
    await applyFilterTo(a, "original", { brightness: 1, contrast: 1 });
    expect(a.data[0]).toBe(100);
    const b = make(4, 4, () => [100, 120, 140]);
    await applyFilterTo(b, "color", { brightness: 0, contrast: 0 });
    expect(b.data[0]).toBe(100);
    await applyFilterTo(b, "color", { brightness: 0.5, contrast: 0 });
    expect(b.data[0]).toBe(132);
    const c = make(4, 4, () => [100, 120, 140]);
    await applyFilterTo(c, "grayscale", { brightness: 0, contrast: 0 });
    expect(c.data[0]).toBe(c.data[2]);
  });

  it("un fragmento filtrado con el FONDO de la hoja entera sale como en la hoja entera: el fondo se busca en SU posicion", async () => {
    // Hoja de 400 x 200 con una sombra de izquierda (claro) a derecha (oscuro) y lineas de texto.
    const page = make(400, 200, (x, y) => {
      const light = 240 - (x / 400) * 130;
      return y % 20 >= 8 && y % 20 < 11 && x > 10 && x < 390 ? [20, 20, 20] : [light, light, light];
    });
    const whole = { data: new Uint8ClampedArray(page.data), width: 400, height: 200 };
    await enhanceDocument(whole);
    const crop = (image: typeof page, x: number, y: number, size: number) => {
      const data = new Uint8ClampedArray(size * size * 4);
      for (let row = 0; row < size; row += 1) data.set(image.data.subarray(((y + row) * image.width + x) * 4, ((y + row) * image.width + x + size) * 4), row * size * 4);
      return { data, width: size, height: size };
    };
    const paper = (image: { data: Uint8ClampedArray; width: number }) => image.data[(2 * image.width + 4) * 4];
    const expected = crop(whole, 300, 100, 80);
    const maps = backgroundMapsFor(page, 400, 200);
    const right = crop(page, 300, 100, 80);
    await enhanceDocument(right, { background: { maps, x: 300, y: 100 } });
    // En la zona oscura del lado derecho el papel queda tan blanco como en la hoja entera...
    expect(paper(expected)).toBeGreaterThan(240);
    expect(Array.from(right.data)).toEqual(Array.from(expected.data));
    // ...pero con el fondo de OTRA posicion (la izquierda, clara) queda gris: la posicion cuenta.
    const wrongSpot = crop(page, 300, 100, 80);
    await enhanceDocument(wrongSpot, { background: { maps, x: 0, y: 100 } });
    expect(paper(wrongSpot)).toBeLessThan(paper(right) - 40);
    // applyFilterTo lo pasa al filtro.
    const viaApply = crop(page, 300, 100, 80);
    await applyFilterTo(viaApply, "enhance", { brightness: 0, contrast: 0 }, { background: { maps, x: 300, y: 100 } });
    expect(Array.from(viaApply.data)).toEqual(Array.from(right.data));
  });
});
