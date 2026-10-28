import { describe, expect, it } from "vitest";
import { CARD_MARGIN_FRACTION, refineCrop } from "@/lib/scan/cropRefine";
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
  header?: { height: number; color: Rgb; text?: boolean; /** Inclinacion de la banda: el borde exterior sube/baja `slope` px por px a lo largo del lado. */ slope?: number };
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
      const top = o.header ? y0 - o.header.height - (o.header.slope ?? 0) * (x - x0) : 0;
      if (o.header && x >= x0 && x < x1 && y >= top && y < y0) {
        c = o.header.color;
        if (o.header.text && (y - top) % 8 >= 2 && (y - top) % 8 < 6 && (x - x0) % 12 < 7 && x > x0 + 20 && x < x0 + 200) c = [255, 255, 255];
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
    // Siempre se sale al menos un punto del lado propuesto (margen de seguridad): un recorte exacto nunca se queda justo en el borde.
    expect(result.quad.topLeft.x * W).toBeLessThanOrEqual(BOX[0] - 1);
    expect(result.quad.bottomRight.y * H).toBeGreaterThanOrEqual(BOX[3] + 1);
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

  it("tarjetas: un margen de seguridad extra (CARD_MARGIN_FRACTION del lado) cubre la cabecera casi del color de la mesa que el detector dejo fuera", () => {
    // Cuerpo de la tarjeta 90..310 x 100..270 y, pegada arriba, una cabecera (52,73,94) sobre una mesa (70,72,76): sin borde que ver.
    const body: [number, number, number, number] = [90, 100, 310, 270];
    const image = scene({ box: body, desk: [70, 72, 76], paper: [207, 227, 207], header: { height: 30, color: [52, 73, 94] } });
    const plain = refineCrop(image, quadOf(body));
    const card = refineCrop(image, quadOf(body), { margin: CARD_MARGIN_FRACTION });
    expect(plain.ok && card.ok).toBe(true);
    if (!plain.ok || !card.ok) return;
    // Sin margen extra solo se suma el margen de seguridad corriente; con el, el lado sube CARD_MARGIN_FRACTION * largo del lado (~5-7 px).
    expect(plain.quad.topLeft.y * H).toBeGreaterThan(body[1] - 4);
    expect(card.quad.topLeft.y * H).toBeLessThan(body[1] - 5.5);
    expect(card.quad.bottomRight.x * W).toBeGreaterThan(body[2] + 4.5);
  });

  it("un membrete cuyo borde exterior va INCLINADO respecto al lado (el detector se quedo girado: el final del membrete se aleja del lado a lo largo de el) tambien se detecta", () => {
    const body: [number, number, number, number] = [90, 90, 310, 270];
    // Banda de 22 px en el extremo izquierdo que crece ~13 px hacia la derecha (pendiente 0,06): sus saltos NO estan a la misma distancia.
    // Tono parecido al de la mesa (salto de ~32 niveles) para que solo lo delate su borde, no el contraste del contenido.
    const image = scene({ box: body, desk: [170, 150, 120], header: { height: 22, color: [138, 118, 92], slope: 0.06 } });
    expect(refineCrop(image, quadOf(body))).toMatchObject({ ok: false, reason: "content-beyond", side: 0 });
  });

  it("un membrete de tono PARECIDO al de la mesa (salto de ~30 niveles: se ve el borde, pero no hay contenido que destaque) se detecta por su borde", () => {
    const body: [number, number, number, number] = [90, 110, 310, 270];
    // Banda de 40 px (138,118,92) sobre una mesa (170,150,120): salto de 32 por canal (> STEP_MIN_DELTA, < OUTLIER_DELTA), sin texto.
    const image = scene({ box: body, desk: [170, 150, 120], header: { height: 40, color: [138, 118, 92] } });
    expect(refineCrop(image, quadOf(body))).toMatchObject({ ok: false, reason: "content-beyond", side: 0 });
  });

  it("un lado que hay que empujar mas del 4 % del encuadre pero menos de lo que se mide como «papel que no acaba» tambien se rechaza", () => {
    // El recorte propuesto empieza 14 px dentro por la izquierda (4 % de 300 = 12 px; el tope de lo medible es ~18 px).
    expect(refineCrop(scene({ box: BOX }), quadOf([104, 60, 310, 270]))).toMatchObject({ ok: false, reason: "paper-continues", side: 3 });
  });
  it("REGRESION (fuzz, semilla 5 escena 61): un borde INCLINADO detras del lado que solo se puede medir en parte (cerca del cruce queda a menos de 7 px) se detecta si es una recta limpia", () => {
    const body: [number, number, number, number] = [90, 90, 310, 270];
    // Tono parecido al de la mesa (salto de ~32 niveles: solo lo delata el borde). Banda sin alto a la izquierda que sube 0,05 px por px: el 64 % de las posiciones la tiene a menos de 7 px (no medible) y el resto
    // forma una recta limpia (el 33 % de todas: no llega al 70 % de la regla general, si al 70 % de lo medible).
    const image = scene({ box: body, desk: [170, 150, 120], header: { height: 0, color: [138, 118, 92], slope: 0.05 } });
    expect(refineCrop(image, quadOf(body))).toMatchObject({ ok: false, reason: "content-beyond", side: 0 });
  });

  it("REGRESION (fuzz, semilla 777 escena 84): un membrete que se funde con la mesa y cuyo texto es POCO (casi tan poco como el umbral de la franja entera) se detecta por el texto pegado al lado", () => {
    const body: [number, number, number, number] = [90, 90, 310, 270];
    const image = scene({ box: body, desk: [70, 72, 76], header: { height: 36, color: [68, 75, 87] } });
    // Cuatro trazos blancos de 5 x 2 px a 18-19 px del lado (letras sueltas): 16 puntos ajenos en 8 posiciones; contra TODA la franja de
    // detras (3136 puntos) son el 0,5 %, bajo el umbral de la regla general (0,8 %); contra la franja cercana (1536), el 1,0 %.
    for (const x of [130, 160, 190, 220]) {
      for (let y = 70; y < 72; y += 1) {
        for (let dx = 0; dx < 5; dx += 1) image.data.set([255, 255, 255, 255], (y * W + x + dx) * 4);
      }
    }
    expect(refineCrop(image, quadOf(body))).toMatchObject({ ok: false, reason: "content-beyond", side: 0 });
  });

  it("trazos sueltos de UN solo punto de alto junto al lado (polvo, antialiasing) NO se toman por contenido de un membrete", () => {
    const body: [number, number, number, number] = [90, 90, 310, 270];
    const lone = scene({ box: body, desk: [70, 72, 76] });
    // Diez trazos blancos de 5 x 1 px a 10 px del lado: un solo punto ajeno por posicion.
    for (let i = 0; i < 10; i += 1) for (let dx = 0; dx < 5; dx += 1) lone.data.set([255, 255, 255, 255], (80 * W + 110 + i * 19 + dx) * 4);
    expect(refineCrop(lone, quadOf(body)).ok).toBe(true);
  });
  it("una sombra corta pegada al lado (rampa suave de 10 px, oscura solo en los 2 primeros puntos de la franja que se mira) NO se toma por texto de un membrete: no tiene saltos bruscos", () => {
    const body: [number, number, number, number] = [90, 90, 310, 270];
    const desk: Rgb = [201, 184, 150];
    const image = scene({ box: body, desk });
    // Sobre 30 px del lado de arriba (11 posiciones): un 70 % de oscuridad a 3 px del lado que baja a 0 a 13 px (14 niveles por punto).
    for (let x = 150; x < 180; x += 1) {
      for (let d = 3; d < 13; d += 1) {
        const k = 1 - 0.7 * (1 - (d - 3) / 10);
        image.data.set([desk[0] * k, desk[1] * k, desk[2] * k, 255], ((89 - d) * W + x) * 4);
      }
    }
    expect(refineCrop(image, quadOf(body)).ok).toBe(true);
  });
});
