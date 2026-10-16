/*
 * Colocacion de los campos del automapeo sobre las lineas encontradas. Funciones PURAS en el espacio de vista
 * (puntos, origen abajo-izquierda). Todas las medidas se expresan en «em» (la unidad tipografica del documento),
 * asi un contrato ampliado o reducido da la misma disposicion.
 *
 * Disposicion de iniciales (decision del usuario, plan §12): con DOS firmantes, una al lado de la otra sobre la linea
 * del documento: firmante 1 a la izquierda y firmante 2 a la derecha. Si la linea es corta (no caben dos iniciales
 * en su largo) se colocan dos casillas contiguas a partir del inicio de la linea, respetando el margen de la pagina.
 */

export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Ancho minimo y maximo de una inicial, alto del hueco de iniciales y de firma (en em). */
export const INITIAL_MIN_W_EM = 3.4;
export const INITIAL_MAX_W_EM = 6.2;
export const INITIAL_H_EM = 2.9;
export const SIGNATURE_H_EM = 3.6;
export const SIGNATURE_MIN_H_EM = 1.8;
export const SIGNATURE_MAX_W_FRACTION = 0.5;
export const SIGNATURE_MIN_W_EM = 6;
export const DATE_H_EM = 1.7;
export const TEXT_H_EM = 1.7;
/** Hueco que se deja entre las iniciales de dos firmantes y sobre la linea (em). */
const PAIR_GAP_EM = 0.3;
const LIFT_EM = 0.1;
/** Margen de pagina que no se invade (fraccion del ancho; minimo 2 em). */
export const PAGE_MARGIN_FRACTION = 0.035;

export type TextBox = Rect;

/**
 * Unidad de disposicion («em») de una pagina: el 1,8 % de su ancho (11 pt en una carta). Es una medida de la PAGINA, no
 * del texto: el tamano de una firma o de unas iniciales a mano no depende de la letra del contrato, y un documento
 * ampliado o reducido (su pagina tambien lo esta) da la misma disposicion.
 */
export const PAGE_EM_FRACTION = 0.018;
export function pageEm(pageWidth: number): number {
  return PAGE_EM_FRACTION * pageWidth;
}

export function rectWidth(r: Rect): number {
  return r.x1 - r.x0;
}
export function rectHeight(r: Rect): number {
  return r.y1 - r.y0;
}

function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Fraccion del rectangulo cubierta por los cuadros dados (aproximada: suma de intersecciones acotada a 1). Los
 * cuadros no se solapan entre si en un texto normal, asi que la suma es una buena medida.
 */
export function coverage(rect: Rect, boxes: readonly Rect[]): number {
  const area = rectWidth(rect) * rectHeight(rect);
  if (area <= 0) return 0;
  let covered = 0;
  for (const box of boxes) covered += intersectionArea(rect, box);
  return Math.min(1, covered / area);
}

