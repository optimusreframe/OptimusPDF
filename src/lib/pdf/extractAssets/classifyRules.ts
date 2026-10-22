/**
 * Reglas del clasificador de IMAGENES (U7.3): dadas las caracteristicas de los pixeles de la miniatura (`PixelFeatures`), la geometria
 * del elemento en la pagina y el texto cercano, decide si una imagen es una firma, unas iniciales, un sello, un logo, una marca de
 * agua, una foto o solo una imagen, con los motivos legibles y una confianza calibrada (0,85 o mas = «probable»).
 *
 * La confianza se combina con «o ruidoso» (1 - producto de (1 - peso)): cada senal independiente suma sin pasar de 1, y ninguna
 * senal sola basta para «probable». Firma de tinta sobre fondo transparente + proporcion y altura de firma + etiqueta «Firma» cerca
 * llega a ~0,88; sin la etiqueta se queda en ~0,65 («posible»).
 */

import { labelReason, type NearLabel } from "./classifyText";
import {
  FULL_PAGE_COVER,
  HEURISTIC_MAX_CONFIDENCE,
  INITIALS_ASPECT,
  INITIALS_MAX_AREA,
  LOGO_MAX_AREA,
  PHOTO_MIN_BINS,
  SIGNATURE_ASPECT,
  SIGNATURE_HEIGHT,
  SIGNATURE_MAX_INK,
  SIGNATURE_MAX_WIDTH,
  SIGNATURE_MAX_SOLIDITY,
  WATERMARK_MAX_ALPHA,
  WATERMARK_MIN_AREA,
  type PixelFeatures,
} from "./classifyTypes";
import type { AssetKind } from "./types";

export type Geometry = {
  /** Ancho / alto de la caja EN LA PAGINA. */
  aspect: number;
  /** Alto y area respecto a la pagina (0..1). */
  heightFrac: number;
  areaFrac: number;
  widthFrac: number;
  /** Tamano de la caja en puntos. */
  widthPt: number;
  heightPt: number;
  /** Paginas distintas donde aparece en el mismo sitio (misma caja, +-4 %). */
  repeatPages: number;
  /** La repeticion cae en la franja superior (cabecera) o inferior (pie). */
  band: "top" | "bottom" | null;
  /** Aparece en la franja superior de la PRIMERA pagina analizada. */
  firstPageTop: boolean;
  /** Paginas donde aparece. */
  pages: number;
};

export type DecisionInput = {
  features: PixelFeatures | null;
  geometry: Geometry;
  /** Etiqueta mas cercana por tipo (la de firma y la de iniciales, si las hay). */
  signatureLabel: NearLabel | null;
  initialsLabel: NearLabel | null;
  /** Paginas analizadas (base de la proporcion de repeticion). */
  analyzedPages: number;
  /** La imagen es la de una pagina escaneada. */
  scannedPage: boolean;
};

export type Decision = { kind: AssetKind; confidence: number; reasons: string[] };

/** Solidez maxima de la tinta de unas iniciales gruesas con etiqueta cerca. */
export const LOOSE_SOLIDITY = 0.9;
/** Limites de la tinta gruesa aceptada con etiqueta: cubetas de color y fraccion de tinta. */
export const LOOSE_MAX_BINS = 6;
export const LOOSE_MAX_INK = 0.3;
/** Con menos de esta fraccion de transparencia una imagen es un escaneo OPACO, y solo es una firma si hay una etiqueta de firma cerca. */
export const OPAQUE_BELOW_TRANSPARENT = 0.15;
/** Un sello tiene una proporcion normal (no una tira de borde de pagina). */
export const STAMP_ASPECT = { min: 0.45, max: 2.6 } as const;
/** Mas columnas/filas casi enteras que esto es un codigo de barras o una raya, no una firma. */
export const MAX_FULL_SPAN = 0.12;
/** Dimensiones minimas (puntos) de una firma o unas iniciales: un icono de 20 pt no lo es. */
export const MIN_SIGNATURE_PT = { width: 28, height: 12 } as const;

