import { describe, expect, it } from "vitest";
import { isBarLike, isInkLike, isMonoInk, judgeInkImage, judgeLogoImage, judgeStampImage, stampShape, type DecisionInput } from "./classifyRules";
import { inkFeatures, label, signatureGeometry } from "./classify.testUtils";
import type { NearLabel } from "./classifyText";

/**
 * Correcciones tras la verificacion independiente (H1-H3, H5-H7): cada regla con su limite. Los casos vienen de lo que fallaba en el
 * corpus del verificador (`__fixtures__/verif`): iniciales JPEG con tinta gruesa, trazos verticales altos («I», «T»), iniciales al ras
 * de la caja, firmas en paginas apaisadas, sellos 3:1, iconos de «visto» y manuscritos repetidos en la cabecera.
 */

const near = (kind: "signature" | "initials", strength = 1): NearLabel => ({ label: label(kind, { strength }), distance: 0.3 });
const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({ features: inkFeatures(), geometry: signatureGeometry(), signatureLabel: null, initialsLabel: null, analyzedPages: 3, scannedPage: false, ...over });
const small = (over = {}) => signatureGeometry({ aspect: 1.5, heightFrac: 0.035, areaFrac: 0.004, widthFrac: 0.07, widthPt: 43, heightPt: 28, ...over });
const black = { dominantHueShare: 0, chromaticShare: 0, darkShare: 1, blueShare: 0, inkSaturation: 0, dominantHue: -1 };

