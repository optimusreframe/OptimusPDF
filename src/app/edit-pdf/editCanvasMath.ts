import {
  normalizedRectToUserBox,
  userBoxToNormalizedRect,
  viewPointToUser,
  type Box,
  type PageGeometry,
} from "@/lib/pdf/core";
import { mapSourceFont, sourceFontStyle } from "@/lib/pdf/editFonts";
import { SCAN_PT, sampleBackgroundColor, type BackgroundSample } from "@/lib/pdf/editBackground";
import { DEFAULT_LINE_HEIGHT, unrotatedSize } from "@/lib/pdf/editTextExport";
import type { CatalogFontKey, TextBlock, TextEdit, UserBox } from "@/lib/pdf/editTypes";
import { blockToTextEdit } from "@/app/edit-pdf/editSession";
import { exportBaselineFromTop } from "@/app/edit-pdf/previewMetrics";

/**
 * Geometria PURA del lienzo de edicion inline (Wave 5 · U4a). Sin React ni DOM:
 * convierte entre el ESPACIO DE USUARIO del PDF (puntos, origen abajo-izquierda,
 * sin `/Rotate`, el de `TextBlock`/`TextEdit`) y los pixeles CSS de la hoja
 * renderizada (origen arriba-izquierda, con `/Rotate` aplicado), apoyandose en
 * `getPageGeometry`-compatible de `core.ts`.
 */

/** Rectangulo en px CSS de la hoja, origen arriba-izquierda. */
export type PxRect = { left: number; top: number; width: number; height: number };

export type PageMetrics = {
  geometry: PageGeometry;
  /** Ancho / alto de la hoja renderizada en px CSS. */
  cssWidth: number;
  cssHeight: number;
  /** px CSS por punto PDF. */
  scale: number;
};

/** Umbral (px) bajo el cual un movimiento de puntero sigue siendo un toque. */
export const TAP_MOVE_THRESHOLD_PX = 8;
/** Ventana (ms) y distancia (px) del doble toque que entra a editar. */
export const DOUBLE_TAP_MS = 450;
export const DOUBLE_TAP_DISTANCE_PX = 24;
/** Margen extra (pt) de la cobertura alrededor del texto original. */
export const COVER_PADDING_PT = 1;
export const NEW_TEXT_WIDTH_PT = 200;
export const NEW_TEXT_FONT_SIZE = 12;
/** Pasos de las flechas (pt de pagina). */
export const NUDGE_STEP_PT = 1;
export const NUDGE_BIG_STEP_PT = 10;
export const MIN_BOX_PT = 6;

/** `PageGeometry` desde los datos de una pagina de pdf.js (`view`, `rotate`). */
export function geometryFromPdfJsPage(page: {
  view: readonly number[];
  rotate: number;
}): PageGeometry {
  const [x0, y0, x1, y1] = page.view;
  const box: Box = {
    x: Math.min(x0, x1),
    y: Math.min(y0, y1),
    width: Math.abs(x1 - x0),
    height: Math.abs(y1 - y0),
  };
  const rotation = ((Math.round((page.rotate || 0) / 90) * 90) % 360 + 360) % 360;
  const swapped = rotation === 90 || rotation === 270;
  return {
    box,
    rotation,
    viewWidth: swapped ? box.height : box.width,
    viewHeight: swapped ? box.width : box.height,
  };
}

export function makeMetrics(geometry: PageGeometry, cssWidth: number): PageMetrics {
  const width = Math.max(1, cssWidth);
  const scale = width / Math.max(1, geometry.viewWidth);
  return { geometry, cssWidth: width, cssHeight: geometry.viewHeight * scale, scale };
}

/** Caja de usuario -> rectangulo (envolvente) en px de la hoja. */
export function userBoxToPx(metrics: PageMetrics, box: Box): PxRect {
  const r = userBoxToNormalizedRect(metrics.geometry, box);
  return {
    left: r.x * metrics.cssWidth,
    top: r.y * metrics.cssHeight,
    width: r.width * metrics.cssWidth,
    height: r.height * metrics.cssHeight,
  };
}

