import { describe, expect, it } from "vitest";
import {
  coversPage,
  isInkLike,
  judgeInkImage,
  judgeLogoImage,
  judgePhotoImage,
  judgeStampImage,
  judgeWatermarkImage,
  mergeReasons,
  stampShape,
  type DecisionInput,
} from "./classifyRules";
import { HEURISTIC_MAX_CONFIDENCE } from "./classifyTypes";
import { inkFeatures, label, signatureGeometry } from "./classify.testUtils";
import type { NearLabel } from "./classifyText";

/** Reglas del clasificador de imagenes: cada umbral con su limite (lo que mueren las mutaciones). */

const near = (kind: "signature" | "initials", strength = 1): NearLabel => ({ label: label(kind, { strength }), distance: 0.3 });

function input(over: Partial<DecisionInput> = {}): DecisionInput {
  return { features: inkFeatures(), geometry: signatureGeometry(), signatureLabel: null, initialsLabel: null, analyzedPages: 3, scannedPage: false, ...over };
}

describe("isInkLike", () => {
  it("una firma de tinta fina azul sobre fondo transparente lo es", () => {
    expect(isInkLike(inkFeatures())).toBe(true);
  });
  it("sin rasgos (sin miniatura) no lo es", () => {
    expect(isInkLike(null)).toBe(false);
  });
  it("sin fondo claro no", () => {
    expect(isInkLike(inkFeatures({ lightBackground: false }))).toBe(false);
  });
  it("tinta entre 0,4 % y 45 % de los pixeles", () => {
    expect(isInkLike(inkFeatures({ inkFraction: 0.004 }))).toBe(true);
    expect(isInkLike(inkFeatures({ inkFraction: 0.003 }))).toBe(false);
    expect(isInkLike(inkFeatures({ inkFraction: 0.45 }))).toBe(true);
    expect(isInkLike(inkFeatures({ inkFraction: 0.46 }))).toBe(false);
  });
  it("solidez maxima 0,6 (0,9 con tinta gruesa de un color y poca tinta, solo en modo laxo)", () => {
    expect(isInkLike(inkFeatures({ solidity: 0.6 }))).toBe(true);
    expect(isInkLike(inkFeatures({ solidity: 0.61 }))).toBe(false);
    expect(isInkLike(inkFeatures({ solidity: 0.7 }), true)).toBe(true);
    expect(isInkLike(inkFeatures({ solidity: 0.9 }), true)).toBe(true);
    expect(isInkLike(inkFeatures({ solidity: 0.91 }), true)).toBe(false);
    expect(isInkLike(inkFeatures({ solidity: 0.7, colorBins: 7 }), true)).toBe(false);
    expect(isInkLike(inkFeatures({ solidity: 0.7, colorBins: 6 }), true)).toBe(true);
    expect(isInkLike(inkFeatures({ solidity: 0.7, inkFraction: 0.31 }), true)).toBe(false);
    expect(isInkLike(inkFeatures({ solidity: 0.7, inkFraction: 0.3 }), true)).toBe(true);
    // El modo laxo NO afloja los limites de colores y tinta cuando el trazo ya es fino.
    expect(isInkLike(inkFeatures({ solidity: 0.3, colorBins: 20 }), true)).toBe(true);
  });
  it("la tinta ha de ser oscura o azul (>= 70 % entre las dos)", () => {
    expect(isInkLike(inkFeatures({ darkShare: 0.35, blueShare: 0.35 }))).toBe(true);
    expect(isInkLike(inkFeatures({ darkShare: 0.3, blueShare: 0.3 }))).toBe(false);
  });
  it("las barras (codigo de barras) no", () => {
    expect(isInkLike(inkFeatures({ fullSpanShare: 0.12 }))).toBe(true);
    expect(isInkLike(inkFeatures({ fullSpanShare: 0.13 }))).toBe(false);
  });
});