describe("H1 · iniciales con «Initials:» al lado (JPEG con tinta gruesa y trazos verticales altos)", () => {
  it("la tinta de un solo tono: casi sin color (negra, gris) o con un tono dominante (boligrafo)", () => {
    expect(isMonoInk(inkFeatures({ chromaticShare: 0, dominantHueShare: 0 }))).toBe(true);
    expect(isMonoInk(inkFeatures({ chromaticShare: 0.2, dominantHueShare: 0 }))).toBe(true);
    expect(isMonoInk(inkFeatures({ chromaticShare: 0.21, dominantHueShare: 0.5 }))).toBe(false);
    expect(isMonoInk(inkFeatures({ chromaticShare: 0.6, dominantHueShare: 0.85 }))).toBe(true);
    expect(isMonoInk(inkFeatures({ chromaticShare: 0.6, dominantHueShare: 0.84 }))).toBe(false);
    expect(isMonoInk(inkFeatures({ chromaticShare: 0.59, dominantHueShare: 1 }))).toBe(false);
  });

  it("un JPEG con 43 cubetas de color por el ruido de compresion (tinta gruesa, un solo tono, etiqueta cerca) SON unas iniciales", () => {
    const jpeg = inkFeatures({ ...black, transparent: 0, hasAlpha: false, solidity: 0.73, colorBins: 43, inkFraction: 0.13, meanAlpha: 1 });
    const decision = judgeInkImage(input({ features: jpeg, geometry: small(), initialsLabel: near("initials") }));
    expect(decision?.kind).toBe("initials");
    expect(decision?.confidence).toBeGreaterThanOrEqual(0.85);
    expect(decision?.reasons).toContain("fondo casi blanco");
  });

  it("... pero una insignia de VARIOS tonos con relleno (muchas cubetas y tonos mezclados) no", () => {
    const badge = inkFeatures({ transparent: 0, hasAlpha: false, solidity: 0.73, colorBins: 43, inkFraction: 0.13, chromaticShare: 0.4, dominantHueShare: 0.4, darkShare: 0.8, blueShare: 0 });
    expect(judgeInkImage(input({ features: badge, geometry: small(), initialsLabel: near("initials") }))).toBeNull();
  });

  it("un trazo vertical casi de toda la altura («I», «T»: un solo palo) no se toma por un codigo de barras", () => {
    const letterI = inkFeatures({ solidity: 0.3, fullSpanShare: 0.14, fullSpanRuns: 1 });
    expect(isBarLike(letterI)).toBe(false);
    expect(isInkLike(letterI)).toBe(true);
    expect(judgeInkImage(input({ features: letterI, geometry: small(), initialsLabel: near("initials") }))?.kind).toBe("initials");
    // Tres palos (una «M» y una «R») tampoco: las barras de verdad son seis o mas.
    expect(isBarLike(inkFeatures({ fullSpanShare: 0.145, fullSpanRuns: 3 }))).toBe(false);
    expect(isBarLike(inkFeatures({ fullSpanShare: 0.2, fullSpanRuns: 5 }))).toBe(false);
  });

  it("las barras de un codigo de barras (6 o mas, o media imagen) siguen sin ser tinta de firma", () => {
    expect(isBarLike(inkFeatures({ fullSpanShare: 0.2, fullSpanRuns: 6 }))).toBe(true);
    expect(isBarLike(inkFeatures({ fullSpanShare: 0.557, fullSpanRuns: 2 }))).toBe(true);
    expect(isBarLike(inkFeatures({ fullSpanShare: 0.12, fullSpanRuns: 20 }))).toBe(false);
    expect(judgeInkImage(input({ features: inkFeatures({ fullSpanShare: 0.4, fullSpanRuns: 12 }), geometry: small(), initialsLabel: near("initials") }))).toBeNull();
  });

  it("repetidas en el pie de varias paginas, de tinta gruesa y SIN etiqueta: iniciales POSIBLES (<= 0,65) que avisan de que podrian ser un logo", () => {
    const thick = inkFeatures({ ...black, solidity: 0.74, colorBins: 2 });
    const footer = judgeInkImage(input({ features: thick, geometry: small({ repeatPages: 3, band: "bottom", pages: 3 }) }));
    expect(footer?.kind).toBe("initials");
    expect(footer?.confidence).toBeLessThanOrEqual(0.65);
    expect(footer?.reasons).toContain("sin etiqueta de iniciales cerca: tambien podria ser un logo");
    expect(footer?.reasons).toContain("repetida en 3 páginas, como unas iniciales");
    // En la cabecera, en una sola pagina o con una etiqueta de otro tipo no hay indicio de iniciales.
    expect(judgeInkImage(input({ features: thick, geometry: small({ repeatPages: 3, band: "top", pages: 3 }) }))).toBeNull();
    expect(judgeInkImage(input({ features: thick, geometry: small({ repeatPages: 1, band: null }) }))).toBeNull();
  });

  it("una marca de tinta gruesa que ocupa mucho (mas del 30 %) no es unas iniciales aunque se repita en el pie", () => {
    const heavy = inkFeatures({ ...black, solidity: 0.74, colorBins: 2, inkFraction: 0.31 });
    expect(judgeInkImage(input({ features: heavy, geometry: small({ repeatPages: 3, band: "bottom", pages: 3 }) }))).toBeNull();
  });

  it("una marca ancha y rellena (muchas cubetas) junto a «Signature:» o «Initials:» es un logo, no una firma ni unas iniciales", () => {
    const wide = signatureGeometry({ aspect: 4, heightFrac: 0.05, areaFrac: 0.012, widthFrac: 0.26 });
    const thick = inkFeatures({ ...black, solidity: 0.78, colorBins: 9 });
    expect(judgeInkImage(input({ features: thick, geometry: wide, signatureLabel: near("signature") }))).toBeNull();
    expect(judgeInkImage(input({ features: thick, geometry: wide, initialsLabel: near("initials") }))).toBeNull();
  });

  it("una firma de rotulador (tinta gruesa, pocos colores) con la etiqueta de firma SI se acepta, como antes", () => {
    const marker = inkFeatures({ ...black, solidity: 0.72, colorBins: 2, inkFraction: 0.2 });
    expect(judgeInkImage(input({ features: marker, signatureLabel: near("signature") }))?.kind).toBe("signature");
    expect(judgeInkImage(input({ features: { ...marker, colorBins: 7 }, signatureLabel: near("signature") }))).toBeNull();
    // Sin etiqueta no.
    expect(judgeInkImage(input({ features: marker }))).toBeNull();
  });
});

