import type {
  CoverOriented,
  TextBlock,
  TextEdit,
  UserBox,
} from "@/lib/pdf/editTypes";

/**
 * Geometria PURA de la cobertura del texto original (Wave 5, F1 "cubrir y
 * redibujar"). La comparten la exportacion (`editTextExport.ts`), la lectura
 * del fondo y la vista previa para que lo que se ve al editar sea exactamente
 * lo que se tapa al exportar.
 *
 * Dos problemas que resuelve:
 *  - D1: el texto girado un angulo LIBRE no se cubre con su caja envolvente
 *    (taparia el texto vecino que cae dentro): se cubre el rectangulo
 *    ORIENTADO real (`coverOriented`).
 *  - D4: la caja de pdf.js llega justo hasta el ascenso/descenso nominal de la
 *    fuente, pero los acentos de las mayusculas (Á, Ñ, Å...) suben hasta ~0,95
 *    em sobre la linea base y las colas (g, j, ç) bajan ~0,25 em: se amplia la
 *    cobertura arriba y abajo con esas metricas, sin invadir la linea vecina.
 */

/** Altura maxima (em sobre la linea base) a la que llegan los acentos de mayuscula. */
export const COVER_ACCENT_TOP_EM = 0.95;
/** Profundidad maxima (em bajo la linea base) de colas y cedillas. */
export const COVER_DESCENT_EM = 0.25;
/** Hueco (em) que se deja libre hacia la linea vecina cuando se amplia. */
const NEIGHBOR_GAP_EM = 0.25;
/** Tinta propia que la cobertura nunca recorta: versal (~0,72 em) y descenso (~0,21 em). */
const INK_ASCENT_EM = 0.72;
const INK_DESCENT_EM = 0.21;
const DEFAULT_LEAD_EM = 1.2;

/** Caja de otro bloque que la cobertura no debe tapar. */
export type Obstacle = { id?: string; box: UserBox };

export type CoverGeometry = {
  /** Caja del eje que cubre (sin el margen `padding`). */
  box: UserBox;
  /** Solo para giros que no son multiplo de 90: el rectangulo girado. */
  oriented?: CoverOriented;
};

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** True si `angle` (grados) es multiplo de 90 salvo ruido. */
export function isRightAngle(angle: number): boolean {
  const reduced = Math.abs(angle) % 90;
  return reduced < 0.01 || reduced > 89.99;
}

/**
 * Recorta `rect` para que no entre en las cajas de `obstacles` (otros bloques),
 * quitando solo lo que sobra: lo que `core` (el texto original que SI hay que
 * tapar) ocupa se conserva siempre. Cada obstaculo se resuelve por el lado en
 * que esta respecto al nucleo (el de mayor separacion normalizada), asi que un
 * vecino cuya caja nominal se solapa un poco con el nucleo recorta solo el margen
 * y la ampliacion de ese lado.
 */
