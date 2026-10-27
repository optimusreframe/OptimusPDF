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
  SIGNATURE_MAX_WIDTH_LABELLED,
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
  /** Alto de la caja respecto al LADO LARGO de la pagina (igual que `heightFrac` en una pagina vertical; menor en una apaisada). */
  longHeightFrac?: number;
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
/**
 * Limites de la tinta gruesa aceptada con etiqueta: cubetas de color y fraccion de tinta. Las cubetas solo cuentan si la tinta NO es de
 * un solo tono: el ruido de compresion de un JPEG multiplica las cubetas de unas iniciales de un solo color (43 en un JPEG real).
 */
export const LOOSE_MAX_BINS = 6;
export const LOOSE_MAX_INK = 0.3;
/** Con menos de esta fraccion de transparencia una imagen es un escaneo OPACO, y solo es una firma si hay una etiqueta de firma cerca. */
export const OPAQUE_BELOW_TRANSPARENT = 0.15;
/** Confianza maxima de unas iniciales de trazo grueso en el pie SIN etiqueta de iniciales cerca (podria ser un logo). */
export const NO_LABEL_THICK_MAX_CONFIDENCE = 0.65;
/** Un sello tiene una proporcion normal (no una tira de borde de pagina): un sello rectangular de «APROBADO» llega a 3:1. */
export const STAMP_ASPECT = { min: 0.45, max: 4 } as const;
/**
 * Mas columnas/filas casi enteras que esto es un codigo de barras o una raya, no una firma... salvo que sean UNO o DOS trazos (la
 * «I» de unas iniciales, el palo de una «T»): las barras de verdad son `MIN_BAR_RUNS` o mas, o una banda ancha (`MAX_STROKE_SPAN`).
 */
export const MAX_FULL_SPAN = 0.12;
export const MIN_BAR_RUNS = 6;
export const MAX_STROKE_SPAN = 0.3;
/** La tinta de una firma no es una raya: su caja es como mucho 9 veces mas ancha que alta (una cenefa o una raya ornamental, 25 veces). */
export const MAX_INK_ASPECT = 9;
/** Un marco de verdad tiene tinta en los cuatro lados: cobertura minima de cada borde. */
export const FRAME_MIN_SIDES = 0.85;
/** Dimensiones minimas (puntos) de una firma o unas iniciales: un icono de 20 pt no lo es. */
export const MIN_SIGNATURE_PT = { width: 28, height: 12 } as const;

const noisyOr = (weights: ReadonlyArray<number>): number => 1 - weights.reduce((product, weight) => product * (1 - weight), 1);
const round2 = (value: number): number => Math.round(value * 100) / 100;
const pct = (value: number): string => `${Math.max(1, Math.round(value * 100))} %`;
/** Area como fraccion de la pagina: «menos del 1 %» si es diminuta. */
const areaPhrase = (value: number): string => (value < 0.01 ? "ocupa menos del 1 % de la página" : `ocupa el ${pct(value)} de la página`);
const decimal = (value: number): string => value.toFixed(1).replace(".", ",");

/**
 * Tinta de UN solo tono: casi sin color (negra, gris) o con un tono dominante (azul de boligrafo). El ruido de un JPEG cambia las cubetas
 * de color pero no el tono, asi que es la forma fiable de distinguir unas iniciales de una insignia de varios colores.
 */
export function isMonoInk(features: PixelFeatures): boolean {
  return features.chromaticShare <= 0.2 || (features.chromaticShare >= 0.6 && features.dominantHueShare >= 0.85);
}

/** Muchas barras (codigo de barras, raya) y no uno o dos trazos de una letra. */
export function isBarLike(features: PixelFeatures): boolean {
  if (features.fullSpanShare <= MAX_FULL_SPAN) return false;
  return features.fullSpanRuns >= MIN_BAR_RUNS || features.fullSpanShare > MAX_STROKE_SPAN;
}