describe("H2 · iniciales azules al ras de la caja no son un sello", () => {
  const blueInitials = inkFeatures({ inkFraction: 0.105, chromaticShare: 1, dominantHueShare: 1, inkSaturation: 0.81, ringShare: 0.43, centerShare: 0.21, frameShare: 0.527, frameSides: 0.077, solidity: 0.7 });
  it("tinta pegada al borde pero sin los cuatro lados: no es un marco", () => {
    expect(stampShape(blueInitials)).toBeNull();
    expect(judgeStampImage(input({ features: blueInitials, geometry: small() }))).toBeNull();
  });
  it("y entonces son iniciales (con o sin etiqueta cerca)", () => {
    expect(judgeInkImage(input({ features: blueInitials, geometry: small(), initialsLabel: near("initials") }))?.kind).toBe("initials");
  });
  it("un marco de verdad (los cuatro lados) sigue siendo un sello", () => {
    const frame = inkFeatures({ ...blueInitials, frameShare: 0.65, frameSides: 1, ringShare: 0.3, inkFraction: 0.36, fullSpanShare: 0.18 });
    expect(stampShape(frame)).toBe("frame");
  });
});

describe("H3 · el limite de altura no sesga las paginas apaisadas", () => {
  it("una firma de 53 pt es el 8,7 % del alto de una carta apaisada pero el 6,7 % de su lado largo: se acepta", () => {
    const landscape = signatureGeometry({ heightFrac: 0.087, longHeightFrac: 0.067, widthFrac: 0.28, areaFrac: 0.024 });
    expect(judgeInkImage(input({ geometry: landscape }))?.kind).toBe("signature");
    // Sin la dimension del lado largo (pagina vertical o dato antiguo) manda la altura de siempre.
    expect(judgeInkImage(input({ geometry: signatureGeometry({ heightFrac: 0.087 }) }))).toBeNull();
  });
  it("el limite es el 8 % del lado largo (0,01 minimo)", () => {
    const geo = (long: number) => signatureGeometry({ heightFrac: 0.1, longHeightFrac: long });
    expect(judgeInkImage(input({ geometry: geo(0.08) }))).not.toBeNull();
    expect(judgeInkImage(input({ geometry: geo(0.081) }))).toBeNull();
    expect(judgeInkImage(input({ geometry: geo(0.01) }))).not.toBeNull();
    expect(judgeInkImage(input({ geometry: geo(0.0099) }))).toBeNull();
  });
  it("una firma GRANDE (hasta el 15 % del alto y el 60 % del ancho) se acepta solo recortada (transparente) y con una etiqueta de firma", () => {
    const big = signatureGeometry({ heightFrac: 0.12, widthFrac: 0.5, areaFrac: 0.06, aspect: 4 });
    expect(judgeInkImage(input({ geometry: big, signatureLabel: near("signature") }))?.kind).toBe("signature");
    expect(judgeInkImage(input({ geometry: big }))).toBeNull();
    const opaque = inkFeatures({ transparent: 0, hasAlpha: false, darkShare: 0.9, blueShare: 0 });
    expect(judgeInkImage(input({ features: opaque, geometry: big, signatureLabel: near("signature") }))).toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ heightFrac: 0.15, widthFrac: 0.6, areaFrac: 0.09, aspect: 4 }), signatureLabel: near("signature") }))).not.toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ heightFrac: 0.151, widthFrac: 0.5, areaFrac: 0.07, aspect: 4 }), signatureLabel: near("signature") }))).toBeNull();
    expect(judgeInkImage(input({ geometry: signatureGeometry({ heightFrac: 0.1, widthFrac: 0.61, areaFrac: 0.06, aspect: 6 }), signatureLabel: near("signature") }))).toBeNull();
  });
});

describe("H5 · sello rectangular 3:1", () => {
  it("«APROBADO» (marco azul 3:1) es un sello", () => {
    const stamp = inkFeatures({ inkFraction: 0.356, chromaticShare: 1, dominantHueShare: 1, inkSaturation: 0.87, ringShare: 0.36, centerShare: 0.22, frameShare: 0.65, frameSides: 1, fullSpanShare: 0.18, dominantHue: 230 });
    const decision = judgeStampImage(input({ features: stamp, geometry: signatureGeometry({ aspect: 3.1, areaFrac: 0.016 }) }));
    expect(decision?.kind).toBe("stamp");
    expect(decision?.reasons[0]).toBe("marco rectangular");
  });
});