describe("stampShape", () => {
  const stamp = (over = {}) => inkFeatures({ inkFraction: 0.24, chromaticShare: 1, dominantHueShare: 1, inkSaturation: 0.85, ringShare: 0.65, centerShare: 0.34, frameShare: 0.4, ...over });
  it("aro: tinta saturada de un tono en el borde de la elipse con el centro casi vacio", () => {
    expect(stampShape(stamp())).toBe("ring");
    expect(stampShape(stamp({ ringShare: 0.54 }))).toBeNull();
    expect(stampShape(stamp({ centerShare: 0.46 }))).toBeNull();
    expect(stampShape(stamp({ centerShare: 0.45 }))).toBe("ring");
  });
  it("marco: tinta pegada al borde de la caja (>= 45 %)", () => {
    expect(stampShape(stamp({ ringShare: 0.3, frameShare: 0.45 }))).toBe("frame");
    expect(stampShape(stamp({ ringShare: 0.3, frameShare: 0.44 }))).toBeNull();
  });
  it("exige color saturado, de un solo tono y cromatico", () => {
    expect(stampShape(stamp({ chromaticShare: 0.59 }))).toBeNull();
    expect(stampShape(stamp({ dominantHueShare: 0.74 }))).toBeNull();
    expect(stampShape(stamp({ inkSaturation: 0.44 }))).toBeNull();
    expect(stampShape(stamp({ inkFraction: 0.009 }))).toBeNull();
    expect(stampShape(null)).toBeNull();
  });
});

