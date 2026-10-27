import { describe, expect, it } from "vitest";
import { refineCrop } from "@/lib/scan/cropRefine";
import type { QuadCorners } from "@/lib/scan/perspective";
import type { Rgba } from "@/lib/scan/pixels";

/**
 * Los lados del recorte se empujan hasta el borde real del papel y el recorte se rechaza si detras de un lado queda un membrete
 * (borde nitido paralelo, o texto/logo aunque sea del color de la mesa) o el papel no acaba — src/lib/scan/cropRefine.ts.
 */

const W = 400;
const H = 300;
type Rgb = [number, number, number];

type Options = {
  desk?: Rgb;
  paper?: Rgb;
  /** Papel (x0,y0,x1,y1). */
  box: [number, number, number, number];
  /** Banda pegada ARRIBA del papel (alto en px) y su color. */
  header?: { height: number; color: Rgb; text?: boolean };
  /** Sombra suave a la derecha y abajo (px de caida). */
  softShadow?: number;
};

function scene(o: Options): Rgba {
  const desk = o.desk ?? [74, 52, 36];
  const paper = o.paper ?? [240, 238, 232];
  const data = new Uint8ClampedArray(W * H * 4);
  const [x0, y0, x1, y1] = o.box;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      let c: Rgb = desk;
      if (o.softShadow) {
        const dx = Math.max(0, x - x1 + 14);
        const dy = Math.max(0, y - y1 + 14);
        const d = Math.max(dx, dy);
        if (x >= x0 && y >= y0 && d >= 0 && (x >= x1 || y >= y1) && d < o.softShadow + 14) {
          const k = 0.45 + (0.55 * Math.max(0, d - 14)) / o.softShadow;
          c = [desk[0] * k, desk[1] * k, desk[2] * k];
        }
      }
      if (x >= x0 && x < x1 && y >= y0 && y < y1) c = paper;
      if (o.header && x >= x0 && x < x1 && y >= y0 - o.header.height && y < y0) {
        c = o.header.color;
        if (o.header.text && (y - (y0 - o.header.height)) % 8 >= 2 && (y - (y0 - o.header.height)) % 8 < 6 && (x - x0) % 12 < 7 && x > x0 + 20 && x < x0 + 200) c = [255, 255, 255];
      }
      data.set([...c, 255], (y * W + x) * 4);
    }
  }
  return { data, width: W, height: H };
}

const quadOf = (b: [number, number, number, number]): QuadCorners => ({
  topLeft: { x: b[0] / W, y: b[1] / H },
  topRight: { x: b[2] / W, y: b[1] / H },
  bottomRight: { x: b[2] / W, y: b[3] / H },
  bottomLeft: { x: b[0] / W, y: b[3] / H },
});

const BOX: [number, number, number, number] = [90, 60, 310, 270];

describe("ajuste de los lados del recorte — src/lib/scan/cropRefine.ts", () => {
  it("un recorte exacto se queda como esta (solo el margen de seguridad)", () => {
    const result = refineCrop(scene({ box: BOX }), quadOf(BOX));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const shift of result.shifts) expect(shift).toBeLessThanOrEqual(3);
  });

  it("un recorte que se quedo unos pixeles DENTRO del papel se empuja hasta el borde", () => {
    const inside: [number, number, number, number] = [96, 66, 303, 264];
    const result = refineCrop(scene({ box: BOX }), quadOf(inside));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Cada lado estaba a 6-7 px del borde real: tras el ajuste lo alcanza.
    expect(result.quad.topLeft.x * W).toBeLessThanOrEqual(BOX[0] + 0.5);
    expect(result.quad.topLeft.y * H).toBeLessThanOrEqual(BOX[1] + 0.5);
    expect(result.quad.bottomRight.x * W).toBeGreaterThanOrEqual(BOX[2] - 0.5);
    expect(result.quad.bottomRight.y * H).toBeGreaterThanOrEqual(BOX[3] - 0.5);
  });

  it("una sombra suave junto al papel (penumbra ancha) NO se toma por un borde", () => {
    const result = refineCrop(scene({ box: BOX, softShadow: 40 }), quadOf(BOX));
    expect(result.ok).toBe(true);
  });

  it("un membrete OSCURO pegado arriba que el detector dejo fuera (borde nitido paralelo) NO se recorta", () => {
    const body: [number, number, number, number] = [90, 90, 310, 270];
    const result = refineCrop(scene({ box: body, header: { height: 30, color: [20, 24, 32] }, desk: [170, 150, 120] }), quadOf(body));
    expect(result).toMatchObject({ ok: false, reason: "content-beyond", side: 0 });
  });

  it("un membrete del MISMO color que la mesa (sin borde que ver) pero con texto o logo blanco tampoco se recorta", () => {
    const body: [number, number, number, number] = [90, 90, 310, 270];
    const desk: Rgb = [70, 72, 76];
    const result = refineCrop(scene({ box: body, desk, header: { height: 36, color: [68, 75, 87], text: true } }), quadOf(body));
    expect(result).toMatchObject({ ok: false, reason: "content-beyond", side: 0 });
  });

  it("un papel que no acaba (el fondo es del color del papel) se rechaza como «paper-continues»", () => {
    const result = refineCrop(scene({ box: [60, 40, 340, 260], desk: [238, 236, 230] }), quadOf([120, 90, 280, 200]));
    expect(result).toMatchObject({ ok: false, reason: "paper-continues" });
  });

  it("un recorte muy por dentro del papel (hay que empujar un lado mas del 4 % del encuadre) no es fiable: se rechaza", () => {
    // Papel 90..310 x 60..270; el recorte propuesto empieza 30 px dentro por la izquierda.
    const result = refineCrop(scene({ box: BOX }), quadOf([120, 60, 310, 270]));
    expect(result).toMatchObject({ ok: false, reason: "paper-continues", side: 3 });
  });

  it("un lado GIRADO respecto al borde (la cuña de papel que queda fuera crece hacia una esquina) se endereza: la esquina llega al papel, no solo el centro del lado", () => {
    // Papel 90..310 x 60..270. El recorte propuesto acierta arriba a la derecha pero se queda 9 px dentro abajo a la derecha.
    const wedge: QuadCorners = {
      topLeft: { x: 90 / W, y: 60 / H },
      topRight: { x: 310 / W, y: 60 / H },
      bottomRight: { x: 301 / W, y: 270 / H },
      bottomLeft: { x: 90 / W, y: 270 / H },
    };
    const result = refineCrop(scene({ box: BOX }), wedge);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.quad.bottomRight.x * W).toBeGreaterThanOrEqual(309);
    expect(result.quad.topRight.x * W).toBeGreaterThanOrEqual(309);
    // Y el extremo que ya estaba bien NO se ensancha por culpa del otro (un empuje paralelo lo sacaria ~8 px del papel).
    expect(result.quad.topRight.x * W).toBeLessThanOrEqual(313);
  });
});
