import { describe, expect, it } from "vitest";
import { MIN_EDGE_SUPPORT, MIN_PAPER_SHARE, evaluateCrop, gateLimits, selectCrop } from "@/lib/scan/cropGate";
import type { QuadCorners } from "@/lib/scan/perspective";
import type { Rgba } from "@/lib/scan/pixels";

/** Escena 400 x 300: fondo `bg` y un rectangulo `box` (x0,y0,x1,y1) de color `fg`, opcionalmente con lineas de texto. */
function scene(options: { bg: [number, number, number]; fg: [number, number, number]; box: [number, number, number, number]; text?: boolean; width?: number; height?: number }): Rgba {
  const width = options.width ?? 400;
  const height = options.height ?? 300;
  const data = new Uint8ClampedArray(width * height * 4);
  const [x0, y0, x1, y1] = options.box;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
      let color = inside ? options.fg : options.bg;
      if (inside && options.text && (y - y0) % 14 >= 5 && (y - y0) % 14 < 8 && x > x0 + 12 && x < x1 - 12 && (x - x0) % 9 < 6) color = [25, 25, 30];
      data.set([...color, 255], (y * width + x) * 4);
    }
  }
  return { data, width, height };
}

const quadOf = (box: [number, number, number, number], width = 400, height = 300): QuadCorners => ({
  topLeft: { x: box[0] / width, y: box[1] / height },
  topRight: { x: box[2] / width, y: box[1] / height },
  bottomRight: { x: box[2] / width, y: box[3] / height },
  bottomLeft: { x: box[0] / width, y: box[3] / height },
});