describe("judgeInkImage · firma", () => {
  it("firma transparente con la etiqueta «Firma» cerca: probable (0,88), con motivos legibles", () => {
    const d = judgeInkImage(input({ signatureLabel: near("signature") }));
    expect(d?.kind).toBe("signature");
    expect(d?.confidence).toBe(0.88);
    expect(d?.reasons).toEqual(["tinta fina azul", "fondo transparente", "proporción 3,3:1 de firma", "altura del 7 % de la página", "cerca de «Firma»"]);
  });
  it("sobre fondo casi blanco opaco con la etiqueta: 0,86", () => {
    const d = judgeInkImage(input({ features: inkFeatures({ transparent: 0, hasAlpha: false, darkShare: 0.95, blueShare: 0 }), signatureLabel: near("signature") }));
    expect(d?.confidence).toBe(0.86);
    expect(d?.reasons).toContain("fondo casi blanco");
    expect(d?.reasons[0]).toBe("tinta fina oscura");
  });
  it("sin etiqueta una firma transparente queda en «posible» (0,65)", () => {
    const d = judgeInkImage(input());
    expect(d?.kind).toBe("signature");
    expect(d?.confidence).toBe(0.65);
  });
  it("una etiqueta debil («Insured», 0,5) sube menos (0,76)", () => {
    const d = judgeInkImage(input({ signatureLabel: near("signature", 0.5) }));
    expect(d?.confidence).toBe(0.76);
  });
  it("nunca pasa de 0,89: una heuristica no es «segura»", () => {
    const d = judgeInkImage(input({ signatureLabel: near("signature"), initialsLabel: near("initials"), geometry: signatureGeometry({ repeatPages: 5 }) }));
    expect(d && d.confidence <= HEURISTIC_MAX_CONFIDENCE).toBe(true);
    expect(HEURISTIC_MAX_CONFIDENCE).toBe(0.89);
  });
  it("un escaneo OPACO sin etiqueta no se ofrece; con etiqueta si", () => {
    const opaque = inkFeatures({ transparent: 0, hasAlpha: false, darkShare: 0.9, blueShare: 0 });
    expect(judgeInkImage(input({ features: opaque }))).toBeNull();
    expect(judgeInkImage(input({ features: opaque, signatureLabel: near("signature") }))?.kind).toBe("signature");
    // Con 15 % de transparencia ya cuenta como recortada.
    expect(judgeInkImage(input({ features: inkFeatures({ transparent: 0.15 }) }))).not.toBeNull();
    expect(judgeInkImage(input({ features: inkFeatures({ transparent: 0.14 }) }))).toBeNull();
  });
  it("proporcion de firma 1,5-8 (con etiqueta de firma se acepta algo mas cuadrada, hasta 0,6)", () => {
    const geo = (aspect: number) => signatureGeometry({ aspect, areaFrac: 0.03 });
    expect(judgeInkImage(input({ geometry: geo(1.5) }))?.kind).toBe("signature");
    expect(judgeInkImage(input({ geometry: geo(8) }))?.kind).toBe("signature");
    expect(judgeInkImage(input({ geometry: geo(8.1) }))).toBeNull();
    expect(judgeInkImage(input({ geometry: geo(1.4) }))).toBeNull();
    expect(judgeInkImage(input({ geometry: geo(1.4), signatureLabel: near("signature") }))?.kind).toBe("signature");
    expect(judgeInkImage(input({ geometry: geo(0.59), signatureLabel: near("signature") }))).toBeNull();
    expect(judgeInkImage(input({ geometry: geo(12.1), signatureLabel: near("signature") }))).toBeNull();
    expect(judgeInkImage(input({ geometry: geo(12), signatureLabel: near("signature") }))?.kind).toBe("signature");
  });
  it("altura 1-8 % de la pagina", () => {
    expect(judgeInkImage(input({ geometry: signatureGeometry({ heightFrac: 0.01 }) }))).not.toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ heightFrac: 0.0099 }) }))).toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ heightFrac: 0.08 }) }))).not.toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ heightFrac: 0.081 }) }))).toBeNull();
  });
  it("tamano minimo 28 x 12 puntos (un icono de 20 pt no es una firma)", () => {
    expect(judgeInkImage(input({ geometry: signatureGeometry({ widthPt: 28, heightPt: 12 }) }))).not.toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ widthPt: 27 }) }))).toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ heightPt: 11 }) }))).toBeNull();
  });
  it("no ocupa casi todo el ancho de la pagina (una cenefa ancha no es una firma): maximo 45 %", () => {
    expect(judgeInkImage(input({ geometry: signatureGeometry({ widthFrac: 0.45 }) }))).not.toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ widthFrac: 0.46 }) }))).toBeNull();
  });
  it("un circulo o cuadro VACIOS (la casilla dibujada) no son una firma", () => {
    const black = { dominantHueShare: 0, chromaticShare: 0, darkShare: 1, blueShare: 0, inkSaturation: 0 };
    expect(judgeInkImage(input({ features: inkFeatures({ ...black, ringShare: 0.55, centerShare: 0.3 }) }))).toBeNull();
    expect(judgeInkImage(input({ features: inkFeatures({ ...black, ringShare: 0.55, centerShare: 0.31 }) }))).not.toBeNull();
    expect(judgeInkImage(input({ features: inkFeatures({ ...black, ringShare: 0.54, centerShare: 0.1 }) }))).not.toBeNull();
    expect(judgeInkImage(input({ features: inkFeatures({ ...black, frameShare: 0.6 }) }))).toBeNull();
    expect(judgeInkImage(input({ features: inkFeatures({ ...black, frameShare: 0.59 }) }))).not.toBeNull();
  });
  it("un sello de color saturado no se toma por firma", () => {
    const stamp = inkFeatures({ ringShare: 0.65, centerShare: 0.34, inkSaturation: 0.85 });
    expect(judgeInkImage(input({ features: stamp }))).toBeNull();
  });
  it("sin miniatura no hay decision de tinta", () => {
    expect(judgeInkImage(input({ features: null }))).toBeNull();
  });
});