/**
 * Tinta oscura o azul sobre fondo transparente o casi blanco: lo que tiene una firma. Un trazo FINO (solidez baja) basta por si solo;
 * unas iniciales hechas con un rotulador grueso tienen mas relleno (solidez hasta `LOOSE_SOLIDITY`), y solo se aceptan con una
 * etiqueta de firma o iniciales cerca (`loose`), que tambien perdona el fondo con sombra de una foto (`localPaper`).
 */
export function isInkLike(features: PixelFeatures | null, loose = false): boolean {
  if (!features) return false;
  if (!features.lightBackground && !(loose && features.localPaper)) return false;
  if (features.inkFraction < 0.004 || features.inkFraction > SIGNATURE_MAX_INK) return false;
  if (features.solidity > (loose ? LOOSE_SOLIDITY : SIGNATURE_MAX_SOLIDITY)) return false;
  // Una tinta gruesa solo vale si es de UN tono y ocupa poco: una insignia de colores con mucho relleno no son unas iniciales.
  if (loose && features.solidity > SIGNATURE_MAX_SOLIDITY) {
    if (features.inkFraction > LOOSE_MAX_INK) return false;
    if (features.colorBins > LOOSE_MAX_BINS && !isMonoInk(features)) return false;
  }
  if (features.darkShare + features.blueShare < 0.7) return false;
  if (isBarLike(features)) return false;
  return true;
}