describe("puerta del recorte automatico — src/lib/scan/cropGate.ts", () => {
  it("una hoja con texto sobre un escritorio oscuro SE RECORTA", () => {
    const box: [number, number, number, number] = [90, 20, 310, 280];
    const verdict = evaluateCrop(scene({ bg: [55, 52, 60], fg: [236, 232, 224], box, text: true }), quadOf(box), "document");
    expect(verdict).toMatchObject({ accept: true, reason: "ok" });
    expect(verdict.features.support).toBeGreaterThanOrEqual(MIN_EDGE_SUPPORT);
    expect(verdict.features.paperShare).toBeGreaterThanOrEqual(MIN_PAPER_SHARE);
  });

  it("un rectangulo ROJO dentro de una pagina blanca a sangre (480 x 60 sobre 600 x 800) NO se recorta: ya es toda documento", () => {
    const image = scene({ bg: [255, 255, 255], fg: [208, 32, 32], box: [60, 120, 540, 180], width: 600, height: 800 });
    const verdict = evaluateCrop(image, quadOf([60, 120, 540, 180], 600, 800), "document");
    expect(verdict.accept).toBe(false);
    // Proporcion de franja (8:1), color y cobertura: varios motivos independientes.
    expect(["aspect", "area"]).toContain(verdict.reason);
    // Aunque la franja fuera «razonable» (un cuadrado rojo grande), el interior no es papel.
    const square = scene({ bg: [255, 255, 255], fg: [208, 32, 32], box: [100, 100, 300, 260] });
    expect(evaluateCrop(square, quadOf([100, 100, 300, 260]), "document")).toMatchObject({ accept: false, reason: "not-paper" });
  });

  it("un rectangulo de papel sobre papel igual (misma claridad y color) NO se recorta: no hay fondo distinto", () => {
    const box: [number, number, number, number] = [80, 40, 320, 270];
    const image = scene({ bg: [238, 236, 230], fg: [240, 238, 232], box, text: true });
    expect(evaluateCrop(image, quadOf(box), "document")).toMatchObject({ accept: false });
  });

  it("papel con bordes nitidos y buena cobertura pero casi igual que lo de fuera (hoja blanca a sangre con un recuadro mas claro) se rechaza SOLO por «same-as-outside»", () => {
    const box: [number, number, number, number] = [80, 40, 320, 270];
    const verdict = evaluateCrop(scene({ bg: [226, 226, 226], fg: [246, 246, 246], box, text: true }), quadOf(box), "document");
    // Todo lo demas pasa: cobertura, proporcion, bordes reales y aspecto de papel por dentro.
    expect(verdict.features.support).toBeGreaterThanOrEqual(MIN_EDGE_SUPPORT);
    expect(verdict.features.paperShare).toBeGreaterThanOrEqual(MIN_PAPER_SHARE);
    expect(verdict).toMatchObject({ accept: false, reason: "same-as-outside" });
  });

  it("cobertura: una mota (< 22 % del encuadre) o casi todo el encuadre no se recorta", () => {
    const tiny: [number, number, number, number] = [180, 120, 230, 170];
    expect(evaluateCrop(scene({ bg: [50, 50, 55], fg: [240, 240, 235], box: tiny }), quadOf(tiny), "document").reason).toBe("area");
    const nearlyAll: [number, number, number, number] = [4, 4, 396, 296];
    expect(evaluateCrop(scene({ bg: [50, 50, 55], fg: [240, 240, 235], box: nearlyAll }), quadOf(nearlyAll), "document").reason).toBe("area");
  });

  it("proporcion plausible por modo: una tira muy alargada es un recibo, no una hoja; una hoja no sirve de carnet", () => {
    const strip: [number, number, number, number] = [150, 5, 250, 295];
    const image = scene({ bg: [50, 50, 55], fg: [240, 240, 235], box: strip, text: true });
    expect(evaluateCrop(image, quadOf(strip), "document").reason).toBe("aspect");
    expect(evaluateCrop(image, quadOf(strip), "receipt").reason).not.toBe("aspect");
    const sheet: [number, number, number, number] = [100, 20, 300, 280];
    expect(evaluateCrop(scene({ bg: [50, 50, 55], fg: [240, 240, 235], box: sheet, text: true }), quadOf(sheet), "id-card").reason).toBe("aspect");
  });

  it("una tarjeta de colores con proporcion de carnet SE RECORTA en modo identificacion (el interior no tiene que ser papel)", () => {
    const box: [number, number, number, number] = [60, 70, 340, 246];
    const image = scene({ bg: [190, 150, 100], fg: [40, 80, 170], box });
    expect(evaluateCrop(image, quadOf(box), "id-card")).toMatchObject({ accept: true });
    // El mismo azul como «documento» no es papel.
    expect(evaluateCrop(image, quadOf(box), "document").accept).toBe(false);
  });

  it("los lados deben ser bordes reales: un cuadrilatero que no sigue ningun borde no se recorta", () => {
    const real: [number, number, number, number] = [90, 20, 310, 280];
    const image = scene({ bg: [55, 52, 60], fg: [236, 232, 224], box: real, text: true });
    const shifted = quadOf([30, 10, 250, 270]);
    expect(evaluateCrop(image, shifted, "document").reason).toBe("edges");
  });

  it("limites por modo y selectCrop: modo foto nunca recorta; sin candidato, null; con uno bueno lo devuelve", () => {
    expect(gateLimits("receipt").minArea).toBeLessThan(gateLimits("document").minArea);
    expect(gateLimits("id-card").paper).toBe(false);
    expect(gateLimits("document").paper).toBe(true);
    const box: [number, number, number, number] = [90, 20, 310, 280];
    const image = scene({ bg: [55, 52, 60], fg: [236, 232, 224], box, text: true });
    const quad = quadOf(box);
    expect(selectCrop(quad, null, image, "photo")).toEqual({ quad: null, verdict: null });
    expect(selectCrop(null, null, image, "document")).toEqual({ quad: null, verdict: null });
    const accepted = selectCrop(quad, null, image, "document").quad;
    expect(accepted).not.toBeNull();
    // Se aplica el recorte propuesto con los lados empujados unos pixeles hacia fuera (margen de seguridad), nunca hacia dentro.
    expect(accepted?.topLeft.x).toBeLessThanOrEqual(quad.topLeft.x);
    expect(accepted?.topLeft.x).toBeGreaterThan(quad.topLeft.x - 0.03);
    expect(accepted?.bottomRight.y).toBeGreaterThanOrEqual(quad.bottomRight.y);
    const rejected = selectCrop(quadOf([30, 10, 250, 270]), null, image, "document");
    expect(rejected.quad).toBeNull();
    expect(rejected.verdict?.accept).toBe(false);
  });

  it("un membrete oscuro que el detector dejo FUERA del recorte: selectCrop devuelve null (pagina completa) y dice por que", () => {
    // Papel claro 90..310 x 100..270 y, pegado arriba, una banda oscura de 40 px sobre una mesa clara (borde nitido paralelo).
    const width = 400;
    const height = 300;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        let c: [number, number, number] = [170, 150, 120];
        if (x >= 90 && x < 310 && y >= 60 && y < 100) c = [20, 24, 32];
        if (x >= 90 && x < 310 && y >= 100 && y < 270) c = [238, 236, 230];
        data.set([...c, 255], (y * width + x) * 4);
      }
    }
    const result = selectCrop(quadOf([90, 100, 310, 270]), null, { data, width, height }, "document");
    expect(result.quad).toBeNull();
    expect(result.verdict).toMatchObject({ accept: false, reason: "content-beyond" });
  });

  it("modo id-card: el recorte lleva un margen extra (CARD_MARGIN_FRACTION) que el modo documento no lleva", () => {
    const box: [number, number, number, number] = [110, 80, 290, 190]; // 180 x 110: proporcion de tarjeta (1,64)
    const image = scene({ bg: [55, 52, 60], fg: [236, 232, 224], box });
    const card = selectCrop(quadOf(box), null, image, "id-card").quad;
    const doc = selectCrop(quadOf(box), null, image, "document");
    expect(card).not.toBeNull();
    if (!card) return;
    // Sin margen extra, un documento reconocido avanza solo el margen de seguridad corriente (~2 px); la tarjeta, ~3 % del lado (~5 px).
    const cardGrow = quadOf(box).topLeft.x * 400 - card.topLeft.x * 400;
    expect(cardGrow).toBeGreaterThan(4);
    if (doc.quad) expect(quadOf(box).topLeft.x * 400 - doc.quad.topLeft.x * 400).toBeLessThan(cardGrow);
  });
});