export function clipToObstacles(
  rect: UserBox,
  core: UserBox,
  obstacles: readonly UserBox[],
): UserBox {
  let left = rect.x;
  let bottom = rect.y;
  let right = rect.x + rect.width;
  let top = rect.y + rect.height;
  const coreRight = core.x + core.width;
  const coreTop = core.y + core.height;
  const coreCx = core.x + core.width / 2;
  const coreCy = core.y + core.height / 2;
  for (const o of obstacles) {
    const oRight = o.x + o.width;
    const oTop = o.y + o.height;
    if (oRight <= left || o.x >= right || oTop <= bottom || o.y >= top) continue;
    const dx = Math.abs(o.x + o.width / 2 - coreCx) / ((o.width + core.width) / 2 || 1);
    const dy = Math.abs(o.y + o.height / 2 - coreCy) / ((o.height + core.height) / 2 || 1);
    if (dy >= dx) {
      if (o.y + o.height / 2 > coreCy) top = Math.max(coreTop, Math.min(top, o.y));
      else bottom = Math.min(core.y, Math.max(bottom, oTop));
    } else if (o.x + o.width / 2 > coreCx) {
      right = Math.max(coreRight, Math.min(right, o.x));
    } else {
      left = Math.min(core.x, Math.max(left, oRight));
    }
  }
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

/** Cuanto puede entrar la holgura de un borde fino en el nucleo de tinta (pt): colas de letras, no el cuerpo. */
export const STRIP_INTRUSION_PT = 0.4;

/**
 * Como `clipToObstacles` para franjas de BORDE FINO (celdas de tabla): la cobertura
 * debe quedar a una holgura de la linea para que el suavizado de su borde no aclare
 * el trazo a ningun zoom. Si la linea toca el texto (margen 0) esa holgura puede
 * entrar hasta `STRIP_INTRUSION_PT` en el nucleo de tinta: queda sin cubrir, como
 * mucho, la punta de una cola de letra, nunca el cuerpo del texto.
 */
export function clipToStrips(rect: UserBox, core: UserBox, strips: readonly UserBox[]): UserBox {
  if (strips.length === 0) return rect;
  const inset = Math.min(STRIP_INTRUSION_PT, core.width / 4, core.height / 4);
  const shrunk: UserBox = {
    x: core.x + inset,
    y: core.y + inset,
    width: core.width - inset * 2,
    height: core.height - inset * 2,
  };
  return clipToObstacles(rect, shrunk, strips);
}

/**
 * Cobertura de un bloque: su rectangulo orientado ampliado arriba y abajo con
 * las metricas de acentos y colas (nunca reducido). Sin `orientedBox`, o para
 * superindices, devuelve la caja del bloque tal cual.
 */
export function coverForBlock(
  block: TextBlock,
  neighbors: readonly Obstacle[] = [],
  strips: readonly UserBox[] = [],
): CoverGeometry {
  const plain: CoverGeometry = { box: { ...block.box } };
  const oriented = block.orientedBox;
  const first = block.lines[0];
  const last = block.lines[block.lines.length - 1];
  if (!oriented || !first?.origin || !last || block.script) return plain;

  const radians = (block.rotation * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);
  const vx = -uy;
  const vy = ux;
  // Coordenada perpendicular (hacia "arriba" del texto) desde el borde inferior.
  const localY = (point: { x: number; y: number }) =>
    (point.x - oriented.origin.x) * vx + (point.y - oriented.origin.y) * vy;
  const size = block.fontSize;
  const lead = block.lineHeight && block.lineHeight > 0 ? block.lineHeight : DEFAULT_LEAD_EM;
  // Limite por interlineado: el acento no llega a las colas de la linea de arriba.
  const up = Math.max(0.5, Math.min(COVER_ACCENT_TOP_EM, lead - NEIGHBOR_GAP_EM));
  const down = Math.max(0.1, Math.min(COVER_DESCENT_EM, lead - COVER_ACCENT_TOP_EM));

  const top = Math.max(oriented.height, localY(first.origin) + up * size);
  const bottom = Math.min(0, localY(last.origin ?? first.origin) - down * size);
  const width = oriented.width;
  const height = top - bottom;

  const origin = {
    x: oriented.origin.x + bottom * vx,
    y: oriented.origin.y + bottom * vy,
  };
  const corners = [
    origin,
    { x: origin.x + width * ux, y: origin.y + width * uy },
    { x: origin.x + height * vx, y: origin.y + height * vy },
    { x: origin.x + width * ux + height * vx, y: origin.y + width * uy + height * vy },
  ];
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const box: UserBox = {
    x: round(Math.min(...xs)),
    y: round(Math.min(...ys)),
    width: round(Math.max(...xs) - Math.min(...xs)),
    height: round(Math.max(...ys) - Math.min(...ys)),
  };
  if (isRightAngle(block.rotation)) {
    // La cobertura no puede tapar a un vecino: se recorta contra sus cajas. Lo que
    // nunca se recorta es la TINTA propia (de la caja de la ultima linea base menos
    // el descenso a la primera mas la altura de versal), no la caja nominal de pdf.js,
    // que puede entrar unas decimas en la del vecino y le borraria la base de las letras.
    const inkLow = Math.max(bottom, localY(last.origin ?? first.origin) - INK_DESCENT_EM * size);
    const inkHigh = Math.min(top, localY(first.origin) + INK_ASCENT_EM * size);
    const inkCorners = [
      [0, inkLow],
      [width, inkLow],
      [0, inkHigh],
      [width, inkHigh],
    ].map(([along, up]) => ({
      x: oriented.origin.x + along * ux + up * vx,
      y: oriented.origin.y + along * uy + up * vy,
    }));
    const ix = inkCorners.map((c) => c.x);
    const iy = inkCorners.map((c) => c.y);
    const core: UserBox = {
      x: Math.min(...ix),
      y: Math.min(...iy),
      width: Math.max(...ix) - Math.min(...ix),
      height: Math.max(...iy) - Math.min(...iy),
    };
    const clipped = clipToObstacles(box, core, neighbors.map((n) => n.box));
    return { box: clipToStrips(clipped, core, strips) };
  }
  return {
    box,
    oriented: {
      origin: { x: round(origin.x), y: round(origin.y) },
      width: round(width),
      height: round(height),
      rotation: block.rotation,
    },
  };
}

type Point = { x: number; y: number };

/** Parte de un vecino que cae DENTRO de la cobertura orientada y se deja sin cubrir. */
export type CoverHole = { id: string; polygon: Point[] };

export type CoverShape =
  | { kind: "rect"; box: UserBox }
  | {
      kind: "oriented";
      origin: Point;
      width: number;
      height: number;
      rotation: number;
      /**
       * Interseccion con las cajas de los vecinos conocidos (`obstacles`): se
       * pinta el rectangulo girado MENOS estos poligonos, para no borrar el
       * texto de otro bloque que cruza el original. Lo que queda del texto
       * original bajo un hueco sigue visible (se avisa `cover-overlaps-neighbor`).
       */
      holes: CoverHole[];
    };

/** Area (con signo: positiva si el poligono va en sentido antihorario). */
function polygonArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Sutherland-Hodgman: `subject` recortado contra el poligono CONVEXO `clip` (antihorario). */
function clipPolygon(subject: readonly Point[], clip: readonly Point[]): Point[] {
  let output = [...subject];
  for (let i = 0; i < clip.length && output.length > 0; i += 1) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const inside = (p: Point) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) >= 0;
    const cross = (p: Point, q: Point): Point => {
      const dp = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      const dq = (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x);
      const t = dp / (dp - dq);
      return { x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) };
    };
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j += 1) {
      const current = input[j];
      const previous = input[(j + input.length - 1) % input.length];
      if (inside(current)) {
        if (!inside(previous)) output.push(cross(previous, current));
        output.push(current);
      } else if (inside(previous)) {
        output.push(cross(previous, current));
      }
    }
  }
  return output;
}