const noisyOr = (weights: ReadonlyArray<number>): number => 1 - weights.reduce((product, weight) => product * (1 - weight), 1);
const round2 = (value: number): number => Math.round(value * 100) / 100;
const pct = (value: number): string => `${Math.max(1, Math.round(value * 100))} %`;
/** Area como fraccion de la pagina: «menos del 1 %» si es diminuta. */
const areaPhrase = (value: number): string => (value < 0.01 ? "ocupa menos del 1 % de la página" : `ocupa el ${pct(value)} de la página`);
const decimal = (value: number): string => value.toFixed(1).replace(".", ",");

/**
 * Tinta oscura o azul sobre fondo transparente o casi blanco: lo que tiene una firma. Un trazo FINO (solidez baja) basta por si solo;
 * unas iniciales hechas con un rotulador grueso tienen mas relleno (solidez hasta `LOOSE_SOLIDITY`), y solo se aceptan con una
 * etiqueta de firma o iniciales cerca (`loose`).
 */
export function isInkLike(features: PixelFeatures | null, loose = false): boolean {
  if (!features) return false;
  if (!features.lightBackground) return false;
  if (features.inkFraction < 0.004 || features.inkFraction > SIGNATURE_MAX_INK) return false;
  if (features.solidity > (loose ? LOOSE_SOLIDITY : SIGNATURE_MAX_SOLIDITY)) return false;
  // Una tinta gruesa solo vale si es de UN color y ocupa poco: una insignia de colores con mucho relleno no son unas iniciales.
  if (loose && features.solidity > SIGNATURE_MAX_SOLIDITY && (features.colorBins > LOOSE_MAX_BINS || features.inkFraction > LOOSE_MAX_INK)) return false;
  if (features.darkShare + features.blueShare < 0.7) return false;
  if (features.fullSpanShare > MAX_FULL_SPAN) return false;
  return true;
}

/** Aro o marco de un color saturado: un sello. */
export function stampShape(features: PixelFeatures | null): "ring" | "frame" | null {
  if (!features || features.inkFraction < 0.01) return null;
  if (features.chromaticShare < 0.6 || features.dominantHueShare < 0.75 || features.inkSaturation < 0.45) return null;
  if (features.ringShare >= 0.55 && features.centerShare <= 0.45) return "ring";
  if (features.frameShare >= 0.45) return "frame";
  return null;
}

function hueName(hue: number): string {
  if (hue < 0) return "";
  if (hue < 20 || hue >= 340) return "rojo";
  if (hue < 45) return "naranja";
  if (hue < 70) return "amarillo";
  if (hue < 170) return "verde";
  if (hue < 200) return "turquesa";
  if (hue < 265) return "azul";
  return "morado";
}