describe("judgeInkImage · iniciales", () => {
  const small = (over = {}) => signatureGeometry({ aspect: 1.25, heightFrac: 0.05, areaFrac: 0.004, widthFrac: 0.09, widthPt: 54, heightPt: 40, ...over });
  it("pequenas y casi cuadradas con la etiqueta «Iniciales»: 0,89 tope", () => {
    const d = judgeInkImage(input({ geometry: small(), initialsLabel: near("initials") }));
    expect(d?.kind).toBe("initials");
    expect(d?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(d?.reasons).toContain("proporción 1,3:1 de iniciales");
  });
  it("sin etiqueta: iniciales posibles (0,65), y repetidas en varias paginas suben a 0,70 y lo dicen", () => {
    const one = judgeInkImage(input({ geometry: small() }));
    expect(one?.kind).toBe("initials");
    expect(one?.confidence).toBe(0.65);
    const repeated = judgeInkImage(input({ geometry: small({ repeatPages: 3, band: "bottom" }) }));
    expect(repeated?.confidence).toBe(0.7);
    expect(repeated?.reasons).toContain("repetida en 3 páginas, como unas iniciales");
  });
  it("con las dos etiquetas cerca manda el tamano: pequeno y casi cuadrado = iniciales; ancho = firma", () => {
    expect(judgeInkImage(input({ geometry: small(), signatureLabel: near("signature"), initialsLabel: near("initials") }))?.kind).toBe("initials");
    expect(judgeInkImage(input({ signatureLabel: near("signature"), initialsLabel: near("initials") }))?.kind).toBe("signature");
    expect(judgeInkImage(input({ geometry: small({ aspect: 1.8 }), signatureLabel: near("signature"), initialsLabel: near("initials") }))?.kind).toBe("signature");
  });
  it("con solo la etiqueta de iniciales es iniciales aunque sea ancha (hasta proporcion 8)", () => {
    expect(judgeInkImage(input({ initialsLabel: near("initials") }))?.kind).toBe("initials");
    expect(judgeInkImage(input({ geometry: signatureGeometry({ aspect: 8.1 }), initialsLabel: near("initials") }))).toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ aspect: 0.41 }), initialsLabel: near("initials") }))).toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ aspect: 0.42 }), initialsLabel: near("initials") }))?.kind).toBe("initials");
  });
  it("iniciales gruesas (rotulador) con etiqueta cerca valen; sin ella la marca de un solo color no", () => {
    const thick = inkFeatures({ solidity: 0.68, darkShare: 1, blueShare: 0, chromaticShare: 0, dominantHue: -1, dominantHueShare: 0 });
    expect(judgeInkImage(input({ geometry: small(), features: thick, initialsLabel: near("initials") }))?.kind).toBe("initials");
    expect(judgeInkImage(input({ geometry: small(), features: thick }))).toBeNull();
    expect(judgeInkImage(input({ geometry: small(), features: thick, initialsLabel: near("initials") }))?.reasons[0]).toBe("tinta gruesa oscura");
  });
  it("una imagen repetida en cabecera/pie, no pequena y sin etiqueta no son iniciales", () => {
    const big = small({ areaFrac: 0.03, repeatPages: 4, band: "top", aspect: 1.2, widthFrac: 0.2 });
    expect(judgeInkImage(input({ geometry: big }))).toBeNull();
  });
  it("iniciales: area maxima 2 % de la pagina", () => {
    expect(judgeInkImage(input({ geometry: small({ areaFrac: 0.02 }) }))?.kind).toBe("initials");
    // Mas grande y ni apaisada ni etiquetada: ni firma ni iniciales.
    expect(judgeInkImage(input({ geometry: small({ areaFrac: 0.021, aspect: 1.2 }) }))).toBeNull();
    expect(judgeInkImage(input({ geometry: small({ areaFrac: 0.021, aspect: 1.2 }), signatureLabel: near("signature") }))?.kind).toBe("signature");
  });
});