/** Superficie minima (pt2) de un solape para contarlo como «el vecino cruza la cobertura». */
const MIN_HOLE_AREA = 0.5;
const HOLE_MARGIN = 0.5;

/** Huecos que dejan los vecinos en un rectangulo girado (esquinas antihorarias). */
function holesOf(corners: readonly Point[], obstacles: ReadonlyArray<{ id: string; box: UserBox }>): CoverHole[] {
  const holes: CoverHole[] = [];
  for (const o of obstacles) {
    // Medio punto de margen: el suavizado de los bordes del hueco no debe aclarar la tinta vecina.
    const x = o.box.x - HOLE_MARGIN;
    const y = o.box.y - HOLE_MARGIN;
    const width = o.box.width + HOLE_MARGIN * 2;
    const height = o.box.height + HOLE_MARGIN * 2;
    const polygon = clipPolygon(
      [
        { x, y },
        { x: x + width, y },
        { x: x + width, y: y + height },
        { x, y: y + height },
      ],
      corners,
    );
    if (polygon.length >= 3 && polygonArea(polygon) > MIN_HOLE_AREA) holes.push({ id: o.id, polygon });
  }
  return holes;
}

type CoverSource = Pick<TextEdit, "box" | "coverBox" | "coverOriented" | "cover"> &
  Partial<Pick<TextEdit, "obstacles" | "coverClip">>;

/**
 * Forma exacta que se pinta para `edit` (con su `padding`), o `null` si no se
 * cubre. Es la UNICA fuente de verdad para exportar y para la vista previa.
 */
export function coverShape(edit: CoverSource): CoverShape | null {
  if (!edit.cover.color) return null;
  const pad = Math.max(0, Number.isFinite(edit.cover.padding) ? edit.cover.padding : 0);
  const oriented = edit.coverOriented;
  if (oriented && !isRightAngle(oriented.rotation)) {
    const radians = (oriented.rotation * Math.PI) / 180;
    const ux = Math.cos(radians);
    const uy = Math.sin(radians);
    const origin = {
      x: oriented.origin.x - pad * ux + pad * uy,
      y: oriented.origin.y - pad * uy - pad * ux,
    };
    const width = oriented.width + pad * 2;
    const height = oriented.height + pad * 2;
    const corners = [
      origin,
      { x: origin.x + width * ux, y: origin.y + width * uy },
      { x: origin.x + width * ux - height * uy, y: origin.y + width * uy + height * ux },
      { x: origin.x - height * uy, y: origin.y + height * ux },
    ];
    return {
      kind: "oriented",
      origin,
      width,
      height,
      rotation: oriented.rotation,
      holes: holesOf(corners, edit.obstacles ?? []),
    };
  }
  const base = edit.coverBox ?? edit.box;
  const padded: UserBox = {
    x: base.x - pad,
    y: base.y - pad,
    width: base.width + pad * 2,
    height: base.height + pad * 2,
  };
  // Un vecino a menos de `padding` pt: el margen se recorta, nunca tapa su tinta.
  const blockers = (edit.obstacles ?? []).map((o) => o.box);
  const byBlocks = blockers.length > 0 ? clipToObstacles(padded, base, blockers) : padded;
  return { kind: "rect", box: clipToStrips(byBlocks, base, edit.coverClip ?? []) };
}