/** Firma o iniciales COMO IMAGEN. `null` si no lo parece. */
export function judgeInkImage(input: DecisionInput): Decision | null {
  const { features, geometry: g } = input;
  const hasLabel = !!(input.signatureLabel || input.initialsLabel);
  if (!features || !isInkLike(features, hasLabel)) return null;
  if (stampShape(features)) return null;
  // Un escaneo opaco sin etiqueta cerca (una imagen impresa en la plantilla, un dibujo) no se ofrece como firma.
  if (features.transparent < OPAQUE_BELOW_TRANSPARENT && !hasLabel) return null;
  if (g.heightFrac < SIGNATURE_HEIGHT.min || g.heightFrac > SIGNATURE_HEIGHT.max) return null;
  if (g.widthPt < MIN_SIGNATURE_PT.width || g.heightPt < MIN_SIGNATURE_PT.height) return null;
  if (g.widthFrac > SIGNATURE_MAX_WIDTH) return null;
  // Un circulo o un cuadro vacios (la casilla de las iniciales dibujada) no son una firma.
  if ((features.ringShare >= 0.55 && features.centerShare <= 0.3) || features.frameShare >= 0.6) return null;

  const sigLabel = input.signatureLabel;
  const iniLabel = input.initialsLabel;
  const aspectSignature = g.aspect >= SIGNATURE_ASPECT.min && g.aspect <= SIGNATURE_ASPECT.max;
  const aspectInitials = g.aspect >= INITIALS_ASPECT.min && g.aspect <= INITIALS_ASPECT.max && g.areaFrac <= INITIALS_MAX_AREA;
  const repeated = g.repeatPages >= 2;

  let kind: "signature" | "initials";
  // Con las dos etiquetas cerca (las casillas de firma e iniciales estan juntas en el pie) manda el tamano: pequeno y casi cuadrado = iniciales.
  if (iniLabel && sigLabel) kind = aspectInitials && g.aspect < SIGNATURE_ASPECT.min * 1.2 ? "initials" : "signature";
  else if (iniLabel) kind = "initials";
  else if (sigLabel) kind = "signature";
  else if (aspectInitials && (!aspectSignature || repeated || g.aspect < SIGNATURE_ASPECT.min * 1.2)) kind = "initials";
  else kind = "signature";

  if (kind === "signature" && !aspectSignature) {
    // Con etiqueta de firma se acepta una firma algo mas cuadrada; sin ella no.
    if (!sigLabel || g.aspect < INITIALS_ASPECT.min || g.aspect > SIGNATURE_ASPECT.max * 1.5) return null;
  }
  if (kind === "initials" && !aspectInitials) {
    if (!iniLabel || g.aspect < INITIALS_ASPECT.min * 0.7 || g.aspect > SIGNATURE_ASPECT.max) return null;
  }
  // Una imagen repetida en cabecera/pie que no es pequena ni lleva etiqueta es un logo, no unas iniciales.
  if (kind === "initials" && !iniLabel && g.band && g.areaFrac > INITIALS_MAX_AREA) return null;

  const weights: number[] = [0.45];
  const reasons: string[] = [];
  const thin = features.solidity <= SIGNATURE_MAX_SOLIDITY;
  reasons.push(`${thin ? "tinta fina" : "tinta gruesa"} ${features.blueShare >= features.darkShare ? "azul" : "oscura"}`);
  if (features.transparent >= 0.15) {
    weights.push(0.15);
    reasons.push("fondo transparente");
  } else {
    weights.push(0.05);
    reasons.push("fondo casi blanco");
  }
  const aspectOk = kind === "signature" ? aspectSignature : aspectInitials;
  if (aspectOk) {
    weights.push(0.25);
    reasons.push(`proporción ${decimal(g.aspect)}:1 de ${kind === "signature" ? "firma" : "iniciales"}`);
  }
  reasons.push(`altura del ${pct(g.heightFrac)} de la página`);
  const label = kind === "initials" ? iniLabel : sigLabel;
  if (label) {
    weights.push(0.65 * label.label.strength);
    reasons.push(labelReason(label.label));
  }
  if (kind === "initials" && repeated) {
    weights.push(0.15);
    reasons.push(`repetida en ${g.repeatPages} páginas, como unas iniciales`);
  }
  return { kind, confidence: Math.min(HEURISTIC_MAX_CONFIDENCE, round2(noisyOr(weights))), reasons };
}

/** Sello COMO IMAGEN (aro o marco de un color saturado). */
export function judgeStampImage(input: DecisionInput): Decision | null {
  const shape = stampShape(input.features);
  const features = input.features;
  if (!shape || !features) return null;
  const g = input.geometry;
  if (g.areaFrac > 0.25 || g.areaFrac < 0.0005) return null;
  if (g.aspect < STAMP_ASPECT.min || g.aspect > STAMP_ASPECT.max) return null;
  if (features.fullSpanShare > 0.3) return null;
  const weights = [0.45, 0.3];
  const reasons = [shape === "ring" ? "forma circular" : "marco rectangular", `color saturado (${hueName(features.dominantHue)})`];
  if (features.transparent >= 0.15) {
    weights.push(0.1);
    reasons.push("fondo transparente");
  }
  if (shape === "ring" && g.aspect >= 0.75 && g.aspect <= 1.33) weights.push(0.2);
  if (g.band) return null; // repetido en cabecera/pie (`band` solo existe con >= 2 paginas): un logo redondo, no un sello
  return { kind: "stamp", confidence: Math.min(0.9, round2(noisyOr(weights))), reasons };
}