describe("judgeStampImage", () => {
  const stamp = inkFeatures({ inkFraction: 0.24, chromaticShare: 1, dominantHueShare: 1, inkSaturation: 0.85, ringShare: 0.65, centerShare: 0.34, dominantHue: 355 });
  const geo = signatureGeometry({ aspect: 1.2, areaFrac: 0.02, repeatPages: 1 });
  it("sello circular rojo: forma, color y fondo transparente en los motivos", () => {
    const d = judgeStampImage(input({ features: stamp, geometry: geo }));
    expect(d?.kind).toBe("stamp");
    expect(d?.confidence).toBe(0.72);
    expect(d?.reasons).toEqual(["forma circular", "color saturado (rojo)", "fondo transparente"]);
  });
  it("sello rectangular azul: marco", () => {
    const frame = inkFeatures({ ...stamp, ringShare: 0.3, frameShare: 0.5, dominantHue: 230 });
    const d = judgeStampImage(input({ features: frame, geometry: signatureGeometry({ aspect: 2, areaFrac: 0.02 }) }));
    expect(d?.reasons[0]).toBe("marco rectangular");
    expect(d?.reasons[1]).toBe("color saturado (azul)");
    expect(d?.confidence).toBeLessThan(0.8);
  });
  it("proporcion normal (0,45-2,6), area 0,05-25 % y sin barras de borde de pagina", () => {
    expect(judgeStampImage(input({ features: stamp, geometry: signatureGeometry({ aspect: 0.44, areaFrac: 0.02 }) }))).toBeNull();
    expect(judgeStampImage(input({ features: stamp, geometry: signatureGeometry({ aspect: 2.7, areaFrac: 0.02 }) }))).toBeNull();
    expect(judgeStampImage(input({ features: stamp, geometry: signatureGeometry({ aspect: 1, areaFrac: 0.26 }) }))).toBeNull();
    expect(judgeStampImage(input({ features: stamp, geometry: signatureGeometry({ aspect: 1, areaFrac: 0.0004 }) }))).toBeNull();
    expect(judgeStampImage(input({ features: { ...stamp, fullSpanShare: 0.31 }, geometry: geo }))).toBeNull();
    expect(judgeStampImage(input({ features: { ...stamp, fullSpanShare: 0.3 }, geometry: geo }))).not.toBeNull();
  });
  it("repetido en cabecera/pie es un logo redondo, no un sello", () => {
    expect(judgeStampImage(input({ features: stamp, geometry: signatureGeometry({ aspect: 1, areaFrac: 0.02, repeatPages: 3, band: "top" }) }))).toBeNull();
  });
  it("el tono se nombra", () => {
    const hue = (h: number) => judgeStampImage(input({ features: { ...stamp, dominantHue: h }, geometry: geo }))?.reasons[1];
    expect(hue(10)).toBe("color saturado (rojo)");
    expect(hue(350)).toBe("color saturado (rojo)");
    expect(hue(30)).toBe("color saturado (naranja)");
    expect(hue(60)).toBe("color saturado (amarillo)");
    expect(hue(120)).toBe("color saturado (verde)");
    expect(hue(185)).toBe("color saturado (turquesa)");
    expect(hue(230)).toBe("color saturado (azul)");
    expect(hue(300)).toBe("color saturado (morado)");
  });
});