export type LayoutEnv = {
  em: number;
  pageWidth: number;
  pageHeight: number;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function pageMargin(env: LayoutEnv): number {
  return Math.max(PAGE_MARGIN_FRACTION * env.pageWidth, 2 * env.em);
}

/** Un origen de iniciales: una raya, una casilla vacia o varias marcas contiguas de subrayado («__/__»). */
export type InitialsHost = {
  /** Extremo izquierdo/derecho y ordenada de la raya (o del borde inferior de la casilla). */
  x0: number;
  x1: number;
  y: number;
  /** Casilla vacia: el rectangulo ya existe en el documento. */
  box?: Rect;
  /** Marcas contiguas de la misma raya de texto («(____/____)»), de izquierda a derecha. */
  slots?: ReadonlyArray<{ x0: number; x1: number }>;
  /** La raya sale de un texto de subrayados: se centra sobre la fila de texto. */
  fromText?: boolean;
  /** Fin de la etiqueta a su izquierda (las casillas no pueden retroceder mas alla). */
  labelRight?: number;
};

export type InitialsLayout = {
  rects: Rect[];
  /** Cuando fue necesario comprimir o desplazar por falta de sitio. */
  tight: boolean;
  mode: "slots" | "box" | "halves" | "contiguous" | "single";
};

function initialsRow(host: InitialsHost, env: LayoutEnv): { y0: number; y1: number } {
  const em = env.em;
  if (host.box) return { y0: host.box.y0, y1: host.box.y1 };
  const lift = host.fromText ? -0.45 * em : LIFT_EM * em;
  const y0 = host.y + lift;
  return { y0, y1: y0 + INITIAL_H_EM * em };
}

/** Coloca las iniciales de 1 o 2 firmantes sobre un anfitrion. */
export function layoutInitials(host: InitialsHost, signers: 1 | 2, env: LayoutEnv): InitialsLayout {
  const em = env.em;
  const minW = INITIAL_MIN_W_EM * em;
  const maxW = INITIAL_MAX_W_EM * em;
  const gap = PAIR_GAP_EM * em;
  const margin = pageMargin(env);
  const limitRight = env.pageWidth - margin;
  const { y0, y1 } = initialsRow(host, env);
  const make = (x0: number, x1: number): Rect => ({ x0, y0, x1, y1 });

  // 1. Marcas contiguas del propio documento: una por firmante, en el orden en que aparecen.
  if (host.slots && host.slots.length >= 2) {
    const slots = host.slots.slice(0, signers);
    const rects = slots.map((slot) => {
      const center = (slot.x0 + slot.x1) / 2;
      const width = clamp(slot.x1 - slot.x0, minW, maxW);
      return make(center - width / 2, center + width / 2);
    });
    let tight = false;
    if (rects.length === 2 && rects[0].x1 > rects[1].x0) {
      // Las marcas estan mas juntas que dos iniciales: se parten por el punto medio entre centros.
      const c0 = (slots[0].x0 + slots[0].x1) / 2;
      const c1 = (slots[1].x0 + slots[1].x1) / 2;
      const mid = (c0 + c1) / 2;
      rects[0] = make(rects[0].x0, mid - gap / 2);
      rects[1] = make(mid + gap / 2, rects[1].x1);
      tight = true;
    }
    return { rects, tight, mode: "slots" };
  }

  // 2. Casilla vacia: la propia casilla (en dos mitades con dos firmantes).
  if (host.box) {
    const b = host.box;
    if (signers === 1) return { rects: [make(b.x0, b.x1)], tight: false, mode: "box" };
    const mid = (b.x0 + b.x1) / 2;
    return { rects: [make(b.x0, mid - gap / 2), make(mid + gap / 2, b.x1)], tight: rectWidth(b) < 2 * minW, mode: "box" };
  }

  const length = host.x1 - host.x0;
  // 3. Una sola persona: el largo de la raya acotado a una inicial normal.
  if (signers === 1) {
    const width = clamp(length, minW, maxW);
    const x0 = length >= minW ? host.x0 + (length - width) / 2 : host.x0;
    return { rects: [make(x0, x0 + width)], tight: length < minW, mode: "single" };
  }

  // 4. Dos firmantes sobre una raya larga: dos mitades iguales con margen.
  if (length >= 2 * minW + gap) {
    const half = (length - gap) / 2;
    const width = clamp(half, minW, maxW);
    const c0 = host.x0 + half / 2;
    const c1 = host.x1 - half / 2;
    return {
      rects: [make(c0 - width / 2, c0 + width / 2), make(c1 - width / 2, c1 + width / 2)],
      tight: false,
      mode: "halves",
    };
  }

  // 5. Raya corta: dos casillas contiguas desde el inicio de la raya, dentro del margen de la pagina.
  let width = Math.max(minW, Math.min(length, 1.35 * minW));
  let x0 = host.x0;
  let tight = false;
  if (x0 + 2 * width + gap > limitRight) {
    const overflow = x0 + 2 * width + gap - limitRight;
    const floor = host.labelRight !== undefined ? host.labelRight + 0.2 * em : margin;
    const shifted = Math.max(floor, x0 - overflow);
    tight = true;
    x0 = shifted;
    if (x0 + 2 * width + gap > limitRight) {
      width = Math.max(minW * 0.85, (limitRight - x0 - gap) / 2);
    }
  }
  return {
    rects: [make(x0, x0 + width), make(x0 + width + gap, x0 + 2 * width + gap)],
    tight,
    mode: "contiguous",
  };
}

export type SignatureLayout = { rect: Rect; blocked: boolean };

/**
 * Hueco de firma sobre una raya: ancho de la raya (acotado), alto de ~3,6 em hacia arriba, recortado por el texto
 * que haya encima (nunca lo cubre). `blocked` si queda menos de 2,2 em.
 */
export function layoutSignature(
  line: { x0: number; x1: number; y: number },
  env: LayoutEnv,
  textBoxes: readonly TextBox[],
): SignatureLayout {
  const em = env.em;
  let { x0, x1 } = line;
  const maxWidth = SIGNATURE_MAX_W_FRACTION * env.pageWidth;
  if (x1 - x0 > maxWidth) x1 = x0 + maxWidth;
  const minWidth = SIGNATURE_MIN_W_EM * em;
  if (x1 - x0 < minWidth) {
    const center = (x0 + x1) / 2;
    x0 = center - minWidth / 2;
    x1 = center + minWidth / 2;
  }
  const y0 = line.y + LIFT_EM * em;
  let top = y0 + SIGNATURE_H_EM * em;
  for (const box of textBoxes) {
    const overlapX = Math.min(x1, box.x1) - Math.max(x0, box.x0);
    if (overlapX < 0.15 * (x1 - x0) && overlapX < 3 * em) continue;
    if (box.y1 <= y0 + 0.3 * em) continue;
    if (box.y0 < top) top = Math.min(top, box.y0 - 0.1 * em);
  }
  const height = top - y0;
  const blocked = height < SIGNATURE_MIN_H_EM * em;
  return { rect: { x0, y0, x1, y1: y0 + Math.max(height, SIGNATURE_MIN_H_EM * em) }, blocked };
}

/** Hueco de fecha o de texto sobre una raya. */
export function layoutLine(
  line: { x0: number; x1: number; y: number },
  heightEm: number,
  env: LayoutEnv,
): Rect {
  const em = env.em;
  const y0 = line.y + 0.05 * em;
  return { x0: line.x0, x1: line.x1, y0, y1: y0 + heightEm * em };
}

/** Convierte un rectangulo del espacio de vista (puntos, y arriba) en rectangulo normalizado 0..1 (origen arriba-izquierda). */
export function toNormalized(
  rect: Rect,
  pageWidth: number,
  pageHeight: number,
): { x: number; y: number; width: number; height: number } {
  const x0 = clamp(rect.x0, 0, pageWidth);
  const x1 = clamp(rect.x1, 0, pageWidth);
  const y0 = clamp(rect.y0, 0, pageHeight);
  const y1 = clamp(rect.y1, 0, pageHeight);
  return {
    x: x0 / pageWidth,
    y: 1 - y1 / pageHeight,
    width: (x1 - x0) / pageWidth,
    height: (y1 - y0) / pageHeight,
  };
}