/** Logo: imagen repetida en la franja superior/inferior de >= 2 paginas, o arriba en la pagina 1, de area pequena. */
export function judgeLogoImage(input: DecisionInput): Decision | null {
  const { geometry: g, features } = input;
  if (g.areaFrac > LOGO_MAX_AREA || g.areaFrac < 0.0005) return null;
  const colorful = !!features && (features.chromaticShare >= 0.3 || features.solidity > 0.45 || features.colorBins >= 4);
  if (g.band) {
    // `band` solo existe si la imagen se repite en el mismo sitio de >= 2 paginas (ver `geometryOf`).
    const weights = [0.8];
    const where = g.band === "top" ? "la cabecera" : "el pie";
    const reasons = [`repetida en ${where} de ${g.repeatPages} páginas`, areaPhrase(g.areaFrac)];
    if (g.repeatPages >= 3) weights.push(0.5);
    if (colorful) {
      weights.push(0.3);
      reasons.push("colores planos de logotipo");
    }
    // Una marca pequena de UN solo color oscuro repetida en el pie tambien podrian ser unas iniciales: menos certeza.
    if (!!features && features.darkShare >= 0.7 && features.colorBins <= 3 && g.areaFrac <= INITIALS_MAX_AREA) {
      reasons.push("un solo color oscuro y tamano pequeno: tambien podrian ser unas iniciales");
      return { kind: "logo", confidence: Math.min(0.7, round2(noisyOr(weights))), reasons };
    }
    return { kind: "logo", confidence: Math.min(0.97, round2(noisyOr(weights))), reasons };
  }
  if (g.firstPageTop && g.pages === 1) {
    const weights = [0.45];
    const reasons = ["arriba en la primera página", areaPhrase(g.areaFrac)];
    if (colorful) {
      weights.push(0.2);
      reasons.push("colores planos de logotipo");
    }
    if (features?.lightBackground) weights.push(0.05);
    return { kind: "logo", confidence: Math.min(0.8, round2(noisyOr(weights))), reasons };
  }
  return null;
}

/** Foto: opaca, con muchos colores y sin el fondo claro de un dibujo. */
export function judgePhotoImage(input: DecisionInput): Decision | null {
  const { features, geometry: g } = input;
  if (!features || input.scannedPage) return null;
  if (features.transparent >= 0.15) return null;
  if (g.areaFrac < 0.01) return null;
  const manyColors = features.colorBins >= PHOTO_MIN_BINS;
  if (!manyColors) return null;
  if (features.lightBackground && features.inkFraction < 0.3) return null;
  const weights = [0.6, 0.3];
  const reasons = [`muchos colores (${features.colorBins} tonos)`, "opaca, sin fondo transparente"];
  if (g.areaFrac >= 0.05) {
    weights.push(0.1);
    reasons.push(`tamaño grande: el ${pct(g.areaFrac)} de la página`);
  }
  return { kind: "photo", confidence: Math.min(0.95, round2(noisyOr(weights))), reasons };
}

/** Marca de agua COMO IMAGEN por sus pixeles: grande, translucida y repetida en el mismo sitio. */
export function judgeWatermarkImage(input: DecisionInput): Decision | null {
  const { features, geometry: g } = input;
  if (!features || g.areaFrac < WATERMARK_MIN_AREA) return null;
  if (g.repeatPages < 2 || g.repeatPages < input.analyzedPages * 0.5) return null;
  if (features.meanAlpha >= WATERMARK_MAX_ALPHA) return null;
  return {
    kind: "watermark",
    confidence: 0.75,
    reasons: [`imagen translúcida (opacidad del ${pct(features.meanAlpha)})`, `grande: el ${pct(g.areaFrac)} de la página`, `repetida en ${g.repeatPages} páginas en el mismo sitio`],
  };
}

/** Una imagen que cubre la pagina entera. */
export function coversPage(areaFrac: number): boolean {
  return areaFrac >= FULL_PAGE_COVER;
}

/** Une los motivos del clasificador con los del motor sin repetirse. */
export function mergeReasons(mine: ReadonlyArray<string>, theirs: ReadonlyArray<string>): string[] {
  const out = [...mine];
  for (const reason of theirs) {
    if (reason === "transparente" && mine.some((entry) => entry.includes("transparente"))) continue;
    if (/^repetida en \d+ páginas$/.test(reason) && mine.some((entry) => entry.includes("repetida en"))) continue;
    if (!out.includes(reason)) out.push(reason);
  }
  return out;
}