/** Rectangulo en px de la hoja -> caja de usuario (envolvente). */
export function pxRectToUserBox(metrics: PageMetrics, rect: PxRect): UserBox {
  return normalizedRectToUserBox(metrics.geometry, {
    x: rect.left / metrics.cssWidth,
    y: rect.top / metrics.cssHeight,
    width: rect.width / metrics.cssWidth,
    height: rect.height / metrics.cssHeight,
  });
}

/**
 * Desplazamiento en espacio de usuario equivalente a mover `dxPx`/`dyPx`
 * (px de la hoja, `dy` positivo hacia abajo) en la vista.
 */
export function userDeltaFromView(
  metrics: PageMetrics,
  dxPx: number,
  dyPx: number,
): { dx: number; dy: number } {
  const origin = viewPointToUser(metrics.geometry, 0, 0);
  const moved = viewPointToUser(metrics.geometry, dxPx / metrics.scale, -dyPx / metrics.scale);
  return { dx: moved.x - origin.x, dy: moved.y - origin.y };
}

export type NudgeDirection = "left" | "right" | "up" | "down";

/** Desplazamiento de usuario de una flecha (en la VISTA, sea cual sea `/Rotate`). */
export function nudgeDelta(
  metrics: PageMetrics,
  direction: NudgeDirection,
  big: boolean,
): { dx: number; dy: number } {
  const step = (big ? NUDGE_BIG_STEP_PT : NUDGE_STEP_PT) * metrics.scale;
  const vx = direction === "left" ? -step : direction === "right" ? step : 0;
  const vy = direction === "up" ? -step : direction === "down" ? step : 0;
  return userDeltaFromView(metrics, vx, vy);
}

/** Colocacion CSS de un cuadro de texto: esquina sup-izq del rectangulo girado, tamano y giro. */
export type TextFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Grados CSS (sentido horario). */
  angle: number;
};

/**
 * Donde y como pintar el cuadro de texto de `box`/`rotation` (los mismos que
 * dibuja `applyTextEdits`): el rectangulo SIN girar, centrado en el centro de
 * la caja, girado `/Rotate - rotation` en la vista. Anclar la esquina superior
 * izquierda y `transform-origin: 0 0` deja crecer el texto hacia abajo, como
 * al exportar.
 */
export function textFrame(
  metrics: PageMetrics,
  box: Box,
  rotation: number,
): TextFrame {
  const size = unrotatedSize(box, rotation);
  const width = size.width * metrics.scale;
  const height = size.height * metrics.scale;
  const rect = userBoxToPx(metrics, box);
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  let angle = (((metrics.geometry.rotation - rotation) % 360) + 360) % 360;
  if (angle > 180) angle -= 360;
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const hx = -width / 2;
  const hy = -height / 2;
  return {
    left: cx + hx * cos - hy * sin,
    top: cy + hx * sin + hy * cos,
    width,
    height,
    angle: Math.abs(angle) < 1e-9 ? 0 : angle,
  };
}

export function clampPxRect(
  rect: PxRect,
  bounds: { width: number; height: number },
): PxRect {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return {
    width,
    height,
    left: Math.min(Math.max(0, rect.left), Math.max(0, bounds.width - width)),
    top: Math.min(Math.max(0, rect.top), Math.max(0, bounds.height - height)),
  };
}

export type ResizeHandle = "nw" | "ne" | "sw" | "se";