/** Aro o marco de un color saturado: un sello. */
export function stampShape(features: PixelFeatures | null): "ring" | "frame" | null {
  if (!features || features.inkFraction < 0.01) return null;
  if (features.chromaticShare < 0.6 || features.dominantHueShare < 0.75 || features.inkSaturation < 0.45) return null;
  if (features.ringShare >= 0.55 && features.centerShare <= 0.45) return "ring";
  if (features.frameShare >= 0.45 && features.frameSides >= FRAME_MIN_SIDES) return "frame";
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
  const sigLabel = input.signatureLabel;
  const iniLabel = input.initialsLabel;
  const hasLabel = !!(sigLabel || iniLabel);
  const aspectSignature = g.aspect >= SIGNATURE_ASPECT.min && g.aspect <= SIGNATURE_ASPECT.max;
  const aspectInitials = g.aspect >= INITIALS_ASPECT.min && g.aspect <= INITIALS_ASPECT.max && g.areaFrac <= INITIALS_MAX_AREA;
  const repeated = g.repeatPages >= 2;
  // Unas iniciales en el pie de varias paginas (lo que deja un firmado) no llevan siempre una etiqueta cerca: se admite su trazo grueso.
  const footerInitials = !hasLabel && g.band === "bottom" && repeated && aspectInitials;
  if (!features || !isInkLike(features, hasLabel || footerInitials)) return null;
  if (stampShape(features)) return null;
  // Un escaneo opaco sin etiqueta cerca (una imagen impresa en la plantilla, un dibujo) no se ofrece como firma.
  if (features.transparent < OPAQUE_BELOW_TRANSPARENT && !hasLabel) return null;
  // Altura respecto al lado LARGO de la pagina (no sesga las apaisadas). Una firma GRANDE solo se admite recortada (con transparencia) y con
  // una etiqueta de firma cerca: un JPEG opaco grande junto a un texto es casi siempre un logo o una foto.
  const large = hasLabel && features.transparent >= OPAQUE_BELOW_TRANSPARENT;
  const height = Math.min(g.heightFrac, g.longHeightFrac ?? g.heightFrac);
  if (height < SIGNATURE_HEIGHT.min || height > (large ? SIGNATURE_HEIGHT.maxLabelled : SIGNATURE_HEIGHT.max)) return null;
  if (g.widthPt < MIN_SIGNATURE_PT.width || g.heightPt < MIN_SIGNATURE_PT.height) return null;
  if (g.widthFrac > (large ? SIGNATURE_MAX_WIDTH_LABELLED : SIGNATURE_MAX_WIDTH)) return null;
  // Un circulo o un cuadro vacios (la casilla de las iniciales dibujada) no son una firma.
  if ((features.ringShare >= 0.55 && features.centerShare <= 0.3) || (features.frameShare >= 0.6 && features.frameSides >= FRAME_MIN_SIDES)) return null;

  let kind: "signature" | "initials";
  // Con las dos etiquetas cerca (las casillas de firma e iniciales estan juntas en el pie) manda el tamano: pequeno y casi cuadrado = iniciales.
  if (iniLabel && sigLabel) kind = aspectInitials && g.aspect < SIGNATURE_ASPECT.min * 1.2 ? "initials" : "signature";
  else if (iniLabel) kind = "initials";
  else if (sigLabel) kind = "signature";
  else if (aspectInitials && (!aspectSignature || repeated || g.aspect < SIGNATURE_ASPECT.min * 1.2)) kind = "initials";
  else kind = "signature";

  const thin = features.solidity <= SIGNATURE_MAX_SOLIDITY;
  // Una raya o cenefa (tinta mucho mas ancha que alta) no es una firma ni unas iniciales.
  const inkAspect = (features.inkBox.width * features.width) / Math.max(1e-6, features.inkBox.height * features.height);
  if (features.inkBox.height > 0 && inkAspect > MAX_INK_ASPECT) return null;
  // La tinta GRUESA (relleno de rotulador) solo tolera el ruido de un JPEG (muchas cubetas de color de un mismo tono) como unas iniciales
  // pequenas y casi cuadradas; una firma gruesa o una marca ancha y rellena (un logo) han de ser de pocos colores, como antes.
  if (!thin && !(kind === "initials" && aspectInitials) && features.colorBins > LOOSE_MAX_BINS) return null;
  if (kind === "signature" && !aspectSignature) {
    // Con etiqueta de firma se acepta una firma algo mas cuadrada y de trazo fino (un icono relleno junto a «Firma» no lo es); sin ella no.
    if (!sigLabel || !thin || g.aspect < INITIALS_ASPECT.min || g.aspect > SIGNATURE_ASPECT.max * 1.5) return null;
  }
  if (kind === "initials" && !aspectInitials) {
    if (!iniLabel || g.aspect < INITIALS_ASPECT.min * 0.7 || g.aspect > SIGNATURE_ASPECT.max) return null;
  }
  // Una imagen repetida en cabecera/pie que no es pequena ni lleva etiqueta es un logo, no unas iniciales.
  if (kind === "initials" && !iniLabel && g.band && g.areaFrac > INITIALS_MAX_AREA) return null;
  // Una firma NO se repite en la cabecera de todas las paginas: un manuscrito asi sin etiqueta es un logotipo.
  if (kind === "signature" && !sigLabel && g.band === "top") return null;

  const weights: number[] = [0.45];
  const reasons: string[] = [];
  reasons.push(`${thin ? "tinta fina" : "tinta gruesa"} ${features.blueShare >= features.darkShare ? "azul" : "oscura"}`);
  if (features.transparent >= 0.15) {
    weights.push(0.15);
    reasons.push("fondo transparente");
  } else if (features.localPaper) {
    weights.push(0.05);
    reasons.push("fondo de papel con sombra");
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
  let cap = HEURISTIC_MAX_CONFIDENCE;
  if (kind === "initials" && !iniLabel && !thin) {
    // Sin etiqueta y de trazo grueso tambien podria ser una marca de la empresa: solo «posible».
    reasons.push("sin etiqueta de iniciales cerca: tambien podria ser un logo");
    cap = NO_LABEL_THICK_MAX_CONFIDENCE;
  }
  return { kind, confidence: Math.min(cap, round2(noisyOr(weights))), reasons };
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
    if (g.band === "bottom" && !!features && features.darkShare >= 0.7 && features.colorBins <= 3 && g.areaFrac <= INITIALS_MAX_AREA) {
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
