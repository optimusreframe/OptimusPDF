/**
 * Recorrido de la lista de operadores de pdf.js (`page.getOperatorList()`) para encontrar CADA vez que se pinta una
 * imagen, con la matriz que la coloca en la pagina. Misma tecnica que `imageCoverage` (`pageTextKind.ts`): `cm`
 * (`transform`), `q`/`Q` (`save`/`restore`) y los Form XObjects (`paintFormXObjectBegin`/`End`, que equivalen a
 * save + transform(matriz del formulario) y restore). Puro: no toca pdf.js ni el DOM, solo arreglos y numeros.
 *
 * Operadores que pintan imagenes en pdf.js 6 (lo que hay que cubrir para no perder ninguna):
 *  - `paintImageXObject [objId, w, h]` y `paintInlineImageXObject [imgData]`.
 *  - `paintImageMaskXObject [{ data: objId, width, height }]` (mascara de 1 bit: se pinta con el color de relleno).
 *  - El optimizador de pdf.js FUSIONA secuencias `q cm Do Q` consecutivas: `paintImageXObjectRepeat` (la MISMA imagen ≥ 3
 *    veces), `paintImageMaskXObjectRepeat` / `paintImageMaskXObjectGroup` (≥ 10 mascaras) y `paintInlineImageXObjectGroup`
 *    (≥ 10 imagenes en linea, pegadas en un atlas). Un mosaico de miniaturas llega asi: hay que desplegarlas.
 *
 * Con las anotaciones activadas (`getOperatorList({ annotationMode: 1 })`) la lista trae `beginAnnotation`/`endAnnotation`
 * alrededor de la apariencia de cada anotacion: dentro, la CTM parte de la identidad de la pagina y se le aplican la
 * transformacion y la matriz de la anotacion (`[id, rect, transform, matrix]`).
 *
 * Se ignoran, a proposito: `paintSolidColorImageMask` (un pixel solido: es un relleno, no una imagen) y las imagenes de
 * patrones de mosaico y de glifos Type3 (no estan en la lista de la pagina).
 */

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m x n` con matrices de pdf.js (`[a, b, c, d, e, f]`): aplica primero `n` y despues `m`... igual que `ctm = ctm · cm`. */
export function multiplyMatrix(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

/** Subconjunto de `OPS` de pdf.js que usa el recorrido (los de grupo/repeticion pueden faltar en versiones antiguas). */
export type ImageOpNumbers = {
  save: number;
  restore: number;
  transform: number;
  paintFormXObjectBegin: number;
  paintFormXObjectEnd: number;
  paintImageXObject: number;
  paintInlineImageXObject: number;
  paintImageMaskXObject: number;
  paintImageXObjectRepeat?: number;
  paintInlineImageXObjectGroup?: number;
  paintImageMaskXObjectGroup?: number;
  paintImageMaskXObjectRepeat?: number;
  setFillRGBColor?: number;
  beginAnnotation?: number;
  endAnnotation?: number;
};

export type ImagePaintKind = "xobject" | "inline" | "mask";

/** Una pintura de imagen: donde (matriz) y que objeto. */
export type ImagePaintEvent = {
  /** Indice del operador en `fnArray`. Junto con `entry` identifica la pintura de forma estable para el mismo documento. */
  opIndex: number;
  /** Posicion dentro de un grupo o repeticion (0 en una pintura simple). */
  entry: number;
  kind: ImagePaintKind;
  /** Id del objeto de pdf.js (`img_p0_3`, `mask_...`) de un XObject o una mascara; `null` en una imagen en linea. */
  objId: string | null;
  /** Datos de una imagen en linea (simple o el atlas de un grupo); `null` en el resto. */
  inline: unknown;
  /** Solo en un grupo de imagenes en linea: la casilla de esta imagen dentro del atlas. */
  atlas: { x: number; y: number; w: number; h: number } | null;
  /** Medidas declaradas por el operador (XObject: `[objId, w, h]`; mascara: `{ width, height }`). */
  width: number | null;
  height: number | null;
  /** CTM completa: lleva el cuadrado unidad de la imagen al espacio de usuario de la pagina. */
  matrix: Matrix;
  /** Color de relleno vigente (RGB 0..255): las mascaras se pintan con el. */
  fill: [number, number, number];
  /** `true` si se pinta dentro de un Form XObject. */
  inForm: boolean;
  /** `true` si se pinta dentro de la apariencia de una anotacion (solo con las anotaciones activadas). */
  inAnnotation: boolean;
};

type StackEntry = { matrix: Matrix; fill: [number, number, number] };

function isMatrix(value: unknown): value is ArrayLike<number> {
  if (!value || typeof value !== "object" || !("length" in value)) return false;
  const array = value as ArrayLike<number>;
  if (array.length < 6) return false;
  for (let i = 0; i < 6; i += 1) if (!Number.isFinite(array[i])) return false;
  return true;
}

function toMatrix(value: ArrayLike<number>): Matrix {
  return [value[0], value[1], value[2], value[3], value[4], value[5]];
}

/** `#rrggbb` o `[r, g, b]` (0..255) -> RGB; `null` si no se entiende. */
export function parseFillColor(value: unknown): [number, number, number] | null {
  if (typeof value === "string") {
    const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
    if (!match) return null;
    const n = parseInt(match[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  if (value && typeof value === "object" && "length" in value && (value as ArrayLike<number>).length >= 3) {
    const array = value as ArrayLike<number>;
    const out = [array[0], array[1], array[2]];
    if (out.every((v) => Number.isFinite(v))) return out.map((v) => Math.max(0, Math.min(255, Math.round(v)))) as [number, number, number];
  }
  return null;
}

function firstArg(args: unknown): unknown {
  return Array.isArray(args) ? args[0] : args && typeof args === "object" && "0" in (args as object) ? (args as ArrayLike<unknown>)[0] : undefined;
}

/**
 * Todas las pinturas de imagen de una pagina, en orden de aparicion. `max` limita cuantas se devuelven (una pagina
 * con decenas de miles de repeticiones no debe agotar la memoria): al llegar, se detiene y marca `truncated`.
 */
export function walkImagePaints(
  fnArray: ArrayLike<number>,
  argsArray: ArrayLike<unknown>,
  ops: ImageOpNumbers,
  max = 5000,
): { events: ImagePaintEvent[]; truncated: boolean } {
  const events: ImagePaintEvent[] = [];
  const stack: StackEntry[] = [];
  let matrix: Matrix = IDENTITY;
  let fill: [number, number, number] = [0, 0, 0];
  let formDepth = 0;
  let inAnnotation = false;
  let truncated = false;

  const push = (event: Omit<ImagePaintEvent, "inForm" | "inAnnotation">): boolean => {
    if (events.length >= max) {
      truncated = true;
      return false;
    }
    events.push({ ...event, inForm: formDepth > 0, inAnnotation });
    return true;
  };

  for (let index = 0; index < fnArray.length; index += 1) {
    const op = fnArray[index];
    const args = argsArray[index];

    if (op === ops.save) {
      stack.push({ matrix, fill });
    } else if (op === ops.restore) {
      const top = stack.pop();
      matrix = top?.matrix ?? IDENTITY;
      fill = top?.fill ?? [0, 0, 0];
    } else if (op === ops.transform) {
      if (isMatrix(args)) matrix = multiplyMatrix(matrix, toMatrix(args));
    } else if (op === ops.paintFormXObjectBegin) {
      stack.push({ matrix, fill });
      formDepth += 1;
      const formMatrix = Array.isArray(args) ? args[0] : undefined;
      if (isMatrix(formMatrix)) matrix = multiplyMatrix(matrix, toMatrix(formMatrix));
    } else if (op === ops.paintFormXObjectEnd) {
      const top = stack.pop();
      matrix = top?.matrix ?? IDENTITY;
      fill = top?.fill ?? [0, 0, 0];
      formDepth = Math.max(0, formDepth - 1);
    } else if (ops.beginAnnotation !== undefined && op === ops.beginAnnotation) {
      // La anotacion se pinta desde el estado base de la pagina, no desde donde estuviera el contenido.
      stack.length = 0;
      formDepth = 0;
      matrix = IDENTITY;
      fill = [0, 0, 0];
      const list = Array.isArray(args) ? args : [];
      if (isMatrix(list[2])) matrix = multiplyMatrix(matrix, toMatrix(list[2]));
      if (isMatrix(list[3])) matrix = multiplyMatrix(matrix, toMatrix(list[3]));
      inAnnotation = true;
    } else if (ops.endAnnotation !== undefined && op === ops.endAnnotation) {
      stack.length = 0;
      formDepth = 0;
      matrix = IDENTITY;
      fill = [0, 0, 0];
      inAnnotation = false;
    } else if (ops.setFillRGBColor !== undefined && op === ops.setFillRGBColor) {
      fill = parseFillColor(firstArg(args)) ?? parseFillColor(args) ?? fill;
    } else if (op === ops.paintImageXObject) {
      const list = args as unknown[] | undefined;
      const objId = typeof list?.[0] === "string" ? list[0] : null;
      if (objId === null) continue;
      if (!push({ opIndex: index, entry: 0, kind: "xobject", objId, inline: null, atlas: null, width: numberOrNull(list?.[1]), height: numberOrNull(list?.[2]), matrix, fill })) break;
    } else if (op === ops.paintInlineImageXObject) {
      const data = firstArg(args);
      if (!data || typeof data !== "object") continue;
      const dims = data as { width?: number; height?: number };
      if (!push({ opIndex: index, entry: 0, kind: "inline", objId: null, inline: data, atlas: null, width: numberOrNull(dims.width), height: numberOrNull(dims.height), matrix, fill })) break;
    } else if (op === ops.paintImageMaskXObject) {
      const mask = firstArg(args) as { data?: unknown; width?: number; height?: number } | undefined;
      if (!mask || typeof mask.data !== "string") continue;
      if (!push({ opIndex: index, entry: 0, kind: "mask", objId: mask.data, inline: null, atlas: null, width: numberOrNull(mask.width), height: numberOrNull(mask.height), matrix, fill })) break;
    } else if (ops.paintImageXObjectRepeat !== undefined && op === ops.paintImageXObjectRepeat) {
      // [objId, scaleX, scaleY, positions[x0, y0, x1, y1, ...]]
      const list = args as unknown[] | undefined;
      const objId = typeof list?.[0] === "string" ? list[0] : null;
      const scaleX = Number(list?.[1]);
      const scaleY = Number(list?.[2]);
      const positions = list?.[3] as ArrayLike<number> | undefined;
      if (objId === null || !positions || !Number.isFinite(scaleX) || !Number.isFinite(scaleY)) continue;
      let ok = true;
      for (let k = 0; k + 1 < positions.length && ok; k += 2) {
        ok = push({ opIndex: index, entry: k / 2, kind: "xobject", objId, inline: null, atlas: null, width: null, height: null, matrix: multiplyMatrix(matrix, [scaleX, 0, 0, scaleY, positions[k], positions[k + 1]]), fill });
      }
      if (!ok) break;
    } else if (ops.paintImageMaskXObjectRepeat !== undefined && op === ops.paintImageMaskXObjectRepeat) {
      // [img, scaleX, skewX, skewY, scaleY, positions]
      const list = args as unknown[] | undefined;
      const mask = list?.[0] as { data?: unknown; width?: number; height?: number } | undefined;
      const scale = [Number(list?.[1]), Number(list?.[2]), Number(list?.[3]), Number(list?.[4])];
      const positions = list?.[5] as ArrayLike<number> | undefined;
      if (!mask || typeof mask.data !== "string" || !positions || scale.some((v) => !Number.isFinite(v))) continue;
      let ok = true;
      for (let k = 0; k + 1 < positions.length && ok; k += 2) {
        ok = push({ opIndex: index, entry: k / 2, kind: "mask", objId: mask.data, inline: null, atlas: null, width: numberOrNull(mask.width), height: numberOrNull(mask.height), matrix: multiplyMatrix(matrix, [scale[0], scale[1], scale[2], scale[3], positions[k], positions[k + 1]]), fill });
      }
      if (!ok) break;
    } else if (ops.paintImageMaskXObjectGroup !== undefined && op === ops.paintImageMaskXObjectGroup) {
      // [images: { data: objId, width, height, transform }[]]
      const images = firstArg(args) as Array<{ data?: unknown; width?: number; height?: number; transform?: unknown }> | undefined;
      if (!Array.isArray(images)) continue;
      let ok = true;
      for (let k = 0; k < images.length && ok; k += 1) {
        const image = images[k];
        if (typeof image?.data !== "string" || !isMatrix(image.transform)) continue;
        ok = push({ opIndex: index, entry: k, kind: "mask", objId: image.data, inline: null, atlas: null, width: numberOrNull(image.width), height: numberOrNull(image.height), matrix: multiplyMatrix(matrix, toMatrix(image.transform)), fill });
      }
      if (!ok) break;
    } else if (ops.paintInlineImageXObjectGroup !== undefined && op === ops.paintInlineImageXObjectGroup) {
      // [atlas, map: { transform, x, y, w, h }[]]
      const list = args as unknown[] | undefined;
      const atlas = list?.[0];
      const map = list?.[1] as Array<{ transform?: unknown; x: number; y: number; w: number; h: number }> | undefined;
      if (!atlas || typeof atlas !== "object" || !Array.isArray(map)) continue;
      let ok = true;
      for (let k = 0; k < map.length && ok; k += 1) {
        const entry = map[k];
        if (!isMatrix(entry.transform)) continue;
        ok = push({ opIndex: index, entry: k, kind: "inline", objId: null, inline: atlas, atlas: { x: entry.x, y: entry.y, w: entry.w, h: entry.h }, width: entry.w, height: entry.h, matrix: multiplyMatrix(matrix, toMatrix(entry.transform)), fill });
      }
      if (!ok) break;
    }
  }
  return { events, truncated };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ *
 * Geometria sobre la pagina
 * ------------------------------------------------------------------ */

/** Transformacion del visor de pdf.js (`viewport.transform`): espacio de usuario -> pixeles CSS con origen arriba-izquierda. */
export type ViewTransform = {
  transform: ArrayLike<number>;
  width: number;
  height: number;
};

/**
 * Caja normalizada (0..1, origen arriba a la izquierda) que ocupa una imagen colocada con `matrix`: el cuadrado unidad
 * llevado a la pagina, su envolvente alineada con los ejes (una imagen girada ocupa la caja que la contiene).
 */
export function imageRect(matrix: Matrix, view: ViewTransform): { x: number; y: number; width: number; height: number } {
  const t = view.transform;
  const toView = (x: number, y: number): [number, number] => {
    const ux = matrix[0] * x + matrix[2] * y + matrix[4];
    const uy = matrix[1] * x + matrix[3] * y + matrix[5];
    return [t[0] * ux + t[2] * uy + t[4], t[1] * ux + t[3] * uy + t[5]];
  };
  const corners = [toView(0, 0), toView(1, 0), toView(0, 1), toView(1, 1)];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  const width = view.width > 0 ? view.width : 1;
  const height = view.height > 0 ? view.height : 1;
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const x0 = clamp(Math.min(...xs) / width);
  const x1 = clamp(Math.max(...xs) / width);
  const y0 = clamp(Math.min(...ys) / height);
  const y1 = clamp(Math.max(...ys) / height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Fraccion (0..1) de la pagina cubierta por la UNION de las cajas (cuadricula de `grid` x `grid` celdas). */
export function unionCoverage(rects: Array<{ x: number; y: number; width: number; height: number }>, grid = 100): number {
  if (rects.length === 0) return 0;
  const covered = new Uint8Array(grid * grid);
  for (const rect of rects) {
    // Una celda cuenta como cubierta si su CENTRO cae dentro de la caja.
    const gx0 = Math.max(0, Math.ceil(rect.x * grid - 0.5));
    const gx1 = Math.min(grid - 1, Math.floor((rect.x + rect.width) * grid - 0.5));
    const gy0 = Math.max(0, Math.ceil(rect.y * grid - 0.5));
    const gy1 = Math.min(grid - 1, Math.floor((rect.y + rect.height) * grid - 0.5));
    for (let gy = gy0; gy <= gy1; gy += 1) for (let gx = gx0; gx <= gx1; gx += 1) covered[gy * grid + gx] = 1;
  }
  let count = 0;
  for (let i = 0; i < covered.length; i += 1) count += covered[i];
  return count / covered.length;
}

/** Interseccion sobre union de dos cajas normalizadas. */
export function iou(a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width);
  const y1 = Math.min(a.y + a.height, b.y + b.height);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}