describe("judgeLogoImage", () => {
  const colorful = inkFeatures({ chromaticShare: 1, solidity: 0.89, colorBins: 18, darkShare: 0.1, blueShare: 0.5, inkFraction: 0.5 });
  const geo = (over = {}) => signatureGeometry({ aspect: 3, areaFrac: 0.012, repeatPages: 5, band: "top", pages: 5, ...over });
  it("repetido en la cabecera de >= 3 paginas con colores planos: 0,93", () => {
    const d = judgeLogoImage(input({ features: colorful, geometry: geo() }));
    expect(d?.kind).toBe("logo");
    expect(d?.confidence).toBe(0.93);
    expect(d?.reasons).toEqual(["repetida en la cabecera de 5 páginas", "ocupa el 1 % de la página", "colores planos de logotipo"]);
  });
  it("en el pie lo dice, y con solo 2 paginas la confianza baja", () => {
    const d = judgeLogoImage(input({ features: null, geometry: geo({ band: "bottom", repeatPages: 2, pages: 2 }) }));
    expect(d?.reasons[0]).toBe("repetida en el pie de 2 páginas");
    expect(d?.confidence).toBe(0.8);
    expect(judgeLogoImage(input({ features: null, geometry: geo({ repeatPages: 3 }) }))?.confidence).toBe(0.9);
  });
  it("sin repeticion en cabecera/pie no es logo (aunque este arriba en la pagina 2)", () => {
    expect(judgeLogoImage(input({ features: colorful, geometry: geo({ band: null, repeatPages: 1, pages: 1, firstPageTop: false }) }))).toBeNull();
    expect(judgeLogoImage(input({ features: colorful, geometry: geo({ band: null, repeatPages: 3, pages: 3 }) }))).toBeNull();
  });
  it("un solo logo arriba de la pagina 1: posible (0,5-0,8)", () => {
    const d = judgeLogoImage(input({ features: colorful, geometry: geo({ band: null, repeatPages: 1, pages: 1, firstPageTop: true }) }));
    expect(d?.kind).toBe("logo");
    expect(d?.confidence).toBeLessThanOrEqual(0.8);
    expect(d?.confidence).toBeGreaterThanOrEqual(0.5);
    expect(d?.reasons[0]).toBe("arriba en la primera página");
    expect(judgeLogoImage(input({ features: colorful, geometry: geo({ band: null, repeatPages: 1, pages: 2, firstPageTop: true }) }))).toBeNull();
  });
  it("un logo diminuto dice «menos del 1 %»", () => {
    const d = judgeLogoImage(input({ features: colorful, geometry: geo({ areaFrac: 0.004 }) }));
    expect(d?.reasons[1]).toBe("ocupa menos del 1 % de la página");
  });
  it("area: menos del 10 % de la pagina y mas de 0,05 %", () => {
    expect(judgeLogoImage(input({ features: colorful, geometry: geo({ areaFrac: 0.1 }) }))).not.toBeNull();
    expect(judgeLogoImage(input({ features: colorful, geometry: geo({ areaFrac: 0.101 }) }))).toBeNull();
    expect(judgeLogoImage(input({ features: colorful, geometry: geo({ areaFrac: 0.0004 }) }))).toBeNull();
  });
  it("una marca pequena de UN solo color oscuro repetida en el pie tambien podrian ser iniciales: confianza <= 0,7", () => {
    const mono = inkFeatures({ darkShare: 1, blueShare: 0, chromaticShare: 0, colorBins: 1, solidity: 0.68 });
    const d = judgeLogoImage(input({ features: mono, geometry: geo({ band: "bottom", areaFrac: 0.004 }) }));
    expect(d?.kind).toBe("logo");
    expect(d?.confidence).toBe(0.7);
    expect(d?.reasons.join(" ")).toContain("iniciales");
    // Mas grande que unas iniciales: sigue siendo un logo seguro.
    expect(judgeLogoImage(input({ features: mono, geometry: geo({ band: "bottom", areaFrac: 0.03 }) }))?.confidence).toBeGreaterThan(0.85);
  });
});

describe("judgePhotoImage", () => {
  const photo = inkFeatures({ transparent: 0, hasAlpha: false, colorBins: 600, inkFraction: 0.55, meanAlpha: 1 });
  const geo = (over = {}) => signatureGeometry({ aspect: 1.3, areaFrac: 0.14, heightFrac: 0.28, ...over });
  it("opaca, muchos colores y grande: foto", () => {
    const d = judgePhotoImage(input({ features: photo, geometry: geo() }));
    expect(d?.kind).toBe("photo");
    expect(d?.confidence).toBe(0.75);
    expect(d?.reasons[0]).toBe("muchos colores (600 tonos)");
  });
  it("cubetas de color >= 150, area >= 1 %, sin transparencia", () => {
    expect(judgePhotoImage(input({ features: { ...photo, colorBins: 150 }, geometry: geo() }))?.kind).toBe("photo");
    expect(judgePhotoImage(input({ features: { ...photo, colorBins: 149 }, geometry: geo() }))).toBeNull();
    expect(judgePhotoImage(input({ features: photo, geometry: geo({ areaFrac: 0.0099 }) }))).toBeNull();
    expect(judgePhotoImage(input({ features: { ...photo, transparent: 0.15 }, geometry: geo() }))).toBeNull();
    expect(judgePhotoImage(input({ features: photo, geometry: geo({ areaFrac: 0.01 }) }))?.confidence).toBe(0.72);
  });
  it("una pagina escaneada no es una foto", () => {
    expect(judgePhotoImage(input({ features: photo, geometry: geo(), scannedPage: true }))).toBeNull();
  });
  it("un dibujo con fondo claro y poca tinta tampoco", () => {
    expect(judgePhotoImage(input({ features: { ...photo, lightBackground: true, inkFraction: 0.29 }, geometry: geo() }))).toBeNull();
    expect(judgePhotoImage(input({ features: { ...photo, lightBackground: true, inkFraction: 0.3 }, geometry: geo() }))?.kind).toBe("photo");
    expect(judgePhotoImage(input({ features: null, geometry: geo() }))).toBeNull();
  });
});