/** Redimensiona un rectangulo arrastrando una esquina; el lado opuesto queda fijo. */
export function resizePxRect(
  rect: PxRect,
  handle: ResizeHandle,
  dx: number,
  dy: number,
  min: number,
  bounds: { width: number; height: number },
): PxRect {
  let left = rect.left;
  let top = rect.top;
  let right = rect.left + rect.width;
  let bottom = rect.top + rect.height;
  if (handle === "nw" || handle === "sw") left = Math.min(right - min, left + dx);
  else right = Math.max(left + min, right + dx);
  if (handle === "nw" || handle === "ne") top = Math.min(bottom - min, top + dy);
  else bottom = Math.max(top + min, bottom + dy);
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(bounds.width, right);
  bottom = Math.min(bounds.height, bottom);
  return {
    left,
    top,
    width: Math.max(min, right - left),
    height: Math.max(min, bottom - top),
  };
}

/** Rectangulo (px) de un texto NUEVO por clic (`end` igual que `start`) o por arrastre. */
export function newTextPxRect(
  metrics: PageMetrics,
  start: { x: number; y: number },
  end: { x: number; y: number },
): PxRect {
  const minHeight = NEW_TEXT_FONT_SIZE * DEFAULT_LINE_HEIGHT * metrics.scale;
  const dragged = Math.hypot(end.x - start.x, end.y - start.y) > TAP_MOVE_THRESHOLD_PX;
  if (!dragged) {
    const width = Math.min(NEW_TEXT_WIDTH_PT * metrics.scale, metrics.cssWidth);
    return clampPxRect(
      { left: start.x, top: start.y, width, height: minHeight },
      { width: metrics.cssWidth, height: metrics.cssHeight },
    );
  }
  const left = Math.min(start.x, end.x);
  const top = Math.min(start.y, end.y);
  return clampPxRect(
    {
      left,
      top,
      width: Math.max(Math.abs(end.x - start.x), 24),
      height: Math.max(Math.abs(end.y - start.y), minHeight),
    },
    { width: metrics.cssWidth, height: metrics.cssHeight },
  );
}

/* ------------------------------------------------------------------ *
 * Edicion nueva a partir de un bloque
 * ------------------------------------------------------------------ */

/**
 * Cerca de 45 grados la caja envolvente NO permite recuperar el ancho y el alto
 * del texto sin girar (`unrotatedSize` supone un cuadrado): el texto se
 * partiria en lineas de mas. Ahi el rectangulo sin girar es un cuadrado lo
 * bastante ancho.
 */
function nearDiagonal(rotation: number): boolean {
  const radians = (rotation * Math.PI) / 90; // 2 * angulo
  return Math.abs(Math.cos(radians)) < 0.12 && rotation % 90 !== 0;
}

/**
 * Caja de la edicion de un bloque GIRADO: el rectangulo sin girar (con holgura
 * de ancho y el borde superior puesto para que la primera linea base caiga en
 * la original), anclado segun la alineacion, y su caja envolvente. Es la
 * inversa exacta de lo que dibuja `applyTextEdits` (centro de la caja, giro
 * `rotation`, ancho `unrotatedSize`).
 */