/** Cuatro esquinas de la forma, en espacio de usuario (para dibujar o medir). */
export function coverCorners(shape: CoverShape): Array<{ x: number; y: number }> {
  if (shape.kind === "rect") {
    const { x, y, width, height } = shape.box;
    return [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ];
  }
  const radians = (shape.rotation * Math.PI) / 180;
  const ux = Math.cos(radians);
  const uy = Math.sin(radians);
  const { origin, width, height } = shape;
  return [
    { x: origin.x, y: origin.y },
    { x: origin.x + width * ux, y: origin.y + width * uy },
    { x: origin.x + width * ux - height * uy, y: origin.y + width * uy + height * ux },
    { x: origin.x - height * uy, y: origin.y + height * ux },
  ];
}

/** Caja del eje que envuelve la forma (para leer el fondo FUERA de ella). */
export function coverExtent(shape: CoverShape): UserBox {
  const corners = coverCorners(shape);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Caja del eje de la cobertura (con `padding`) que debe quedar DENTRO al
 * muestrear el fondo de `block`: el anillo de muestreo se toma fuera de ella.
 */
export function blockCoverExtent(
  block: TextBlock,
  padding = 1,
  neighbors: readonly Obstacle[] = [],
): UserBox {
  const geometry = coverForBlock(block, neighbors);
  const shape = coverShape({
    box: block.box,
    coverBox: geometry.box,
    coverOriented: geometry.oriented,
    obstacles: neighbors.map((n, index) => ({ id: n.id ?? String(index), box: n.box })),
    cover: { color: "#000000", padding },
  });
  return shape ? coverExtent(shape) : geometry.box;
}

/**
 * (W5-U5) Esquinas de la cobertura de `block` (con `padding`) cuando el texto esta girado
 * un angulo LIBRE, o `null` si se cubre con una caja del eje. El muestreo del fondo toma
 * su anillo pegado a este cuadrilatero y no alrededor de la caja envolvente: asi los vecinos
 * que caen dentro de la envolvente pero lejos de lo que se tapa no dan un falso «fondo no
 * uniforme».
 */
export function blockCoverQuad(block: TextBlock, padding = 1): Array<{ x: number; y: number }> | null {
  const geometry = coverForBlock(block);
  if (!geometry.oriented) return null;
  const shape = coverShape({
    box: block.box,
    coverBox: geometry.box,
    coverOriented: geometry.oriented,
    cover: { color: "#000000", padding },
  });
  return shape && shape.kind === "oriented" ? coverCorners(shape) : null;
}

/**
 * Solape de dos poligonos CONVEXOS (SAT): hay solape si, en TODOS los ejes de
 * ambas formas, la penetracion supera `tolerance`. Con dos rectangulos del eje
 * equivale a «se solapan mas de `tolerance` en x y en y»; con un rectangulo
 * girado compara la forma real, no su caja envolvente, y por eso un vecino que
 * solo cae dentro de la envolvente NO cuenta.
 */
export function polygonsOverlap(
  a: ReadonlyArray<{ x: number; y: number }>,
  b: ReadonlyArray<{ x: number; y: number }>,
  tolerance = 0,
): boolean {
  for (const shape of [a, b]) {
    for (let i = 0; i < shape.length; i += 1) {
      const p = shape[i];
      const q = shape[(i + 1) % shape.length];
      const nx = q.y - p.y;
      const ny = p.x - q.x;
      const length = Math.hypot(nx, ny);
      if (length === 0) continue;
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const point of a) {
        const d = (point.x * nx + point.y * ny) / length;
        minA = Math.min(minA, d);
        maxA = Math.max(maxA, d);
      }
      for (const point of b) {
        const d = (point.x * nx + point.y * ny) / length;
        minB = Math.min(minB, d);
        maxB = Math.max(maxB, d);
      }
      if (Math.min(maxA, maxB) - Math.max(minA, minB) <= tolerance) return false;
    }
  }
  return true;
}

/** Esquinas (antihorarias) de una caja del eje. */
export function boxPolygon(box: UserBox): Array<{ x: number; y: number }> {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ];
}