describe("judgeWatermarkImage", () => {
  const faint = inkFeatures({ meanAlpha: 0.3, transparent: 0 });
  const geo = (over = {}) => signatureGeometry({ aspect: 1, areaFrac: 0.4, repeatPages: 4, ...over });
  it("grande, translucida y repetida en el mismo sitio en >= 50 % de las paginas", () => {
    const d = judgeWatermarkImage(input({ features: faint, geometry: geo(), analyzedPages: 6 }));
    expect(d?.kind).toBe("watermark");
    expect(d?.confidence).toBe(0.75);
    expect(d?.reasons).toEqual(["imagen translúcida (opacidad del 30 %)", "grande: el 40 % de la página", "repetida en 4 páginas en el mismo sitio"]);
  });
  it("area >= 20 %, >= 2 paginas, >= la mitad de las paginas y alfa medio < 0,75", () => {
    expect(judgeWatermarkImage(input({ features: faint, geometry: geo({ areaFrac: 0.2 }), analyzedPages: 8 }))).not.toBeNull();
    expect(judgeWatermarkImage(input({ features: faint, geometry: geo({ areaFrac: 0.19 }), analyzedPages: 8 }))).toBeNull();
    expect(judgeWatermarkImage(input({ features: faint, geometry: geo({ repeatPages: 1 }), analyzedPages: 1 }))).toBeNull();
    expect(judgeWatermarkImage(input({ features: faint, geometry: geo({ repeatPages: 3 }), analyzedPages: 6 }))).not.toBeNull();
    expect(judgeWatermarkImage(input({ features: faint, geometry: geo({ repeatPages: 3 }), analyzedPages: 7 }))).toBeNull();
    expect(judgeWatermarkImage(input({ features: { ...faint, meanAlpha: 0.75 }, geometry: geo(), analyzedPages: 6 }))).toBeNull();
    expect(judgeWatermarkImage(input({ features: { ...faint, meanAlpha: 0.74 }, geometry: geo(), analyzedPages: 6 }))).not.toBeNull();
    expect(judgeWatermarkImage(input({ features: null, geometry: geo() }))).toBeNull();
  });
});

describe("coversPage y mergeReasons", () => {
  it("una imagen que cubre el 85 % de la pagina es la pagina entera", () => {
    expect(coversPage(0.85)).toBe(true);
    expect(coversPage(0.849)).toBe(false);
  });
  it("une los motivos sin repetir lo que el motor ya dijo", () => {
    expect(mergeReasons(["fondo transparente", "cerca de «Firma»"], ["transparente", "JPEG original disponible"])).toEqual(["fondo transparente", "cerca de «Firma»", "JPEG original disponible"]);
    expect(mergeReasons(["repetida en 3 páginas, como unas iniciales"], ["repetida en 3 páginas"])).toEqual(["repetida en 3 páginas, como unas iniciales"]);
    expect(mergeReasons(["a"], ["a", "b"])).toEqual(["a", "b"]);
    expect(mergeReasons([], ["transparente"])).toEqual(["transparente"]);
  });
});