function rotatedBox(
  block: TextBlock,
  fontKey: CatalogFontKey,
  lineHeight: number,
): UserBox | null {
  const first = block.lines[0];
  const origin = first?.origin;
  const oriented = block.orientedBox;
  if (!origin || !oriented) return null;
  const angle = (block.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const length = Math.max(first.length ?? 0, oriented.width);
  const baseline = exportBaselineFromTop(fontKey, lineHeight) * block.fontSize;
  const diagonal = nearDiagonal(block.rotation);
  // Distancia de la linea base al borde inferior y al superior del texto original.
  const below = (origin.x - oriented.origin.x) * -sin + (origin.y - oriented.origin.y) * cos;
  const above = Math.max(0, oriented.height - below);
  const lift = baseline - above;
  const width = length * 1.02 + 2;
  const height = diagonal ? width : Math.max(baseline + below, oriented.height + lift);
  const along =
    block.align === "right" ? length - width : block.align === "center" ? (length - width) / 2 : 0;
  // Esquina superior izquierda del rectangulo (x' a lo largo del texto, y' hacia arriba).
  const tlX = origin.x + along * cos - baseline * sin;
  const tlY = origin.y + along * sin + baseline * cos;
  const cx = tlX + (width / 2) * cos + (height / 2) * sin;
  const cy = tlY + (width / 2) * sin - (height / 2) * cos;
  const w = width * Math.abs(cos) + height * Math.abs(sin);
  const h = width * Math.abs(sin) + height * Math.abs(cos);
  return { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
}

/** Margen (pt) que se respeta al crecer hacia el borde de la pagina y entre vecinos. */
const GROW_PAGE_MARGIN_PT = 12;
const GROW_NEIGHBOR_GAP_PT = 4;
/** Cuantas lineas hacia abajo se vigilan bloques vecinos si el texto se parte. */
const OBSTACLE_LINES_BELOW = 6;
const MAX_OBSTACLES = 24;

/** Lo que el borrador necesita saber de su pagina para crecer sin pisar a nadie. */
export type PageLayout = {
  /** CropBox de la pagina, espacio de usuario. */
  pageBox: UserBox;
  /** Bloques de texto de la pagina (el propio se ignora). */
  neighbors: readonly TextBlock[];
};

/** `PageLayout` de la pagina en pantalla, o `undefined` si aun no hay medidas. */
export function pageLayoutOf(
  metrics: PageMetrics | null,
  neighbors: readonly TextBlock[],
): PageLayout | undefined {
  return metrics ? { pageBox: metrics.geometry.box, neighbors } : undefined;
}

/** Distancia (pt) alrededor de un bloque en la que un vecino cuenta como pegado. */
const NEAR_NEIGHBOR_PT = 12;

function boxesIntersect(a: UserBox, b: UserBox): boolean {
  return (
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
  );
}

function verticalOverlap(a: UserBox, b: UserBox): number {
  return Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
}

/**
 * Un bloque de UNA linea horizontal puede crecer a lo ancho: se ensancha su
 * caja hasta el siguiente bloque de la misma linea (o el margen de la pagina)
 * segun la alineacion, para que una palabra mas larga no se parta ni baje a
 * pisar la linea siguiente. Devuelve la caja crecida y los bloques que el
 * texto podria llegar a pisar (se avisan al exportar si los invade).
 */
function growSingleLine(
  block: TextBlock,
  box: UserBox,
  layout: PageLayout,
  lineHeight: number,
): { box: UserBox; obstacles: Array<{ id: string; box: UserBox }> } {
  const others = layout.neighbors.filter((other) => other.id !== block.id);
  const band = others.filter(
    (other) => verticalOverlap(box, other.box) > 0.3 * Math.min(box.height, other.box.height),
  );
  const boxRight = box.x + box.width;
  let right = layout.pageBox.x + layout.pageBox.width - GROW_PAGE_MARGIN_PT;
  let left = layout.pageBox.x + GROW_PAGE_MARGIN_PT;
  for (const other of band) {
    if (other.box.x >= boxRight - 1) right = Math.min(right, other.box.x - GROW_NEIGHBOR_GAP_PT);
    else if (other.box.x + other.box.width <= box.x + 1) {
      left = Math.max(left, other.box.x + other.box.width + GROW_NEIGHBOR_GAP_PT);
    }
  }
  right = Math.max(right, boxRight);
  left = Math.min(left, box.x);

  let grown = box;
  if (block.align === "right") grown = { ...box, x: left, width: boxRight - left };
  else if (block.align === "center") {
    const center = box.x + box.width / 2;
    const half = Math.max(box.width / 2, Math.min(center - left, right - center));
    grown = { ...box, x: center - half, width: half * 2 };
  } else grown = { ...box, width: right - box.x };

  // Bloques que el texto podria pisar si crece de ancho o se parte hacia abajo.
  const reach: UserBox = {
    x: layout.pageBox.x,
    width: layout.pageBox.width,
    y: box.y - OBSTACLE_LINES_BELOW * lineHeight * block.fontSize,
    height: box.height + OBSTACLE_LINES_BELOW * lineHeight * block.fontSize + block.fontSize,
  };
  const obstacles = others
    .filter((other) => other.box.width > 0 && other.box.height > 0 && verticalOverlap(reach, other.box) > 0)
    .map((other) => ({
      id: other.id,
      box: { ...other.box },
      distance: Math.hypot(
        other.box.x + other.box.width / 2 - (box.x + box.width / 2),
        other.box.y + other.box.height / 2 - (box.y + box.height / 2),
      ),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, MAX_OBSTACLES)
    .map(({ id, box: obstacleBox }) => ({ id, box: obstacleBox }));
  return { box: grown, obstacles };
}

/**
 * Edicion que REEMPLAZA a `block`: cubre su caja original y redibuja con la
 * fuente del catalogo mas parecida. Ajustes para que lo redibujado caiga donde
 * estaba lo original:
 *  - el borde superior de la caja se coloca para que la primera linea base que
 *    dibuja el exportador sea la del original (solo texto horizontal);
 *  - se da un 2 % de holgura de ancho (respetando la alineacion) para que una
 *    metrica de fuente ligeramente distinta no parta la linea mas larga.
 */
export function draftEditForBlock(
  block: TextBlock,
  options: {
    coverColor: string | null;
    /** `false`: el fondo muestreado no es liso; queda anotado en la cobertura (aviso al exportar). */
    coverUniform?: boolean;
    /**
     * Pagina y bloques vecinos. Con ella, un bloque de UNA linea crece de ancho
     * hasta el vecino o el margen (no parte palabras) y la edicion anota los
     * vecinos que podria pisar. Sin ella conserva el ancho original.
     */
    layout?: PageLayout;
    /** Franjas de borde fino halladas al muestrear el fondo: la cobertura no las pisa. */
    coverClip?: readonly UserBox[];
    id?: string;
    overrides?: Partial<TextEdit>;
  },
): TextEdit {
  const mapped = mapSourceFont(block.font);
  const style = sourceFontStyle(block.font);
  const base = blockToTextEdit(block, {
    id: options.id,
    neighbors: options.layout?.neighbors.filter((other) => other.id !== block.id),
    clip: options.coverClip,
    fontKey: mapped.key,
    cover: {
      color: options.coverColor,
      padding: COVER_PADDING_PT,
      ...(options.coverUniform === false && options.coverColor !== null ? { uniform: false as const } : {}),
    },
  });
  const lineHeight =
    block.lineHeight !== undefined && block.lineHeight > 0 && block.lineHeight <= 10
      ? block.lineHeight
      : undefined;
  let box = { ...block.box };
  const upright = ((block.rotation % 360) + 360) % 360 === 0;
  const slack = Math.max(1, box.width * 0.02);
  if (block.align === "right") box = { ...box, x: box.x - slack, width: box.width + slack };
  else if (block.align === "center") {
    box = { ...box, x: box.x - slack / 2, width: box.width + slack };
  } else box = { ...box, width: box.width + slack };
  const first = block.lines[0];
  if (upright && first) {
    // La primera linea base de lo redibujado debe caer en la de lo original.
    const lh = lineHeight ?? DEFAULT_LINE_HEIGHT;
    const top = first.baseline + exportBaselineFromTop(mapped.key, lh) * block.fontSize;
    const height = top - box.y;
    if (height > 1) box = { ...box, height };
  } else if (!upright) {
    box = rotatedBox(block, mapped.key, lineHeight ?? DEFAULT_LINE_HEIGHT) ?? box;
  }
  let obstacles: Array<{ id: string; box: UserBox }> | undefined;
  if (options.layout && upright && block.lines.length <= 1 && !block.script) {
    const grown = growSingleLine(block, box, options.layout, lineHeight ?? DEFAULT_LINE_HEIGHT);
    box = grown.box;
    obstacles = grown.obstacles;
  } else if (options.layout) {
    // Sin crecer: solo los vecinos pegados (la cobertura no los tapa; el texto nuevo los avisa).
    const reach = Math.max(NEAR_NEIGHBOR_PT, block.fontSize * 1.5);
    const near: UserBox = {
      x: block.box.x - reach,
      y: block.box.y - reach,
      width: block.box.width + reach * 2,
      height: block.box.height + reach * 2,
    };
    obstacles = options.layout.neighbors
      .filter((other) => other.id !== block.id && boxesIntersect(near, other.box))
      .slice(0, MAX_OBSTACLES)
      .map((other) => ({ id: other.id, box: { ...other.box } }));
  }
  return {
    ...base,
    box,
    ...(obstacles && obstacles.length > 0 ? { obstacles } : {}),
    bold: style.bold,
    italic: style.italic,
    sourceFont: block.font,
    ...(lineHeight !== undefined ? { lineHeight } : {}),
    ...options.overrides,
  };
}

/** Texto por defecto de un bloque nuevo (herramienta «Anadir texto»). */
export function newTextEditAt(
  metrics: PageMetrics,
  pageIndex: number,
  rect: PxRect,
  id: string,
): TextEdit {
  return {
    id,
    pageIndex,
    box: pxRectToUserBox(metrics, rect),
    text: "",
    fontSize: NEW_TEXT_FONT_SIZE,
    color: "#000000",
    align: "left",
    fontKey: "helvetica",
    bold: false,
    italic: false,
    // En una pagina con /Rotate el texto debe verse recto en la vista.
    rotation: metrics.geometry.rotation,
    cover: { color: null, padding: 0 },
  };
}

/* ------------------------------------------------------------------ *
 * Muestreo del fondo sobre el canvas ya renderizado
 * ------------------------------------------------------------------ */

type PixelSource = {
  getImageData: (
    x: number,
    y: number,
    width: number,
    height: number,
  ) => { data: ArrayLike<number>; width: number; height: number };
};

// Ventana de lectura: el anillo (3 px) mas las filas extra con las que se reconocen lineas finas.
const SAMPLE_MARGIN_PX = 9;

/**
 * Muestrea el color de fondo alrededor de `box` (px del CANVAS, no CSS) leyendo
 * solo una ventana pequena. `null` si el canvas no se puede leer.
 */
export function sampleCanvasBackground(
  context: PixelSource | null,
  canvasSize: { width: number; height: number },
  box: { x: number; y: number; width: number; height: number },
  /** (W5-U5) Cuadrilatero girado a cubrir (esquinas en px del canvas): el anillo se toma pegado a el. */
  polygon?: ReadonlyArray<{ x: number; y: number }>,
  /** Cajas (px del CANVAS) de otros bloques de texto: su tinta no cuenta como fondo. */
  ignore: ReadonlyArray<{ x: number; y: number; width: number; height: number }> = [],
  options: {
    /**
     * Pixeles de canvas por punto PDF. Con el, anillo, busqueda de lineas y grosor
     * maximo se miden en puntos: MISMA decision a cualquier zoom (100/150/200/300 %).
     */
    pxPerPt?: number;
    /** Caja (px del canvas) del texto original, dentro de `box`: se revisa por si tiene una linea. */
    inner?: { x: number; y: number; width: number; height: number };
  } = {},
): BackgroundSample | null {
  if (!context) return null;
  const ppp = options.pxPerPt !== undefined && options.pxPerPt > 0 ? options.pxPerPt : null;
  const margin = ppp ? Math.ceil(SCAN_PT * ppp) + 2 : SAMPLE_MARGIN_PX;
  // El ruido de coma flotante (89,99999) no debe mover la ventana un pixel.
  const eps = 1e-6;
  const x0 = Math.max(0, Math.floor(box.x + eps) - margin);
  const y0 = Math.max(0, Math.floor(box.y + eps) - margin);
  const x1 = Math.min(canvasSize.width, Math.ceil(box.x + box.width - eps) + margin);
  const y1 = Math.min(canvasSize.height, Math.ceil(box.y + box.height - eps) + margin);
  if (x1 <= x0 || y1 <= y0) return null;
  try {
    const image = context.getImageData(x0, y0, x1 - x0, y1 - y0);
    const sample = sampleBackgroundColor(
      image,
      {
        x: box.x - x0,
        y: box.y - y0,
        width: box.width,
        height: box.height,
      },
      {
        ...(ppp ? { pxPerPt: ppp } : {}),
        ...(options.inner
          ? { inner: { ...options.inner, x: options.inner.x - x0, y: options.inner.y - y0 } }
          : {}),
        ...(polygon ? { polygon: polygon.map((p) => ({ x: p.x - x0, y: p.y - y0 })) } : {}),
        ...(ignore.length > 0
          ? { ignore: ignore.map((b) => ({ ...b, x: b.x - x0, y: b.y - y0 })) }
          : {}),
      },
    );
    // Las franjas de linea vuelven a pixeles del canvas.
    return sample.lines
      ? { ...sample, lines: sample.lines.map((l) => ({ ...l, x: l.x + x0, y: l.y + y0 })) }
      : sample;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Texto de un campo editable
 * ------------------------------------------------------------------ */

/**
 * Texto plano de un contenteditable. Tolera los dos modos del navegador
 * (`plaintext-only`, con "\n" en el texto; o el clasico, con <br> y <div>) y
 * convierte espacios duros en espacios normales.
 */
export function readEditableText(root: Node): string {
  let out = "";
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += (child as Text).data.replace(/ /g, " ").replace(/​/g, "");
      } else if (child.nodeType === 1) {
        const element = child as Element;
        if (element.tagName === "BR") {
          out += "\n";
          return;
        }
        const block = element.tagName === "DIV" || element.tagName === "P";
        if (block && out.length > 0 && !out.endsWith("\n")) out += "\n";
        walk(element);
      }
    });
  };
  walk(root);
  const text = out.replace(/\r\n?/g, "\n");
  // Al final, el navegador deja un salto de linea CENTINELA (Chrome en `plaintext-only`, el <br> de
  // Firefox) para poder pintar y colocar el cursor en una ultima linea vacia: no es del texto.
  return text.endsWith("\n") ? text.slice(0, -1) : text;
}

/** Siguiente clave a enfocar al quitar `key` de una lista ordenada (la siguiente, si no la anterior). */
export function nextFocusKey(keys: readonly string[], removed: string): string | null {
  const index = keys.indexOf(removed);
  if (index < 0) return keys[0] ?? null;
  return keys[index + 1] ?? keys[index - 1] ?? null;
}

/** Recorta un texto para anunciarlo («Bloque 3 de 12: texto…»). */
export function excerpt(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/**
 * Franjas de borde fino (px del CANVAS, las de `BackgroundSample.lines`) -> cajas de
 * usuario, con `clearancePt` de holgura por todos lados: es lo que la cobertura no
 * puede pisar (`TextEdit.coverClip`). `canvasPerCss` = px de canvas por px CSS.
 */
export function lineStripsToUserBoxes(
  metrics: PageMetrics,
  lines: ReadonlyArray<{ x: number; y: number; width: number; height: number }>,
  canvasPerCss: number,
  pxPerPt: number,
  clearancePt = 0.5,
): UserBox[] {
  const clearance = clearancePt * pxPerPt;
  return lines.map((line) =>
    pxRectToUserBox(metrics, {
      left: (line.x - clearance) / canvasPerCss,
      top: (line.y - clearance) / canvasPerCss,
      width: (line.width + clearance * 2) / canvasPerCss,
      height: (line.height + clearance * 2) / canvasPerCss,
    }),
  );
}