describe("H6 · señuelos: un icono de «visto» y un manuscrito repetido en la cabecera", () => {
  it("un icono relleno y cuadrado junto a «Firma» no es una firma (la tinta gruesa solo vale para iniciales)", () => {
    const check = inkFeatures({ ...black, solidity: 0.9, colorBins: 2, inkFraction: 0.147, chromaticShare: 1, dominantHueShare: 1 });
    const squareIcon = signatureGeometry({ aspect: 1, heightFrac: 0.05, areaFrac: 0.004, widthFrac: 0.065, widthPt: 40, heightPt: 40 });
    expect(judgeInkImage(input({ features: check, geometry: squareIcon, signatureLabel: near("signature") }))).toBeNull();
  });
  it("una firma cuadrada y de trazo FINO con etiqueta de firma si se acepta", () => {
    const thin = inkFeatures({ solidity: 0.3 });
    expect(judgeInkImage(input({ features: thin, geometry: signatureGeometry({ aspect: 1.2, areaFrac: 0.03 }), signatureLabel: near("signature") }))?.kind).toBe("signature");
  });
  it("un manuscrito repetido en la cabecera de varias paginas SIN etiqueta es un logo, no una firma; con etiqueta de firma, firma", () => {
    const header = signatureGeometry({ repeatPages: 3, band: "top", pages: 3, aspect: 4.4, areaFrac: 0.009, heightFrac: 0.04, widthFrac: 0.23 });
    expect(judgeInkImage(input({ geometry: header }))).toBeNull();
    expect(judgeInkImage(input({ geometry: header, signatureLabel: near("signature") }))?.kind).toBe("signature");
    const logo = judgeLogoImage(input({ features: inkFeatures({ ...black, chromaticShare: 1, colorBins: 2 }), geometry: header }));
    expect(logo?.kind).toBe("logo");
    expect(logo?.confidence).toBeGreaterThan(0.85);
  });
  it("una firma repetida en el PIE de varias paginas (sin etiqueta) no se toca: sigue siendo candidata a firma", () => {
    const footer = signatureGeometry({ repeatPages: 3, band: "bottom", pages: 3, aspect: 3.3 });
    expect(judgeInkImage(input({ geometry: footer }))?.kind).toBe("signature");
  });
  it("una raya o cenefa (tinta mas de 9 veces mas ancha que alta) no es una firma", () => {
    const rule = inkFeatures({ solidity: 0.05, inkBox: { x: 0.02, y: 0.4, width: 0.96, height: 0.1 }, width: 256, height: 80 });
    expect(judgeInkImage(input({ features: rule, geometry: signatureGeometry({ aspect: 7 }), signatureLabel: near("signature") }))).toBeNull();
    const ok = inkFeatures({ inkBox: { x: 0.02, y: 0.1, width: 0.95, height: 0.8 }, width: 256, height: 80 });
    expect(judgeInkImage(input({ features: ok, geometry: signatureGeometry({ aspect: 3.3 }) }))?.kind).toBe("signature");
  });
});

describe("H7 · «Rúbrica» es firma o iniciales segun la forma; fotos con sombra", () => {
  const rubrica: NearLabel = { label: label("initials", { strength: 1, alsoSignature: true, text: "Rúbrica" }), distance: 0.3 };
  it("una firma ancha junto a «Rúbrica» es una firma; unas iniciales pequeñas, iniciales", () => {
    expect(judgeInkImage(input({ signatureLabel: rubrica, initialsLabel: rubrica }))?.kind).toBe("signature");
    expect(judgeInkImage(input({ geometry: small(), signatureLabel: rubrica, initialsLabel: rubrica }))?.kind).toBe("initials");
  });
  it("una foto con sombra o de papel gris (fondo local uniforme) solo vale CON etiqueta cerca", () => {
    const shadow = inkFeatures({ lightBackground: false, localPaper: true, transparent: 0, hasAlpha: false, darkShare: 0.9, blueShare: 0.1, solidity: 0.3 });
    expect(isInkLike(shadow)).toBe(false);
    expect(isInkLike(shadow, true)).toBe(true);
    const decision = judgeInkImage(input({ features: shadow, signatureLabel: near("signature") }));
    expect(decision?.kind).toBe("signature");
    expect(decision?.reasons).toContain("fondo de papel con sombra");
    expect(judgeInkImage(input({ features: shadow }))).toBeNull();
  });
  it("un fondo ni claro ni de papel (foto de verdad) no", () => {
    const photo = inkFeatures({ lightBackground: false, localPaper: false, transparent: 0 });
    expect(isInkLike(photo, true)).toBe(false);
  });
});
